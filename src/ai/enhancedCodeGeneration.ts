import * as vscode from "vscode";
import * as path from "path";
import * as crypto from "crypto";
import { AIRequestService } from "../services/aiRequestService";
import {
	CodeIssue,
	CodeValidationResult,
	EnhancedGenerationContext,
	FileAnalysis,
	FileStructureAnalysis,
} from "../types/codeGenerationTypes";
import { cleanCodeOutput } from "../utils/codeUtils";
import { ExtensionToWebviewMessages } from "../sidebar/common/sidebarTypes";
import { ProjectChangeLogger } from "../workflow/ProjectChangeLogger";
import { ContextRefresherService } from "../services/contextRefresherService";
import {
	analyzeFileStructure,
	getLanguageId,
	isRewriteIntentDetected,
	isAIOutputLikelyErrorMessage,
} from "../utils/codeAnalysisUtils";
import { formatSuccessfulChangesForPrompt } from "../workflow/changeHistoryFormatter";
import {
	createEnhancedGenerationPrompt,
	createEnhancedModificationPrompt,
} from "./prompts/enhancedCodeGenerationPrompts";
import { CodeValidationService } from "../services/codeValidationService";
import { DEFAULT_SIZE } from "../sidebar/common/sidebarConstants";
import { GenerationConfig } from "@google/generative-ai";

// Re-export these types to make them accessible to other modules that import from this file.
export type {
	CodeIssue,
	FileAnalysis,
	FileStructureAnalysis,
	EnhancedGenerationContext,
};

/**
 * Orchestrates the AI-driven code generation and modification process,
 * leveraging a real-time feedback loop and specialized services for accuracy and quality.
 */
export class EnhancedCodeGenerator {
	constructor(
		private aiRequestService: AIRequestService,
		private postMessageToWebview: (message: ExtensionToWebviewMessages) => void,
		private changeLogger: ProjectChangeLogger,
		private codeValidationService: CodeValidationService,
		private contextRefresherService: ContextRefresherService
	) {}

	/**
	 * Enhanced file content generation with real-time feedback loop.
	 */
	public async generateFileContent(
		filePath: string,
		generatePrompt: string,
		context: EnhancedGenerationContext,
		modelName: string,
		token?: vscode.CancellationToken,
		generationConfig?: GenerationConfig // New parameter
	): Promise<{ content: string; validation: CodeValidationResult }> {
		const languageId = getLanguageId(path.extname(filePath));
		const streamId = crypto.randomUUID();

		this.postMessageToWebview({
			type: "codeFileStreamStart",
			value: { streamId, filePath, languageId },
		});

		try {
			const isRewriteOp = isRewriteIntentDetected(generatePrompt, filePath);
			const generationContext: EnhancedGenerationContext = {
				...context,
				isRewriteOperation: isRewriteOp,
			};

			// Fallback for non-real-time generation
			const initialResult = await this._generateInitialContent(
				filePath,
				generatePrompt,
				generationContext,
				modelName,
				streamId,
				token,
				undefined, // Explicitly pass undefined for onCodeChunkCallback
				generationConfig
			);
			if (!initialResult.isValid) {
				return {
					content: initialResult.finalContent,
					validation: initialResult,
				};
			}
			const validation = await this.codeValidationService.validateCode(
				filePath,
				initialResult.finalContent
			);
			const result = { content: validation.finalContent, validation };
			this.postMessageToWebview({
				type: "codeFileStreamEnd",
				value: { streamId, filePath, success: true },
			});
			return result;
		} catch (error: any) {
			// Check if the error message indicates cancellation (case-insensitive)
			if (
				error instanceof Error &&
				error.message.toLowerCase().includes("cancelled")
			) {
				// If it's a cancellation error, re-throw it immediately.
				// This prevents sending a redundant codeFileStreamEnd message from this layer.
				throw error;
			} else {
				// For any other type of error, post the codeFileStreamEnd message
				// to indicate failure for this specific operation, and then re-throw.
				this.postMessageToWebview({
					type: "codeFileStreamEnd",
					value: {
						streamId,
						filePath,
						success: false,
						error: error instanceof Error ? error.message : String(error),
					},
				});
				throw error; // Re-throw the error for higher-level handling
			}
		}
	}

