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
import {
	analyzeFileStructure,
	getLanguageId,
} from "../utils/codeAnalysisUtils";
import { LightweightClassificationService } from "../services/lightweightClassificationService";
import { SearchReplaceService } from "../services/searchReplaceService";
import { formatSuccessfulChangesForPrompt } from "../workflow/changeHistoryFormatter";
import {
	getEnhancedGenerationSystemInstruction,
	getEnhancedGenerationUserMessage,
	getEnhancedModificationSystemInstruction,
	getEnhancedModificationUserMessage,
	_formatRelevantFilesForPrompt,
} from "./prompts/enhancedCodeGenerationPrompts";
import { CodeValidationService } from "../services/codeValidationService";
import { ERROR_OPERATION_CANCELLED } from "../ai/gemini";
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
		private lightweightClassificationService: LightweightClassificationService,
		private searchReplaceService: SearchReplaceService,
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
		generationConfig?: GenerationConfig,
		isRetry: boolean = false,
	): Promise<{
		content: string;
		validation: CodeValidationResult;
		actualPath: string;
	}> {
		const streamId = crypto.randomUUID();

		try {
			const isRewriteOp =
				await this.lightweightClassificationService.checkRewriteIntent(
					generatePrompt,
				);
			const generationContext: EnhancedGenerationContext = {
				...context,
				isRewriteOperation: isRewriteOp,
			};

			const initialResult = await this._generateInitialContent(
				filePath,
				generatePrompt,
				generationContext,
				modelName,
				streamId,
				token,
				undefined, // Explicitly pass undefined for onCodeChunkCallback
				generationConfig,
				isRetry,
			);
			if (!initialResult.isValid) {
				this.postMessageToWebview({
					type: "codeFileStreamEnd",
					value: {
						streamId,
						filePath: `/${path.basename(initialResult.actualPath || filePath)}`,
						success: false,
						error: initialResult.issues?.[0]?.message || "Validation failed",
					},
				});
				return {
					content: initialResult.finalContent,
					validation: initialResult,
					actualPath: initialResult.actualPath || filePath,
				};
			}
			const validation = await this.codeValidationService.validateCode(
				initialResult.actualPath || filePath,
				initialResult.finalContent,
			);
			const result = {
				content: validation.finalContent,
				validation,
				actualPath: initialResult.actualPath || filePath,
			};
			this.postMessageToWebview({
				type: "codeFileStreamEnd",
				value: {
					streamId,
					filePath: `/${path.basename(initialResult.actualPath || filePath)}`,
					success: true,
				},
			});
			return result;
		} catch (error: any) {
			if (
				error instanceof Error &&
				error.message === ERROR_OPERATION_CANCELLED
			) {
				throw error;
			} else {
				this.postMessageToWebview({
					type: "codeFileStreamEnd",
					value: {
						streamId,
						filePath: `/${path.basename(filePath)}`,
						success: false,
						error: error instanceof Error ? error.message : String(error),
					},
				});
				throw error;
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
		token?: vscode.CancellationToken,
		isRetry: boolean = false,
	): Promise<{ content: string; validation: CodeValidationResult }> {
		const streamId = crypto.randomUUID();

		// Optimization: Signal start immediately with "Analyzing structure" status
		const languageId = getLanguageId(path.extname(filePath));
		this.postMessageToWebview({
			type: "codeFileStreamStart",
			value: {
				streamId,
				filePath: `/${path.basename(filePath)}`,
				languageId,
				status: "Analyzing structure",
			},
		});

		try {
			const isRewriteOp =
				await this.lightweightClassificationService.checkRewriteIntent(
					modificationPrompt,
				);
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
				token,
				undefined, // onCodeChunkCallback
				isRetry,
			);
			this.postMessageToWebview({
				type: "codeFileStreamEnd",
				value: {
					streamId,
					filePath: `/${path.basename(filePath)}`,
					success: true,
				},
			});
			return result;
		} catch (error: any) {
			if (
				error instanceof Error &&
				error.message === ERROR_OPERATION_CANCELLED
			) {
				throw error;
			} else {
				this.postMessageToWebview({
					type: "codeFileStreamEnd",
					value: {
						streamId,
						filePath: `/${path.basename(filePath)}`,
						success: false,
						error: error instanceof Error ? error.message : String(error),
					},
				});
				throw error;
			}
		}
	}

	public async validateFileContent(
		fsPath: string,
		content: string,
	): Promise<CodeValidationResult> {
		console.log(`[EnhancedCodeGenerator] Validating file: ${fsPath}`);
		try {
			const validationResult = await this.codeValidationService.validateCode(
				fsPath,
				content,
			);
			return validationResult;
		} catch (error) {
			console.error(
				`[EnhancedCodeGenerator] Error during validation for ${fsPath}:`,
				error,
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
		generationConfig?: GenerationConfig,
		isRetry: boolean = false,
	): Promise<CodeValidationResult & { actualPath?: string }> {
		// Modified return type
		const systemInstruction = getEnhancedGenerationSystemInstruction(
			filePath,
			context,
		);
		const userMessage = getEnhancedGenerationUserMessage(
			generatePrompt,
			context,
		);

		const languageId = getLanguageId(path.extname(filePath));
		this.postMessageToWebview({
			type: "codeFileStreamStart",
			value: {
				streamId,
				filePath: `/${path.basename(filePath)}`,
				languageId,
				status: isRetry ? "Retrying..." : "Loading",
			},
		});

		let isFirstChunk = true;

		try {
			const rawContent = await this.aiRequestService.generateWithRetry(
				[{ text: userMessage }],
				modelName,
				undefined,
				"enhanced file generation",
				generationConfig, // Pass generationConfig here
				{
					onChunk: async (chunk) => {
						if (isFirstChunk) {
							isFirstChunk = false;
							this.postMessageToWebview({
								type: "codeFileStreamStart",
								value: {
									streamId,
									filePath: `/${path.basename(filePath)}`,
									languageId,
									status: isRetry ? "Retrying..." : "Generating code...",
								},
							});
						}
						await this._streamChunk(
							streamId,
							filePath,
							chunk,
							onCodeChunkCallback,
						);
					},
				},
				token,
				false, // isMergeOperation
				systemInstruction, // Pass systemInstruction
			);

			console.log(
				`[EnhancedCodeGenerator] Raw AI response received for ${filePath}:\n${rawContent.substring(
					0,
					500,
				)}...`,
			); // Log first 500 chars

			let finalPath = filePath;
			const extractedContent = this._extractTargetFileContent(
				rawContent,
				filePath,
			);

			if (extractedContent === null) {
				console.warn(
					`[EnhancedCodeGenerator] No content extracted for target file ${finalPath} from AI response.`, // Use finalPath
				);
				return {
					isValid: false,
					finalContent: rawContent, // Return raw content for debugging
					issues: [
						{
							type: "other",
							message: `AI output did not contain the expected file content for ${finalPath}. It might have included content for other files or was malformed.`,
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
					actualPath: finalPath,
				};
			}

			console.log(
				`[EnhancedCodeGenerator] Successfully extracted content for ${finalPath}:\n${extractedContent.substring(
					0,
					500,
				)}...`, // Use finalPath
			);

			const cleanedExtractedContent = cleanCodeOutput(extractedContent);

			// Optimization: Check for valid code format FIRST to avoid an unnecessary AI call.
			// If CodeValidationService says it's valid format (even loosely) and it has substantial length,
			// it is highly likely to be valid code and not a refusal message.
			const basicFormatCheck = this.codeValidationService.checkPureCodeFormat(
				cleanedExtractedContent,
				false,
			);
			const seemsLikeValidCode =
				basicFormatCheck.isValid &&
				cleanedExtractedContent.length > 50 && // Refusals are usually short
				!cleanedExtractedContent.trim().toLowerCase().startsWith("sorry") &&
				!cleanedExtractedContent.trim().toLowerCase().startsWith("i cannot");

			if (
				!seemsLikeValidCode &&
				(await this.lightweightClassificationService.checkIsError(
					cleanedExtractedContent,
				))
			) {
				return {
					isValid: false,
					finalContent: cleanedExtractedContent,
					issues: [
						{
							type: "other",
							message:
								"AI output was identified as an error or refusal to generate content.",
							line: 1,
							severity: "error",
							code: "AI_REFUSAL_OR_ERROR",
							source: "EnhancedCodeGenerator",
						},
					],
					suggestions: [
						"The AI might have hit a safety filter or failed to understand the request.",
						"Try rephrasing your prompt or providing more specific context.",
					],
					actualPath: finalPath,
				};
			}

			if (
				cleanedExtractedContent.trim().length < 5 ||
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
					actualPath: finalPath,
				};
			}

			const validationResult = this.codeValidationService.checkPureCodeFormat(
				cleanedExtractedContent,
				false,
			);

			// Final status update to show check mark when done
			this.postMessageToWebview({
				type: "codeFileStreamStart",
				value: {
					streamId,
					filePath: `/${path.basename(finalPath)}`,
					languageId,
					status: validationResult.isValid ? "✓" : "⚠️",
				},
			});

			return { ...validationResult, actualPath: finalPath }; // NEW: Include finalPath
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
		onCodeChunkCallback?: (chunk: string) => Promise<void> | void,
		isRetry: boolean = false,
	): Promise<{ content: string; validation: CodeValidationResult }> {
		const fileAnalysis = await analyzeFileStructure(filePath, currentContent);
		const contextWithAnalysis: EnhancedGenerationContext = {
			...context,
			fileStructureAnalysis: fileAnalysis,
			successfulChangeHistory: formatSuccessfulChangesForPrompt(
				this.changeLogger.getCompletedPlanChangeSets(),
			),
		};

		const systemInstruction = getEnhancedModificationSystemInstruction(
			filePath,
			contextWithAnalysis,
		);
		const userMessage = getEnhancedModificationUserMessage(
			filePath,
			modificationPrompt,
			currentContent,
			contextWithAnalysis,
		);

		const languageId = getLanguageId(path.extname(filePath));
		this.postMessageToWebview({
			type: "codeFileStreamStart",
			value: {
				streamId,
				filePath: `/${path.basename(filePath)}`,
				languageId,
				status: isRetry ? "Retrying..." : "Loading",
			},
		});

		let isFirstChunk = true;

		const rawContent = await this.aiRequestService.generateWithRetry(
			[{ text: userMessage }],
			modelName,
			undefined,
			"enhanced file modification",
			undefined, // generationConfig
			{
				onChunk: async (chunk) => {
					if (isFirstChunk) {
						isFirstChunk = false;
						this.postMessageToWebview({
							type: "codeFileStreamStart",
							value: {
								streamId,
								filePath: `/${path.basename(filePath)}`,
								languageId,
								status: isRetry ? "Retrying..." : "Generating code...",
							},
						});
					}
					await this._streamChunk(
						streamId,
						filePath,
						chunk,
						onCodeChunkCallback,
					);
				},
			},
			token,
			false, // isMergeOperation
			systemInstruction, // Pass systemInstruction
		);

		// Optimization: Update status to "Applying changes" immediately after generation finishes
		this.postMessageToWebview({
			type: "codeFileStreamStart",
			value: {
				streamId,
				filePath: `/${path.basename(filePath)}`,
				languageId,
				status: "Applying code...",
			},
		});

		// Optimization: Start extraction in parallel with lightweight format checks
		const extractionPromise =
			this.aiRequestService.extractSearchReplaceBlocksViaTool(
				rawContent,
				modelName,
				token,
			);

		const cleanedContent = cleanCodeOutput(rawContent);

		// Optimization: Check for valid code format FIRST.
		const basicFormatCheck = this.codeValidationService.checkPureCodeFormat(
			cleanedContent,
			false,
		);
		const seemsLikeValidCode =
			basicFormatCheck.isValid &&
			cleanedContent.length > 50 &&
			!cleanedContent.trim().toLowerCase().startsWith("sorry") &&
			!cleanedContent.trim().toLowerCase().startsWith("i cannot");

		if (
			!seemsLikeValidCode &&
			(await this.lightweightClassificationService.checkIsError(cleanedContent))
		) {
			return {
				content: cleanedContent,
				validation: {
					isValid: false,
					finalContent: cleanedContent,
					issues: [
						{
							type: "other",
							message:
								"AI output was identified as an error or refusal to modify content.",
							line: 1,
							severity: "error",
							code: "AI_REFUSAL_OR_ERROR",
							source: "EnhancedCodeGenerator",
						},
					],
					suggestions: [
						"The AI might have hit a safety filter or failed to understand the request.",
						"Try rephrasing your prompt or providing more specific context.",
					],
				},
			};
		}

		let finalModifiedContent: string;
		let blocks = this.searchReplaceService.parseBlocks(rawContent);

		if (blocks.length === 0) {
			// If regex parsing failed, check if we should even bother with the tool
			// (e.g. if new markers are there, maybe regex missed them somehow?)
			const hasNewMarkers =
				rawContent.match(/^<{5,}\s*SEARC#H$/im) ||
				rawContent.includes("<<<<<<<" + " SEARC#H");

			if (hasNewMarkers) {
				console.log(
					"[EnhancedCodeGenerator] Regex parsing failed but new markers detected. Falling back to AI tool extraction...",
				);
				const extractionResult = await extractionPromise;
				blocks = extractionResult.blocks;
			}
		}

		if (blocks.length > 0) {
			try {
				finalModifiedContent = this.searchReplaceService.applyBlocks(
					currentContent,
					blocks,
				);
			} catch (error: any) {
				console.error(
					`[EnhancedCodeGenerator] Failed to apply Search/Replace blocks: ${error.message}`,
				);
				throw new Error(`Failed to apply code changes: ${error.message}`);
			}
		} else {
			// No blocks found with regex or tool.
			// Explicitly check for OLD markers to prevent them from slipping through via full rewrite
			const hasOldMarkers =
				rawContent.match(/^<{5,}\s*SEARCH$/im) ||
				rawContent.includes("<<<<<<<" + " SEARCH");

			if (hasOldMarkers) {
				return {
					content: cleanedContent,
					validation: {
						isValid: false,
						finalContent: cleanedContent,
						issues: [
							{
								type: "other",
								message:
									"The AI used the old SEARCH/REPLACE format. We now strictly require SEARC#H and REPLAC#E.",
								line: 1,
								severity: "error",
								code: "OLD_MARKER_FORMAT",
								source: "EnhancedCodeGenerator",
							},
						],
						suggestions: [
							"Please ensure the AI uses the new marker format with the '#' character.",
						],
					},
				};
			}
			if (cleanedContent.trim().length < 5 || cleanedContent.trim() === "/") {
				return {
					content: cleanedContent,
					validation: {
						isValid: false,
						finalContent: cleanedContent,
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
							"Refine your prompt. The AI might be confused by the request or existing file context.",
							"Ensure the AI is instructed to provide the full modified file content, not just a snippet or placeholder.",
						],
					},
				};
			}
			finalModifiedContent = cleanedContent;
		}

		const validation = await this._validateAndRefineModification(
			filePath,
			currentContent,
			finalModifiedContent,
			contextWithAnalysis,
			modelName,
			streamId,
			token,
			onCodeChunkCallback,
		);

		// Final status update to show check mark when done
		this.postMessageToWebview({
			type: "codeFileStreamStart",
			value: {
				streamId,
				filePath: `/${path.basename(filePath)}`,
				languageId,
				status: "✓",
			},
		});

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
		onCodeChunkCallback?: (chunk: string) => Promise<void> | void,
	): Promise<CodeValidationResult> {
		return this.codeValidationService.validateCode(filePath, modifiedContent);
	}

	/**
	 * Helper for handling streaming chunks.
	 */
	private async _streamChunk(
		streamId: string,
		filePath: string,
		chunk: string,
		onCodeChunkCallback?: (chunk: string) => Promise<void> | void,
	) {
		this.postMessageToWebview({
			type: "codeFileStreamChunk",
			value: { streamId, filePath: `/${path.basename(filePath)}`, chunk },
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
		targetFilePath: string,
	): string | null {
		console.log(
			`[EnhancedCodeGenerator] Attempting to extract content for target file: ${targetFilePath}`,
		);
		console.log(
			`[EnhancedCodeGenerator] Raw AI response (first 200 chars): ${rawResponse.substring(
				0,
				200,
			)}...`,
		);

		// Normalize target file path for robust matching (e.g., remove leading slash if present, ensure consistency)
		const normalizedTargetFilePath = targetFilePath.startsWith("/")
			? targetFilePath.substring(1)
			: targetFilePath;

		const regex = new RegExp(
			`^---\\s*path:\\s*(${normalizedTargetFilePath.replace(
				/[.*+?^${}()|[\\\]\\\\]/g,
				"\\\\$&",
			)})\\s*---\\n([\\s\\S]*?)(?=\\n^---\\s*path:|$)`,
			"gm",
		);

		let match;
		let extractedContent: string | null = null;
		let bestMatchLength = -1;

		while ((match = regex.exec(rawResponse)) !== null) {
			const matchedFilePath = match[1];
			let contentBlock = match[2].trim();

			// Strip leading/trailing code fences if present from content block
			// A more robust check for a fence might be needed here, as AI can be inconsistent.
			// If the content starts with '```' and ends with '```', assume it's a fenced block.
			// The regex for extraction already tries to exclude them, but as a fallback.
			if (contentBlock.startsWith("```") && contentBlock.endsWith("```")) {
				const lines = contentBlock.split("\n");
				// Check if the first line starts with '```' (possibly with language) and last line is '```'
				if (
					lines.length >= 2 &&
					lines[0].startsWith("```") &&
					lines[lines.length - 1].trim() === "```"
				) {
					contentBlock = lines
						.slice(1, lines.length - 1)
						.join("\n")
						.trim();
				}
			}

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
						`[EnhancedCodeGenerator] Found potential content block for ${matchedFilePath}, length: ${contentBlock.length}`,
					);
				}
			}
		}

		if (extractedContent) {
			console.log(
				`[EnhancedCodeGenerator] Successfully extracted content for ${targetFilePath}.`,
			);
		}

		return extractedContent;
	}
}
