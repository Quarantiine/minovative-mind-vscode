import * as vscode from "vscode";
import * as path from "path";
import { SidebarProvider } from "../sidebar/SidebarProvider";
import {
	getGitStagedDiff,
	getGitStagedFiles,
	getGitFileContentFromIndex,
	getGitFileContentFromHead,
	stageAllChanges,
	getGitStagedFilesWithStatus,
	getGitCurrentBranch,
	getGitDiffStat,
	type StagedFileWithStatus,
} from "../sidebar/services/gitService";
import { ERROR_OPERATION_CANCELLED } from "../ai/gemini";
import { ChildProcess } from "child_process";
import { generateFileChangeSummary } from "../utils/diffingUtils";
import { DEFAULT_FLASH_LITE_MODEL } from "../sidebar/common/sidebarConstants";
import { executeCommand } from "../utils/commandExecution";
import { Logger } from "../utils/logger";

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
		token: vscode.CancellationToken,
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
					"No workspace folder open for git command.",
				);
				throw new Error("No workspace folder open for git.");
			}

			const onProcessCallback = (process: ChildProcess) => {
				this.logger.log(
					undefined,
					`Git process started: PID ${process.pid}, Command: 'git add .'`,
				);
			};

			const onOutputCallback = (
				type: "stdout" | "stderr" | "status",
				data: string,
				isError?: boolean,
			) => {
				this.provider.postMessageToWebview({
					type: "gitProcessUpdate",
					value: { type, data, isError },
				});

				if (type === "stderr" || isError) {
					this.provider.chatHistoryManager.addHistoryEntry(
						"model",
						`Git Staging Error: ${data}`,
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
				onOutputCallback,
			);
			if (token.isCancellationRequested) {
				throw new Error(ERROR_OPERATION_CANCELLED);
			}

			// --- Gather all git context in parallel where possible ---
			const [diff, stagedFiles, stagedFilesWithStatus, branchName, diffStat] =
				await Promise.all([
					getGitStagedDiff(rootPath),
					getGitStagedFiles(rootPath),
					getGitStagedFilesWithStatus(rootPath),
					getGitCurrentBranch(rootPath),
					getGitDiffStat(rootPath),
				]);

			if (!diff || diff.trim() === "") {
				success = true;
				errorMessage = "No changes staged to commit.";
				return;
			}

			if (token.isCancellationRequested) {
				throw new Error(ERROR_OPERATION_CANCELLED);
			}

			// --- Improvement #5: Change Type Classification ---
			const categoryCounts = new Map<string, number>();
			const fileClassifications: string[] = [];
			for (const fileInfo of stagedFilesWithStatus) {
				const statusLabel = this._getStatusLabel(fileInfo.status);
				const category = this._classifyFileCategory(fileInfo.filePath);
				const label = `${statusLabel} ${category}`;
				categoryCounts.set(label, (categoryCounts.get(label) || 0) + 1);
				fileClassifications.push(
					`  - [${fileInfo.status}] ${fileInfo.filePath} (${category})${
						fileInfo.originalPath
							? ` ← renamed from ${fileInfo.originalPath}`
							: ""
					}`,
				);
			}

			const categoryOverview = Array.from(categoryCounts.entries())
				.map(([label, count]) => `${count} ${label}`)
				.join(", ");

			// --- Pass 1 (existing): Per-file change summaries ---
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
					filePath,
					this.provider.aiRequestService,
					DEFAULT_FLASH_LITE_MODEL,
				);
				fileSummaries.push(summary);
			}

			if (token.isCancellationRequested) {
				throw new Error(ERROR_OPERATION_CANCELLED);
			}

			// --- Pass 2 (NEW): Cross-File Intent Analysis ---
			let overallIntent = "";
			if (fileSummaries.length > 0) {
				const intentPrompt = `You are analyzing a set of code changes across multiple files to determine the overall intent.

Branch: ${branchName}
Change Categories: ${categoryOverview}

Per-file summaries:
${fileSummaries.map((s) => `- ${s}`).join("\n")}

In 1-2 concise sentences, describe the OVERALL PURPOSE and INTENT of these changes as a whole.
Focus on WHAT was accomplished and WHY, not individual file details.
Do not use code fences, quotes, or any formatting — just plain text.`;

				try {
					overallIntent =
						await this.provider.aiRequestService.generateWithRetry(
							[{ text: intentPrompt }],
							modelName,
							undefined,
							"cross-file intent analysis",
							undefined,
							undefined,
							token,
						);
					overallIntent = overallIntent.trim();
					this.logger.log(
						undefined,
						`Cross-file intent analysis result: ${overallIntent}`,
					);
				} catch (error: any) {
					this.logger.warn(
						undefined,
						`Cross-file intent analysis failed, proceeding without it: ${error.message}`,
					);
					overallIntent = "";
				}
			}

			if (token.isCancellationRequested) {
				throw new Error(ERROR_OPERATION_CANCELLED);
			}

			// --- Improvement #4: Intelligent Diff Truncation ---
			const smartDiffContext = this._buildSmartDiffContext(
				diff,
				diffStat,
				fileSummaries,
			);

			// --- Build the enriched commit message prompt ---
			const detailedSummaries =
				fileSummaries.length > 0
					? fileSummaries.map((s) => `- ${s}`).join("\n")
					: "";

			const commitMessagePrompt = `You are an expert Git author. Produce one commit message that clearly explains the changes.

FORMAT REQUIREMENTS (strict):
1) USE CONVENTIONAL COMMIT FORMAT (e.g., "feat: Add OAuth2 support", "fix: Handle null user profile").
   - Keep the SUBJECT line concise (50-72 chars).
   - Choose the prefix based on the change categories and overall intent below.
   - SUBJECT must NOT begin with '-', '*', or any punctuation.
2) INCLUDE A DESCRIPTIVE BODY when changes are significant, logic-heavy, or non-obvious.
   - Explain the "WHY" and "WHAT" of the changes in a few concise sentences or bullet points.
   - Provide enough detail for a reviewer to understand the impact without reading every line of the diff.
   - Do NOT just list files or repeat the file summaries.
3) DO NOT USE double quotes ("), backticks (\`), or backslashes (\\). No shell constructs like $(), &&, ||, or ';'.
4) Output ONLY the commit message. No metadata prefix.
5) Focus on quality over extreme brevity. Ensure the message is helpful for future developers.

--- BRANCH CONTEXT ---
Current branch: ${branchName}
${branchName !== "HEAD" && branchName !== "main" && branchName !== "master" ? `The branch name may hint at the purpose of these changes. Consider it when choosing the commit type prefix.` : ""}

--- CHANGE OVERVIEW ---
Change Categories: ${categoryOverview}
Diff Stat:
${diffStat}

File Classifications:
${fileClassifications.join("\n")}

${overallIntent ? `--- OVERALL INTENT ---\n${overallIntent}\n` : ""}
--- PER-FILE SUMMARIES ---
${detailedSummaries}

--- CODE DIFF (may be truncated for large changes) ---
${smartDiffContext}
`;

			// --- Pass 3: Final commit message generation ---
			let commitMessage =
				await this.provider.aiRequestService.generateWithRetry(
					[{ text: commitMessagePrompt }],
					modelName,
					undefined,
					"commit message generation",
					undefined,
					undefined,
					token,
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
					`AI generated an invalid or error-prefixed commit message: "${commitMessage}"`,
				);
				const userFacingError = `AI failed to generate a valid commit message. Received: "${trimmedCommitMessage.substring(
					0,
					150,
				)}${
					trimmedCommitMessage.length > 150 ? "..." : ""
				}". Please try again or provide more context.`;
				throw new Error(userFacingError);
			}

			this.provider.chatHistoryManager.addHistoryEntry(
				"model",
				validatedMessage,
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
				"Commit message contains characters or patterns that resemble shell commands (e.g. $(), &&, ||, `, ;). For security, please edit the message without these constructs.",
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
				"Commit message appears to include Git configuration-style content, which is not allowed.",
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
				"Commit message subject is empty. Provide a concise subject line.",
			);
		}

		const firstNonWhitespaceChar = firstLine.charAt(0);
		if (firstNonWhitespaceChar === "-" || firstNonWhitespaceChar === "*") {
			throw new Error(
				"Commit subject cannot start with '-' or '*' (these can be misinterpreted as CLI flags). Please edit the message to begin with an imperative subject (e.g., 'Add tests for X').",
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
		const SUBJECT_HARD_LIMIT = 400; // enforce conventional hard limit
		const SUBJECT_SOFT_LIMIT = 50; // recommended limit

		if (firstLine.length > SUBJECT_HARD_LIMIT) {
			throw new Error(
				`Commit subject is too long (${firstLine.length} chars). Please shorten the first line to ${SUBJECT_HARD_LIMIT} characters or fewer (recommended ${SUBJECT_SOFT_LIMIT}).`,
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
				"Commit message contains unusual unicode characters; proceeding after sanitization.",
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
	 * Maps a Git status code to a human-readable label.
	 * @param status The single-character Git status code (A, M, D, R, C, etc.).
	 * @returns A descriptive label for the status.
	 */
	private _getStatusLabel(status: string): string {
		switch (status) {
			case "A":
				return "new";
			case "M":
				return "modified";
			case "D":
				return "deleted";
			case "R":
				return "renamed";
			case "C":
				return "copied";
			default:
				return "changed";
		}
	}

	/**
	 * Classifies a file into a category based on its path and extension.
	 * Used to help the AI choose appropriate conventional-commit prefixes.
	 * @param filePath The file path relative to the repository root.
	 * @returns A category string (e.g., "test", "docs", "config", "style", "source").
	 */
	private _classifyFileCategory(filePath: string): string {
		const lowerPath = filePath.toLowerCase();
		const ext = path.extname(lowerPath);
		const basename = path.basename(lowerPath);

		// Test files
		if (
			lowerPath.includes(".test.") ||
			lowerPath.includes(".spec.") ||
			lowerPath.includes("__tests__/") ||
			lowerPath.includes("/test/") ||
			lowerPath.includes("/tests/")
		) {
			return "test";
		}

		// Documentation
		if (
			ext === ".md" ||
			ext === ".mdx" ||
			ext === ".txt" ||
			ext === ".rst" ||
			lowerPath.startsWith("docs/") ||
			lowerPath.startsWith("doc/")
		) {
			return "docs";
		}

		// Configuration files
		const configFiles = new Set([
			"package.json",
			"package-lock.json",
			"tsconfig.json",
			"webpack.config.js",
			"vite.config.ts",
			"jest.config.js",
			"jest.config.ts",
			".eslintrc",
			".eslintrc.js",
			".eslintrc.json",
			".prettierrc",
			".prettierrc.json",
			".gitignore",
			".npmrc",
			".env",
			".env.example",
			"yarn.lock",
			"pnpm-lock.yaml",
		]);
		if (
			configFiles.has(basename) ||
			basename.startsWith("tsconfig") ||
			basename.startsWith(".eslintrc") ||
			basename.startsWith(".prettierrc")
		) {
			return "config";
		}

		// Style/UI files
		if (
			ext === ".css" ||
			ext === ".scss" ||
			ext === ".sass" ||
			ext === ".less" ||
			ext === ".html" ||
			ext === ".svg"
		) {
			return "style";
		}

		return "source";
	}

	/**
	 * Builds an intelligently truncated diff context for the commit message prompt.
	 * Files with fewer than MAX_LINES_PER_FILE changed lines include their full diff.
	 * Larger files are represented by their stat summary and per-file AI summary only.
	 * @param fullDiff The full staged diff output.
	 * @param diffStat The `git diff --stat` summary.
	 * @param fileSummaries The per-file AI-generated summaries.
	 * @returns A string containing the smart diff context for the prompt.
	 */
	private _buildSmartDiffContext(
		fullDiff: string,
		diffStat: string,
		fileSummaries: string[],
	): string {
		const MAX_LINES_PER_FILE = 200;
		const MAX_TOTAL_DIFF_LINES = 1500;

		// Split the full diff into per-file sections
		const fileDiffs = fullDiff.split(/^(?=diff --git )/m).filter(Boolean);

		const totalChangedLines = fullDiff.split("\n").length;

		// If the entire diff is small enough, include it all
		if (totalChangedLines <= MAX_TOTAL_DIFF_LINES) {
			return fullDiff;
		}

		// Otherwise, apply per-file truncation
		const includedDiffs: string[] = [];
		const truncatedFiles: string[] = [];

		for (const fileDiff of fileDiffs) {
			const lines = fileDiff.split("\n");
			// Count only actual change lines (+/-), not headers or context
			const changedLineCount = lines.filter(
				(l) =>
					(l.startsWith("+") && !l.startsWith("+++")) ||
					(l.startsWith("-") && !l.startsWith("---")),
			).length;

			if (changedLineCount <= MAX_LINES_PER_FILE) {
				includedDiffs.push(fileDiff);
			} else {
				// Extract the filename from the diff header
				const headerMatch = fileDiff.match(/^diff --git a\/(.+?) b\//);
				const fileName = headerMatch ? headerMatch[1] : "unknown file";
				truncatedFiles.push(
					`[${fileName}: ${changedLineCount} changed lines — diff truncated, see summary above]`,
				);
			}
		}

		let result = "";
		if (includedDiffs.length > 0) {
			result += includedDiffs.join("\n");
		}
		if (truncatedFiles.length > 0) {
			result +=
				"\n\n--- TRUNCATED FILES (too large for full diff) ---\n" +
				truncatedFiles.join("\n") +
				"\n\nRefer to the diff stat and per-file summaries above for these files.\n" +
				"Diff Stat for reference:\n" +
				diffStat;
		}

		return result;
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
			(t) => t.name === "Minovative Mind Git",
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
				"No workspace folder found to perform git commit.",
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
				`Commit message re-validated: \n---\n${finalCommitMessage}\n---`,
			);

			const result = await executeCommand(
				"git",
				["commit", "-m", finalCommitMessage],
				rootPath,
				token,
				this.provider.activeChildProcesses,
				terminal,
			);

			if (result.exitCode === 0) {
				this.provider.pendingCommitReviewData = null;
				this.provider.chatHistoryManager.addHistoryEntry(
					"model",
					"Git Staging: Changes staged successfully.",
				);
				this.provider.chatHistoryManager.addHistoryEntry(
					"model",
					`Commit confirmed and executed successfully:\n---\n${finalCommitMessage}\n---`,
				);
				this.logger.log(
					undefined,
					`Commit successful:\n---\n${finalCommitMessage}\n---`,
				);

				// Execute `git status` after successful commit
				const gitStatusResult = await executeCommand(
					"git",
					["status"],
					rootPath,
					token,
					this.provider.activeChildProcesses,
					terminal,
				);

				if (gitStatusResult.stdout) {
					this.logger.log(
						undefined,
						`Git status stdout after commit:\n${gitStatusResult.stdout}`,
					);
				}
				if (gitStatusResult.stderr) {
					this.logger.warn(
						undefined,
						`Git status stderr after commit:\n${gitStatusResult.stderr}`,
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
					statusOutputForChat,
				);

				await this.provider.endUserOperation("success");
			} else {
				const errorMessage = `Git commit failed with exit code ${result.exitCode}.\n\nSTDERR:\n${result.stderr}`;
				vscode.window.showErrorMessage(
					"Git commit failed. See terminal for details.",
				);
				this.provider.chatHistoryManager.addHistoryEntry(
					"model",
					`ERROR: ${errorMessage}`,
				);
				this.logger.error(undefined, errorMessage);
				await this.provider.endUserOperation("failed");
			}
		} catch (error: any) {
			const errorMessage = `An unexpected error occurred during commit: ${error.message}`;
			vscode.window.showErrorMessage(errorMessage);
			this.provider.chatHistoryManager.addHistoryEntry(
				"model",
				`ERROR: ${errorMessage}`,
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