	/**
	 * Enhanced file modification with intelligent diff analysis and real-time feedback.
	 */
	public async modifyFileContent(
		filePath: string,
		modificationPrompt: string,
		currentContent: string,
		context: EnhancedGenerationContext,
		modelName: string,
		token?: vscode.CancellationToken
	): Promise<{ content: string; validation: CodeValidationResult }> {
		const languageId = getLanguageId(path.extname(filePath));
		const streamId = crypto.randomUUID();

		this.postMessageToWebview({
			type: "codeFileStreamStart",
			value: { streamId, filePath, languageId },
		});

		try {
			const isRewriteOp = isRewriteIntentDetected(modificationPrompt, filePath);
			const modificationContext: EnhancedGenerationContext = {
				...context,
				isRewriteOperation: isRewriteOp,
			};

			const result = await this._modifyFileContentFull(
				filePath,
				modificationPrompt,
				currentContent,
				modificationContext,
				modelName,
				streamId,
				token
			);
			this.postMessageToWebview({
				type: "codeFileStreamEnd",
				value: { streamId, filePath, success: true },
			});
			return result;
		} catch (error: any) {
			// Check if the error message indicates cancellation (case-insensitive)
			if (
				error instanceof Error &&
				error.message.toLowerCase().includes("cancelled")
			) {
				// If it's a cancellation error, re-throw it immediately.
				// This prevents sending a redundant codeFileStreamEnd message from this layer.
				throw error;
			} else {
				// For any other type of error, post the codeFileStreamEnd message
				// to indicate failure for this specific operation, and then re-throw.
				this.postMessageToWebview({
					type: "codeFileStreamEnd",
					value: {
						streamId,
						filePath,
						success: false,
						error: error instanceof Error ? error.message : String(error),
					},
				});
				throw error; // Re-throw the error for higher-level handling
			}
		}
	}

	public async validateFileContent(
		fsPath: string,
		content: string
	): Promise<CodeValidationResult> {
		console.log(`[EnhancedCodeGenerator] Validating file: ${fsPath}`);
		try {
			const validationResult = await this.codeValidationService.validateCode(
				fsPath,
				content
			);
			return validationResult;
		} catch (error) {
			console.error(
				`[EnhancedCodeGenerator] Error during validation for ${fsPath}:`,
				error
			);
			// Return a default error structure if validation itself fails unexpectedly
			return {
				isValid: false,
				finalContent: content,
				issues: [
					{
						type: "other",
						line: 1,
						severity: "error",
						message: `Validation failed: ${(error as Error).message}`,
						code: "VALIDATION_ERROR",
						source: "EnhancedCodeGenerator",
					},
				],
				suggestions: [
					"An unexpected error occurred during the validation process.",
				],
			};
		}
	}

