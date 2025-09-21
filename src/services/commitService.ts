import * as vscode from "vscode";
import { SidebarProvider } from "../sidebar/SidebarProvider";
import {
	getGitStagedDiff,
	getGitStagedFiles,
	getGitFileContentFromIndex,
	getGitFileContentFromHead,
	stageAllChanges,
} from "../sidebar/services/gitService";
import { ERROR_OPERATION_CANCELLED } from "../ai/gemini";
import { ChildProcess } from "child_process";
import { generateFileChangeSummary } from "../utils/diffingUtils";
import { DEFAULT_FLASH_LITE_MODEL } from "../sidebar/common/sidebarConstants";
import { executeCommand } from "../utils/commandExecution";
import { Logger } from "../utils/logger"; // Import Logger

export class CommitService {
	private minovativeMindTerminal: vscode.Terminal | undefined;
	private logger: Logger; // Add logger property

	constructor(private provider: SidebarProvider) {
		this.logger = new Logger("CommitService"); // Initialize logger
	}

	/**
	 * Handles the /commit command by staging changes, generating a commit message via AI,
	 * and presenting it for user review. Integrates cancellation.
	 * @param token A CancellationToken to observe cancellation requests.
	 */
	public async handleCommitCommand(
		token: vscode.CancellationToken
	): Promise<void> {
		const { settingsManager } = this.provider;
		const modelName = DEFAULT_FLASH_LITE_MODEL;

		let success = false;
		let errorMessage: string | null = null;
		let operationId: string | null = null;

		try {
			operationId = this.provider.currentActiveChatOperationId;

			if (token.isCancellationRequested) {
				throw new Error(ERROR_OPERATION_CANCELLED);
			}

			this.provider.postMessageToWebview({
				type: "aiResponseStart",
				value: {
					modelName,
					relevantFiles: [] as string[],
					operationId: operationId!,
				},
			});
			this.provider.chatHistoryManager.addHistoryEntry("user", "/commit");

			const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			if (!rootPath) {
				this.logger.error(
					undefined,
					"No workspace folder open for git command."
				);
				throw new Error("No workspace folder open for git.");
			}

			const onProcessCallback = (process: ChildProcess) => {
				this.logger.log(
					undefined,
					`Git process started: PID ${process.pid}, Command: 'git add .'`
				);
			};

			const onOutputCallback = (
				type: "stdout" | "stderr" | "status",
				data: string,
				isError?: boolean
			) => {
				this.provider.postMessageToWebview({
					type: "gitProcessUpdate",
					value: { type, data, isError },
				});

				if (type === "stderr" || isError) {
					this.provider.chatHistoryManager.addHistoryEntry(
						"model",
						`Git Staging Error: ${data}`
					);
					this.logger.error(undefined, `Git Staging Error: ${data}`);
				} else if (type === "stdout") {
					this.logger.log(undefined, `Git stdout: ${data}`);
				}
			};

			await stageAllChanges(
				rootPath,
				token,
				onProcessCallback,
				onOutputCallback
			);
			if (token.isCancellationRequested) {
				throw new Error(ERROR_OPERATION_CANCELLED);
			}

			const diff = await getGitStagedDiff(rootPath);
			const stagedFiles = await getGitStagedFiles(rootPath);

			if (!diff || diff.trim() === "") {
				success = true;
				errorMessage = "No changes staged to commit.";
				return;
			}

			const fileSummaries: string[] = [];
			for (const filePath of stagedFiles) {
				if (token.isCancellationRequested) {
					throw new Error(ERROR_OPERATION_CANCELLED);
				}
				const oldContent = await getGitFileContentFromHead(rootPath, filePath);
				const newContent = await getGitFileContentFromIndex(rootPath, filePath);
				const { summary } = await generateFileChangeSummary(
					oldContent,
					newContent,
					filePath
				);
				fileSummaries.push(summary);
			}

			const detailedSummaries =
				fileSummaries.length > 0
					? "Summary of File Changes:\n" +
					  fileSummaries.map((s) => `- ${s}`).join("\n") +
					  "\n\n"
					: "";

			const commitMessagePrompt = `
You are an expert Git author. Produce one commit message only — nothing else, no commentary, no headings, no code fences.

FORMAT REQUIREMENTS (strict):
1) First non-empty line = SUBJECT (imperative mood, e.g., "feat: Added feature X", "fix: Fixed bug Y", etc...).
   - SUBJECT must NOT begin with '-', '*', or any punctuation that could look like a CLI flag.
   - SUBJECT must be <= 72 characters (50 chars recommended). If longer, shorten to <=72.
2) OPTIONAL: blank line, then BODY. Wrap lines at ~72 chars. Body may include short markdown-style lists for clarity but do not use code fences.
3) DO NOT USE double quotes (\\"), backticks (\`), or backslashes (\\). Replace them with plain text. Do not include shell-like constructs such as $(), &&, ||, or ';'.
4) Output only the commit message text (subject and optional body). Do not prepend "Commit Message:" or any metadata.

Context (file-level summaries follow). Use them to craft a concise, accurate subject and an optional explanatory body.
${detailedSummaries}
Overall Staged Diff:
\`\`\`diff
${diff}
\`\`\`
`;

			let commitMessage =
				await this.provider.aiRequestService.generateWithRetry(
					[{ text: commitMessagePrompt }],
					modelName,
					undefined,
					"commit message generation",
					undefined,
					undefined,
					token
				);

			if (token.isCancellationRequested) {
				throw new Error(ERROR_OPERATION_CANCELLED);
			}

			const validatedMessage =
				this._validateAndSanitizeCommitMessage(commitMessage);

			const trimmedCommitMessage = validatedMessage.trim();
			if (
				trimmedCommitMessage.toLowerCase().startsWith("error:") ||
				trimmedCommitMessage === ""
			) {
				this.logger.error(
					undefined,
					`AI generated an invalid or error-prefixed commit message: "${commitMessage}"`
				);
				const userFacingError = `AI failed to generate a valid commit message. Received: "${trimmedCommitMessage.substring(
					0,
					150
				)}${
					trimmedCommitMessage.length > 150 ? "..." : ""
				}". Please try again or provide more context.`;
				throw new Error(userFacingError);
			}

			this.provider.chatHistoryManager.addHistoryEntry(
				"model",
				validatedMessage
			);

			this.provider.pendingCommitReviewData = {
				commitMessage: validatedMessage,
				stagedFiles,
				fileChangeSummaries: fileSummaries,
			};
			success = true;
		} catch (error: any) {
			errorMessage = error.message;
			success = false;
		} finally {
			const isCancellation = errorMessage === ERROR_OPERATION_CANCELLED;
			const isCommitReviewPending =
				success && !!this.provider.pendingCommitReviewData;

			this.provider.postMessageToWebview({
				type: "aiResponseEnd",
				success: isCommitReviewPending,
				error: isCancellation
					? "Commit operation cancelled."
					: isCommitReviewPending
					? null
					: errorMessage,
				isCommitReviewPending: isCommitReviewPending,
				commitReviewData: isCommitReviewPending
					? this.provider.pendingCommitReviewData
					: undefined,
				statusMessageOverride:
					success && errorMessage === "No changes staged to commit."
						? errorMessage
						: undefined,
				operationId: operationId!,
			});
			this.provider.isGeneratingUserRequest = false;

			if (isCancellation) {
				this.provider.postMessageToWebview({ type: "reenableInput" });
			}

			this.provider.clearActiveOperationState();
			this.provider.chatHistoryManager.restoreChatHistoryToWebview();
		}
	}