	/**
	 * Generates the initial version of the code.
	 */
	private async _generateInitialContent(
		filePath: string,
		generatePrompt: string,
		context: EnhancedGenerationContext,
		modelName: string,
		streamId: string,
		token?: vscode.CancellationToken,
		onCodeChunkCallback?: (chunk: string) => Promise<void> | void,
		generationConfig?: GenerationConfig // New parameter
	): Promise<CodeValidationResult> {
		const enhancedPrompt = createEnhancedGenerationPrompt(
			filePath,
			generatePrompt,
			context
		);
		try {
			const rawContent = await this.aiRequestService.generateWithRetry(
				[{ text: enhancedPrompt }],
				modelName,
				undefined,
				"enhanced file generation",
				generationConfig, // Pass generationConfig here
				{
					onChunk: async (chunk) =>
						this._streamChunk(streamId, filePath, chunk, onCodeChunkCallback),
				},
				token
			);

			console.log(
				`[EnhancedCodeGenerator] Raw AI response received for ${filePath}:\n${rawContent.substring(
					0,
					500
				)}...`
			); // Log first 500 chars

			const extractedContent = this._extractTargetFileContent(
				rawContent,
				filePath
			);

			if (extractedContent === null) {
				console.warn(
					`[EnhancedCodeGenerator] No content extracted for target file ${filePath} from AI response.`
				);
				return {
					isValid: false,
					finalContent: rawContent, // Return raw content for debugging
					issues: [
						{
							type: "other",
							message: `AI output did not contain the expected file content for ${filePath}. It might have included content for other files or was malformed.`,
							line: 1,
							severity: "error",
							code: "AI_CONTENT_EXTRACTION_FAILED",
							source: "EnhancedCodeGenerator",
						},
					],
					suggestions: [
						"Refine your prompt to ensure the AI explicitly provides the content for the target file.",
						"Instruct the AI to clearly mark the file content, e.g., with `// path/to/file.ts` followed by code.",
					],
				};
			}

			console.log(
				`[EnhancedCodeGenerator] Successfully extracted content for ${filePath}:\n${extractedContent.substring(
					0,
					500
				)}...`
			);

			const cleanedExtractedContent = cleanCodeOutput(extractedContent);

			if (
				cleanedExtractedContent.trim().length < 5 ||
				isAIOutputLikelyErrorMessage(cleanedExtractedContent) ||
				cleanedExtractedContent.trim() === "/"
			) {
				return {
					isValid: false,
					finalContent: cleanedExtractedContent, // Return raw content for debugging
					issues: [
						{
							type: "other",
							message: `AI generated invalid or unexpectedly short content. Expected full code.`,
							line: 1,
							severity: "error",
							code: "AI_EMPTY_OR_MALFORMED_OUTPUT",
							source: "EnhancedCodeGenerator",
						},
					],
					suggestions: [
						"Refine your prompt. The AI might be confused by the request or existing file context.",
						"Ensure the AI is instructed to provide the full file content, not just a snippet or placeholder.",
					],
				};
			}

			return this.codeValidationService.checkPureCodeFormat(
				cleanedExtractedContent,
				false
			);
		} catch (error: any) {
			// Re-throw the error to be handled by the PlanExecutorService's retry logic.
			// This prevents silent failures where an empty file is created.
			throw error;
		}
	}

	/**
	 * Orchestrates the full modification process including generation, validation, and refinement.
	 */
	private async _modifyFileContentFull(
		filePath: string,
		modificationPrompt: string,
		currentContent: string,
		context: EnhancedGenerationContext,
		modelName: string,
		streamId: string,
		token?: vscode.CancellationToken,
		onCodeChunkCallback?: (chunk: string) => Promise<void> | void
	): Promise<{ content: string; validation: CodeValidationResult }> {
		const fileAnalysis = await analyzeFileStructure(filePath, currentContent);
		const contextWithAnalysis: EnhancedGenerationContext = {
			...context,
			fileStructureAnalysis: fileAnalysis,
			successfulChangeHistory: formatSuccessfulChangesForPrompt(
				this.changeLogger.getCompletedPlanChangeSets()
			),
		};

		const enhancedPrompt = createEnhancedModificationPrompt(
			filePath,
			modificationPrompt,
			currentContent,
			contextWithAnalysis
		);
		const rawContent = await this.aiRequestService.generateWithRetry(
			[{ text: enhancedPrompt }],
			modelName,
			undefined,
			"enhanced file modification",
			undefined,
			{
				onChunk: async (chunk) =>
					this._streamChunk(streamId, filePath, chunk, onCodeChunkCallback),
			},
			token
		);

		const modifiedContent = cleanCodeOutput(rawContent);

		if (
			modifiedContent.trim().length < 5 ||
			isAIOutputLikelyErrorMessage(modifiedContent) ||
			modifiedContent.trim() === "/"
		) {
			return {
				content: modifiedContent, // Ensure modifiedContent is returned for debugging
				validation: {
					isValid: false,
					finalContent: modifiedContent, // Return modifiedContent for debugging
					issues: [
						{
							type: "other",
							message: `AI generated invalid or unexpectedly short content. Expected full file content.`,
							line: 1,
							severity: "error",
							code: "AI_EMPTY_OR_MALFORMED_OUTPUT",
							source: "EnhancedCodeGenerator",
						},
					],
					suggestions: [
						"Refine your prompt. The AI might be confused by the request or existing file context, especially when modifying a core validation file.",
						"Ensure the AI is instructed to provide the full modified file content, not just a snippet or placeholder.",
					],
				},
			};
		}

		const validation = await this._validateAndRefineModification(
			filePath,
			currentContent,
			modifiedContent,
			contextWithAnalysis,
			modelName,
			streamId,
			token,
			onCodeChunkCallback
		);

		return { content: validation.finalContent, validation };
	}

	/**
	 * Validates and refines a generated modification.
	 */
	private async _validateAndRefineModification(
		filePath: string,
		originalContent: string,
		modifiedContent: string,
		context: EnhancedGenerationContext,
		modelName: string,
		streamId: string,
		token?: vscode.CancellationToken,
		onCodeChunkCallback?: (chunk: string) => Promise<void> | void
	): Promise<CodeValidationResult> {
		// Removed conditional logic for AI refinement based on diff analysis.
		return this.codeValidationService.validateCode(filePath, modifiedContent);
	}

	/**
	 * Helper for handling streaming chunks.
	 */
	private async _streamChunk(
		streamId: string,
		filePath: string,
		chunk: string,
		onCodeChunkCallback?: (chunk: string) => Promise<void> | void
	) {
		this.postMessageToWebview({
			type: "codeFileStreamChunk",
			value: { streamId, filePath, chunk },
		});
		if (onCodeChunkCallback) {
			await onCodeChunkCallback(chunk);
		}
	}

	/**
	 * Extracts the content of a specific target file from a raw AI response,
	 * handling various path indicator formats.
	 * Returns null if the target file's content cannot be found.
	 */
	private _extractTargetFileContent(
		rawResponse: string,
		targetFilePath: string
	): string | null {
		console.log(
			`[EnhancedCodeGenerator] Attempting to extract content for target file: ${targetFilePath}`
		);
		console.log(
			`[EnhancedCodeGenerator] Raw AI response (first 200 chars): ${rawResponse.substring(
				0,
				200
			)}...`
		);

		// Normalize target file path for robust matching (e.g., remove leading slash if present, ensure consistency)
		const normalizedTargetFilePath = targetFilePath.startsWith("/")
			? targetFilePath.substring(1)
			: targetFilePath;

		// Regex to find file path indicators and capture content until the next indicator or end of string.
		// It handles:
		// - `// path/to/file.ts`
		// - `/* path/to/file.ts */`
		// - `--- Relevant File: path/to/file.ts ---` (often followed by ```lang ... ```)
		// - `Path: path/to/file.ts` (often followed by ```lang ... ```)
		const regex = new RegExp(
			`(?://\\s*|/\\*\\s*|--- Relevant File:\\s*|Path:\\s*)[\\s\\"\\']?(${normalizedTargetFilePath.replace(
				/[.*+?^${}()|[\]\\]/g,
				"\\$&"
			)})[\\s\\"\\']?(?:\\s*\\*/)?(?:\\s*---)?(?:\\s*\\n)?\\s*(?:\\\`{3}[a-zA-Z]*\\n)?([\\s\\S]*?)(?=\\n(?:\\\`{3}|(?://|/\\*|--- Relevant File:|Path:)\\s*(?!\\\`{3}))|$)`,
			"gm"
		);

		let match;
		let extractedContent: string | null = null;
		let bestMatchLength = -1;

		while ((match = regex.exec(rawResponse)) !== null) {
			const matchedFilePath = match[1];
			const contentBlock = match[2].trim();

			if (
				matchedFilePath === normalizedTargetFilePath ||
				matchedFilePath === targetFilePath // Try both normalized and original
			) {
				// If a closer match is found (e.g., a file path that is not just a prefix)
				// Or if this is the first match, consider it.
				// For simplicity, we'll take the longest content block for the target file,
				// assuming it's the most complete.
				if (contentBlock.length > bestMatchLength) {
					extractedContent = contentBlock;
					bestMatchLength = contentBlock.length;
					console.log(
						`[EnhancedCodeGenerator] Found potential content block for ${matchedFilePath}, length: ${contentBlock.length}`
					);
				}
			}
		}

		if (extractedContent) {
			console.log(
				`[EnhancedCodeGenerator] Successfully extracted content for ${targetFilePath}.`
			);
		} else {
			console.warn(
				`[EnhancedCodeGenerator] Could not extract content for ${targetFilePath}.`
			);
		}

		return extractedContent;
	}