	/**
	 * Removes ASCII control characters (except newline and tab) from the message.
	 * @param message The raw commit message.
	 * @returns The message with control characters removed.
	 */
	private _removeControlCharacters(message: string): string {
		return message.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, "");
	}

	/**
	 * Normalizes newline characters to `\n`.
	 * @param message The commit message.
	 * @returns The message with normalized newlines.
	 */
	private _normalizeNewlines(message: string): string {
		return message.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	}

	/**
	 * Strips smart quotes, backticks, and backslashes from the message.
	 * @param message The commit message.
	 * @returns The message with quotes and backslashes removed.
	 */
	private _stripQuotesAndBackslashes(message: string): string {
		let sanitized = message.replace(/[`"'“”‘’]/g, "");
		sanitized = sanitized.replace(/\\+/g, "");
		return sanitized;
	}

	/**
	 * Trims trailing spaces on each line and collapses excessive blank lines.
	 * @param message The commit message.
	 * @returns The message with trimmed lines and collapsed blank lines.
	 */
	private _trimLinesAndCollapseBlankLines(message: string): string {
		return message
			.split("\n")
			.map((l) => l.replace(/[ \t]+$/g, "")) // rtrim
			.join("\n")
			.replace(/\n{3,}/g, "\n\n")
			.trim();
	}

	/**
	 * Removes common leading list markers (like '-' or '*') from the first non-empty line.
	 * @param message The commit message.
	 * @returns The message with leading list markers removed if present.
	 */
	private _removeLeadingListMarkers(message: string): string {
		return message.replace(/^\s*[-*]\s+/, "");
	}

	/**
	 * Checks for shell-like injection patterns and throws an error if found.
	 * @param message The commit message.
	 * @throws An error if injection patterns are detected.
	 */
	private _checkInjectionPatterns(message: string): void {
		const injectionPatterns = /\$\(|`|&&|\|\||;/;
		if (injectionPatterns.test(message)) {
			throw new Error(
				"Commit message contains characters or patterns that resemble shell commands (e.g. $(), &&, ||, `, ;). For security, please edit the message without these constructs."
			);
		}
	}

	/**
	 * Checks for Git exploit patterns (e.g., attempts to manipulate Git config/hooks) and throws an error if found.
	 * @param message The commit message.
	 * @throws An error if Git exploit patterns are detected.
	 */
	private _checkGitExploitPatterns(message: string): void {
		const gitExploitPatterns = /\[(?:core|hooks|alias)\].*=/i;
		if (gitExploitPatterns.test(message)) {
			throw new Error(
				"Commit message appears to include Git configuration-style content, which is not allowed."
			);
		}
	}

	/**
	 * Validates the format of the subject line (first line) of the commit message.
	 * Throws an error if the subject is empty or starts with disallowed characters.
	 * @param message The commit message.
	 * @throws An error if the subject line format is invalid.
	 */
	private _validateSubjectLineFormat(message: string): void {
		const firstLine = message.split("\n", 1)[0].trim();
		if (!firstLine || firstLine.length === 0) {
			throw new Error(
				"Commit message subject is empty. Provide a concise subject line."
			);
		}

		const firstNonWhitespaceChar = firstLine.charAt(0);
		if (firstNonWhitespaceChar === "-" || firstNonWhitespaceChar === "*") {
			throw new Error(
				"Commit subject cannot start with '-' or '*' (these can be misinterpreted as CLI flags). Please edit the message to begin with an imperative subject (e.g., 'Add tests for X')."
			);
		}
	}

	/**
	 * Validates the length of the subject line (first line) of the commit message.
	 * Throws an error if the subject line exceeds the hard limit.
	 * @param message The commit message.
	 * @throws An error if the subject line length is excessive.
	 */
	private _validateSubjectLineLength(message: string): void {
		const firstLine = message.split("\n", 1)[0].trim();
		const SUBJECT_HARD_LIMIT = 72; // enforce conventional hard limit
		const SUBJECT_SOFT_LIMIT = 50; // recommended limit

		if (firstLine.length > SUBJECT_HARD_LIMIT) {
			throw new Error(
				`Commit subject is too long (${firstLine.length} chars). Please shorten the first line to ${SUBJECT_HARD_LIMIT} characters or fewer (recommended ${SUBJECT_SOFT_LIMIT}).`
			);
		}
	}

	/**
	 * Performs a final check for unusual unicode sequences and logs a warning if found.
	 * @param message The commit message.
	 */
	private _finalUnicodeCheck(message: string): void {
		if (/[^\u0000-\u007F\u00A0-\uFFFF\n]/.test(message)) {
			this.logger.warn(
				undefined,
				"Commit message contains unusual unicode characters; proceeding after sanitization."
			);
		}
	}

	/**
	 * Validates and sanitizes a commit message for security and best practices.
	 * Orchestrates calls to various helper methods.
	 * @param message The raw commit message.
	 * @returns The sanitized commit message.
	 * @throws An error if the message is invalid or potentially malicious.
	 */
	private _validateAndSanitizeCommitMessage(message: string): string {
		if (message === null || message === undefined) {
			throw new Error("Empty commit message returned from AI.");
		}

		let sanitized = message;

		sanitized = this._removeControlCharacters(sanitized);
		sanitized = this._normalizeNewlines(sanitized);
		sanitized = this._stripQuotesAndBackslashes(sanitized);
		sanitized = this._trimLinesAndCollapseBlankLines(sanitized);
		sanitized = this._removeLeadingListMarkers(sanitized);

		// Security checks (throw errors)
		this._checkInjectionPatterns(sanitized);
		this._checkGitExploitPatterns(sanitized);

		// Format and length checks (throw errors)
		this._validateSubjectLineFormat(sanitized);
		this._validateSubjectLineLength(sanitized);

		// Final warning check
		this._finalUnicodeCheck(sanitized);

		return sanitized;
	}

	/**
	 * Gets a shared terminal for Git operations or creates one if it doesn't exist.
	 * @returns The vscode.Terminal instance.
	 */
	private _getOrCreateTerminal(): vscode.Terminal {
		if (
			this.minovativeMindTerminal &&
			!this.minovativeMindTerminal.exitStatus
		) {
			return this.minovativeMindTerminal;
		}

		this.minovativeMindTerminal = vscode.window.terminals.find(
			(t) => t.name === "Minovative Mind Git"
		);

		if (!this.minovativeMindTerminal) {
			this.minovativeMindTerminal = vscode.window.createTerminal({
				name: "Minovative Mind Git",
				cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
			});
		}

		return this.minovativeMindTerminal;
	}

	/**
	 * Confirms and executes the commit with the provided message using a robust, secure method.
	 * @param editedMessage The commit message, potentially edited by the user.
	 */
	public async confirmCommit(editedMessage: string): Promise<void> {
		if (!this.provider.pendingCommitReviewData) {
			vscode.window.showErrorMessage("No pending commit to confirm.");
			this.logger.error(undefined, "No pending commit review data found.");
			return;
		}

		const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!rootPath) {
			vscode.window.showErrorMessage("No workspace folder for git commit.");
			this.logger.error(
				undefined,
				"No workspace folder found to perform git commit."
			);
			return;
		}

		const cancellationTokenSource = new vscode.CancellationTokenSource();
		const token = cancellationTokenSource.token;

		if (!this.provider.activeChildProcesses) {
			this.provider.activeChildProcesses = [];
		}

		const terminal = this._getOrCreateTerminal();

		try {
			// Re-validate the message in case the user edited it to be malicious.
			const finalCommitMessage =
				this._validateAndSanitizeCommitMessage(editedMessage);
			this.logger.log(
				undefined,
				`Commit message re-validated: \n---\n${finalCommitMessage}\n---`
			);

			const result = await executeCommand(
				"git",
				["commit", "-m", finalCommitMessage],
				rootPath,
				token,
				this.provider.activeChildProcesses,
				terminal
			);

			if (result.exitCode === 0) {
				this.provider.pendingCommitReviewData = null;
				this.provider.chatHistoryManager.addHistoryEntry(
					"model",
					"Git Staging: Changes staged successfully."
				);
				this.provider.chatHistoryManager.addHistoryEntry(
					"model",
					`Commit confirmed and executed successfully:\n---\n${finalCommitMessage}\n---`
				);
				this.logger.log(
					undefined,
					`Commit successful:\n---\n${finalCommitMessage}\n---`
				);

				// Execute `git status` after successful commit
				const gitStatusResult = await executeCommand(
					"git",
					["status"],
					rootPath,
					token,
					this.provider.activeChildProcesses,
					terminal
				);

				if (gitStatusResult.stdout) {
					this.logger.log(
						undefined,
						`Git status stdout after commit:\n${gitStatusResult.stdout}`
					);
				}
				if (gitStatusResult.stderr) {
					this.logger.warn(
						undefined,
						`Git status stderr after commit:\n${gitStatusResult.stderr}`
					);
				}

				let statusOutputForChat = "### Git Status After Commit\n\n";
				if (gitStatusResult.stdout) {
					statusOutputForChat += "```bash\n" + gitStatusResult.stdout + "```\n";
				}
				if (gitStatusResult.stderr) {
					statusOutputForChat +=
						"**Warning (Git Status Stderr):**\n```bash\n" +
						gitStatusResult.stderr +
						"```\n";
				}

				this.provider.chatHistoryManager.addHistoryEntry(
					"model",
					statusOutputForChat
				);

				await this.provider.endUserOperation("success");
			} else {
				const errorMessage = `Git commit failed with exit code ${result.exitCode}.\n\nSTDERR:\n${result.stderr}`;
				vscode.window.showErrorMessage(
					"Git commit failed. See terminal for details."
				);
				this.provider.chatHistoryManager.addHistoryEntry(
					"model",
					`ERROR: ${errorMessage}`
				);
				this.logger.error(undefined, errorMessage);
				await this.provider.endUserOperation("failed");
			}
		} catch (error: any) {
			const errorMessage = `An unexpected error occurred during commit: ${error.message}`;
			vscode.window.showErrorMessage(errorMessage);
			this.provider.chatHistoryManager.addHistoryEntry(
				"model",
				`ERROR: ${errorMessage}`
			);
			this.logger.error(undefined, errorMessage, error);
			await this.provider.endUserOperation("failed");
		} finally {
			cancellationTokenSource.dispose();
		}
	}

	/**
	 * Cancels the pending commit review and re-enables UI.
	 */
	public async cancelCommit(): Promise<void> {
		this.logger.log(undefined, "Commit review cancelled by user.");
		await this.provider.triggerUniversalCancellation();
	}
}