	/**
	 * Helper to format relevant files content into Markdown fenced code blocks for prompts.
	 */
	private async _formatRelevantFilesForPrompt(
		relevantFilePaths: string[],
		workspaceRootUri: vscode.Uri,
		token: vscode.CancellationToken
	): Promise<string> {
		if (!relevantFilePaths || relevantFilePaths.length === 0) {
			return "";
		}

		const formattedSnippets: string[] = [];
		const maxFileSizeForSnippet = DEFAULT_SIZE;

		for (const relativePath of relevantFilePaths) {
			if (token.isCancellationRequested) {
				return formattedSnippets.join("\n");
			}

			const fileUri = vscode.Uri.joinPath(workspaceRootUri, relativePath);
			let fileContent: string | null = null;
			let languageId = path.extname(relativePath).substring(1);
			if (!languageId) {
				languageId = path.basename(relativePath).toLowerCase();
			}
			if (languageId === "makefile") {
				languageId = "makefile";
			} else if (languageId === "dockerfile") {
				languageId = "dockerfile";
			} else if (languageId === "jsonc") {
				languageId = "json";
			} else if (
				languageId === "eslintignore" ||
				languageId === "prettierignore" ||
				languageId === "gitignore"
			) {
				languageId = "ignore";
			} else if (languageId === "license") {
				languageId = "plaintext";
			}

			try {
				const fileStat = await vscode.workspace.fs.stat(fileUri);

				if (fileStat.type === vscode.FileType.Directory) {
					continue;
				}

				if (fileStat.size > maxFileSizeForSnippet) {
					console.warn(
						`[EnhancedCodeGenerator] Skipping relevant file '${relativePath}' (size: ${fileStat.size} bytes) due to size limit for prompt inclusion.`
					);
					formattedSnippets.push(
						`--- Relevant File: ${relativePath} ---\n\`\`\`plaintext\n[File skipped: too large for context (${(
							fileStat.size / 1024
						).toFixed(2)}KB > ${(maxFileSizeForSnippet / 1024).toFixed(
							2
						)}KB)]\n\`\`\`\n`
					);
					continue;
				}

				const contentBuffer = await vscode.workspace.fs.readFile(fileUri);
				const content = Buffer.from(contentBuffer).toString("utf8");

				if (content.includes("\0")) {
					console.warn(
						`[EnhancedCodeGenerator] Skipping relevant file '${relativePath}' as it appears to be binary.`
					);
					formattedSnippets.push(
						`--- Relevant File: ${relativePath} ---\n\`\`\`plaintext\n[File skipped: appears to be binary]\n\`\`\`\n`
					);
					continue;
				}

				fileContent = content;
			} catch (error: any) {
				if (
					error instanceof vscode.FileSystemError &&
					(error.code === "FileNotFound" || error.code === "EntryNotFound")
				) {
					console.warn(
						`[EnhancedCodeGenerator] Relevant file not found: '${relativePath}'. Skipping.`
					);
				} else if (error.message.includes("is not a file")) {
					console.warn(
						`[EnhancedCodeGenerator] Skipping directory '${relativePath}' as a relevant file.`
					);
				} else {
					console.error(
						`[EnhancedCodeGenerator] Error reading relevant file '${relativePath}': ${error.message}. Skipping.`,
						error
					);
				}
				formattedSnippets.push(
					`--- Relevant File: ${relativePath} ---\n\`\`\`plaintext\n[File skipped: could not be read or is inaccessible: ${error.message}]\n\`\`\`\n`
				);
				continue;
			}

			if (fileContent !== null) {
				formattedSnippets.push(
					`--- Relevant File: ${relativePath} ---\n\`\`\`${languageId}\n${fileContent}\n\`\`\`\n`
				);
			}
		}

		return formattedSnippets.join("\n");
	}
}
