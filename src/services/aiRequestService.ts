import * as vscode from "vscode";
import {
	Content,
	GenerationConfig,
	FunctionCall,
	Tool,
	FunctionCallingMode,
	SchemaType,
} from "@google/generative-ai";
import { ApiKeyManager } from "../sidebar/managers/apiKeyManager";
import { HistoryEntry, HistoryEntryPart } from "../sidebar/common/sidebarTypes";
import * as gemini from "../ai/gemini";
import {
	ERROR_OPERATION_CANCELLED,
	ERROR_QUOTA_EXCEEDED,
	ERROR_SERVICE_UNAVAILABLE,
	generateContentStream,
	countGeminiTokens,
} from "../ai/gemini";
import {
	ParallelProcessor,
	ParallelTask,
	ParallelTaskResult,
} from "../utils/parallelProcessor";
import { TokenTrackingService } from "./tokenTrackingService";

export type SearchReplaceBlockToolOutput = {
	blocks: Array<{
		search: string;
		replace: string;
	}>;
};

export const SEARCH_REPLACE_EXTRACTION_TOOL: Tool = {
	functionDeclarations: [
		{
			name: "extractSearchReplaceBlocks",
			description:
				"Extracts intended code changes from raw text output using the <<<<< SEARCH / ======= / >>>>> REPLACE marker format. Returns an array of objects, each containing 'search' (the text to find) and 'replace' (the text to substitute).",
			parameters: {
				type: SchemaType.OBJECT,
				properties: {
					blocks: {
						type: SchemaType.ARRAY,
						description:
							"An array containing all identified search and replace pairs.",
						items: {
							type: SchemaType.OBJECT,
							properties: {
								search: {
									type: SchemaType.STRING,
									description:
										"The exact segment of code identified for search.",
								},
								replace: {
									type: SchemaType.STRING,
									description:
										"The exact code segment intended as the replacement.",
								},
							},
							required: ["search", "replace"],
						},
					},
				},
				required: ["blocks"],
			},
		},
	],
};

export class AIRequestService {
	constructor(
		private apiKeyManager: ApiKeyManager,
		private postMessageToWebview: (message: any) => void,
		private tokenTrackingService: TokenTrackingService, // Made tokenTrackingService a required dependency
	) {}

	/**
	 * Extracts structured search/replace blocks from raw LLM text output using Function Calling/Tool Use.
	 * This is intended to replace brittle regex parsing of text output.
	 */
	public async extractSearchReplaceBlocksViaTool(
		rawTextOutput: string,
		modelName: string,
		token?: vscode.CancellationToken,
	): Promise<SearchReplaceBlockToolOutput> {
		const apiKey = this.apiKeyManager.getActiveApiKey();
		if (!apiKey) {
			throw new Error("No API Key available for structured extraction.");
		}

		const contents: Content[] = [
			{
				role: "user",
				parts: [
					{
						text: `Analyze the following raw output text and extract all requested search and replace code segments using the provided tool definition. If no markers are found, return an empty array for the blocks list. Ensure that 'search' and 'replace' content derived from the markers are accurately captured and trimmed.

Raw Output Text:
"""
${rawTextOutput}
"""`,
					},
				],
			},
		];

		const result = await this.raceWithCancellation(
			gemini.generateFunctionCall(
				apiKey,
				modelName,
				contents,
				[SEARCH_REPLACE_EXTRACTION_TOOL],
				FunctionCallingMode.ANY,
			),
			token,
		);

		if (!result || !result.functionCall) {
			// Model decided not to call the function (returned null/text response instead of tool call)
			return { blocks: [] };
		}

		const functionCall = result.functionCall;

		if (functionCall.name !== "extractSearchReplaceBlocks") {
			throw new Error(
				`AI returned an unexpected function name: ${functionCall.name}`,
			);
		}

		// The arguments are returned as a JSON string that needs parsing
		const argsJson = functionCall.args as unknown as string; // Cast to unknown then string because library types might be fuzzy or generic
		// Actually, Gemini API types often return args as object already if parsed by library, or string if raw.
		// Let's assume the library returns it as object based on FunctionCall type definition which usually has args: object.
		// Wait, the Google Generative AI SDK `FunctionCall` interface has `args: object`.
		// So we can cast it directly or validate it.
		// Let's safe cast.

		const structuredOutput =
			functionCall.args as unknown as SearchReplaceBlockToolOutput;

		if (!Array.isArray(structuredOutput.blocks)) {
			// Fallback: sometimes args might be a string JSON if something weird happens, but standard SDK parses it.
			// If it's not an array, maybe it failed to parse?
			// Let's assume SDK works as typed.
			throw new Error(
				"Function call arguments did not return a valid blocks array.",
			);
		}

		// Defensively trim results captured by the tool
		const sanitizedblocks = structuredOutput.blocks.map((block) => ({
			search: block.search.trim(),
			replace: block.replace.trim(),
		}));

		return { blocks: sanitizedblocks };
	}

	/**
	 * Helper method to race a promise against a cancellation token.
	 * If the token is cancelled, the promise rejects immediately with ERROR_OPERATION_CANCELLED.
	 */
	private async raceWithCancellation<T>(
		promise: Promise<T>,
		token?: vscode.CancellationToken,
	): Promise<T> {
		if (!token) {
			return promise;
		}

		if (token.isCancellationRequested) {
			throw new Error(ERROR_OPERATION_CANCELLED);
		}

		return new Promise<T>((resolve, reject) => {
			const disposable = token.onCancellationRequested(() => {
				disposable.dispose();
				reject(new Error(ERROR_OPERATION_CANCELLED));
			});

			promise.then(
				(result) => {
					disposable.dispose();
					resolve(result);
				},
				(error) => {
					disposable.dispose();
					reject(error);
				},
			);
		});
	}

	/**
	 * Transforms an array of internal HistoryEntry objects into the format required by the Gemini API's `Content` type.
	 */
	private transformHistoryForGemini(history: HistoryEntry[]): Content[] {
		return history.map((entry) => {
			const parts: Content["parts"] = entry.parts.map((part) => {
				// HistoryEntryPart can be either { text: string } or { inlineData: ImageInlineData }
				if ("inlineData" in part) {
					// If 'inlineData' property exists, it's an image part
					const inlineData = part.inlineData;
					return {
						inlineData: {
							data: inlineData.data,
							mimeType: inlineData.mimeType,
						},
					};
				} else if ("text" in part) {
					// If 'text' property exists, it's a text part
					return {
						text: part.text,
					};
				}
				// Fallback for unexpected cases. This should theoretically not be reached
				// if HistoryEntryPart is strictly defined as {text: string} | {inlineData: ImageInlineData}.
				// Keeping it for robustness as per the original code's implied fallback.
				return { text: "" };
			});

			// If diffContent is present in the history entry, append it as a new part
			if (entry.diffContent) {
				parts.push({ text: "Code Diff:\n" + entry.diffContent });
			}

			return {
				role: entry.role,
				parts: parts,
			};
		});
	}

	/**
	 * A robust wrapper for making generation requests to the AI.
	 * It handles API key rotation on quota errors, retries, and cancellation.
	 */
	public async generateWithRetry(
		userContentParts: HistoryEntryPart[],
		modelName: string,
		history: readonly HistoryEntry[] | undefined,
		requestType: string = "request",
		generationConfig?: GenerationConfig,
		streamCallbacks?: {
			onChunk: (chunk: string) => Promise<void> | void;
			onComplete?: () => void;
		},
		token?: vscode.CancellationToken,
		isMergeOperation: boolean = false,
		systemInstruction?: string,
	): Promise<string> {
		let currentApiKey = this.apiKeyManager.getActiveApiKey();

		if (!currentApiKey) {
			return `Error: No API Key available. Please add an API key in the settings.`;
		}

		let consecutiveTransientErrorCount = 0;
		const baseDelayMs = 15000;
		const maxDelayMs = 10 * 60 * 1000;

		// Initialize tracking variables
		let totalInputTokensConsumed = 0;
		let finalOutputTokensCount = 0;
		let requestStatus: "success" | "failed" | "cancelled" = "failed";
		let accumulatedResult = "";

		const historyForGemini =
			history && history.length > 0
				? this.transformHistoryForGemini(history as HistoryEntry[])
				: undefined;

		const currentUserContentPartsForGemini = userContentParts
			.map((part) => {
				if ("text" in part && part.text !== undefined) {
					return { text: part.text };
				} else if ("inlineData" in part) {
					return { inlineData: part.inlineData };
				}
				return { text: "" }; // Fallback
			})
			.filter(
				(part) =>
					("text" in part && (part as { text: string }).text.length > 0) ||
					"inlineData" in part,
			); // Ensure valid parts

		const requestContentsForGemini: Content[] = [
			...(historyForGemini || []),
			{ role: "user", parts: currentUserContentPartsForGemini },
		];

		const userMessageTextForContext = userContentParts
			.filter((part): part is { text: string } => "text" in part)
			.map((part) => part.text)
			.join(" ");
		let totalInputTextForContext = userMessageTextForContext;
		if (historyForGemini && historyForGemini.length > 0) {
			const historyTextParts = historyForGemini
				.map((entry) =>
					entry.parts.map((p) => ("text" in p ? p.text : "")).join(" "),
				)
				.join(" ");
			totalInputTextForContext =
				historyTextParts + " " + userMessageTextForContext;
		}

		let finalInputTokensPerAttempt = 0;
		if (this.tokenTrackingService && currentApiKey) {
			try {
				finalInputTokensPerAttempt = await this.raceWithCancellation(
					countGeminiTokens(currentApiKey, modelName, requestContentsForGemini),
					token,
				);
				console.log(
					`[AIRequestService] Accurately counted ${finalInputTokensPerAttempt} input tokens for model ${modelName}.`,
				);
			} catch (e) {
				if ((e as Error).message === ERROR_OPERATION_CANCELLED) {
					throw e;
				}
				console.warn(
					`[AIRequestService] Failed to get accurate input token count from Gemini API (${modelName}), falling back to estimate. Error:`,
					e,
				);
				finalInputTokensPerAttempt = this.tokenTrackingService.estimateTokens(
					totalInputTextForContext,
				);
			}
		}

		try {
			while (true) {
				if (token?.isCancellationRequested) {
					requestStatus = "cancelled";
					throw new Error(ERROR_OPERATION_CANCELLED);
				}

				totalInputTokensConsumed += finalInputTokensPerAttempt;

				console.log(
					`[AIRequestService] Attempt with key ...${currentApiKey.slice(
						-4,
					)} for ${requestType}. (Total input tokens so far: ${totalInputTokensConsumed})`,
				);

				accumulatedResult = "";
				try {
					if (!currentApiKey) {
						throw new Error("API Key became invalid during retry loop.");
					}

					const stream = generateContentStream(
						currentApiKey,
						modelName,
						requestContentsForGemini,
						generationConfig,
						token,
						isMergeOperation,
						systemInstruction,
					);

					let chunkCount = 0;
					for await (const chunk of stream) {
						if (token?.isCancellationRequested) {
							throw new Error(ERROR_OPERATION_CANCELLED);
						}
						accumulatedResult += chunk;
						chunkCount++;

						if (this.tokenTrackingService && chunkCount % 10 === 0) {
							// Update real-time estimates
							this.tokenTrackingService.getRealTimeTokenEstimates(
								totalInputTextForContext,
								accumulatedResult,
							);
							this.tokenTrackingService.triggerRealTimeUpdate();
						}

						if (streamCallbacks?.onChunk) {
							await streamCallbacks.onChunk(chunk);
						}
					}

					// Accurately count and track output tokens after the response is complete
					if (this.tokenTrackingService && currentApiKey) {
						try {
							finalOutputTokensCount = await this.raceWithCancellation(
								countGeminiTokens(currentApiKey, modelName, [
									{ role: "model", parts: [{ text: accumulatedResult }] },
								]),
								token,
							);
							console.log(
								`[AIRequestService] Accurately counted ${finalOutputTokensCount} output tokens for model ${modelName}.`,
							);
						} catch (e) {
							if ((e as Error).message === ERROR_OPERATION_CANCELLED) {
								throw e;
							}
							console.warn(
								`[AIRequestService] Failed to get accurate output token count from Gemini API (${modelName}), falling back to estimate. Error:`,
								e,
							);
							finalOutputTokensCount =
								this.tokenTrackingService.estimateTokens(accumulatedResult);
						}
					}

					requestStatus = "success";
					if (streamCallbacks?.onComplete) {
						streamCallbacks.onComplete();
					}
					consecutiveTransientErrorCount = 0;
					return accumulatedResult;
				} catch (error: unknown) {
					const err = error as Error;
					const errorMessage = err.message;

					if (errorMessage === ERROR_OPERATION_CANCELLED) {
						requestStatus = "cancelled";
						throw err;
					}

					if (
						errorMessage === ERROR_QUOTA_EXCEEDED ||
						errorMessage === ERROR_SERVICE_UNAVAILABLE
					) {
						const isQuotaError = errorMessage === ERROR_QUOTA_EXCEEDED;
						const transientReason = isQuotaError
							? "Quota/Rate limit hit"
							: "Service temporarily unavailable";
						const displayReason = isQuotaError
							? "API Quota Exceeded. Retrying automatically."
							: "AI Service Unavailable. Retrying automatically.";

						const currentDelay = Math.min(
							maxDelayMs,
							baseDelayMs * 2 ** consecutiveTransientErrorCount,
						);
						console.warn(
							`[AIRequestService] ${transientReason} for key ...${currentApiKey?.slice(
								-4,
							)}. Pausing for ${(currentDelay / 1000).toFixed(0)} seconds.`,
						);
						this.postMessageToWebview({
							type: "aiRetryNotification",
							value: {
								currentDelay: currentDelay / 1000,
								reason: displayReason,
							},
						});

						try {
							await new Promise<void>((resolve, reject) => {
								if (!token) {
									setTimeout(resolve, currentDelay);
									return;
								}
								if (token.isCancellationRequested) {
									reject(new Error(ERROR_OPERATION_CANCELLED));
									return;
								}

								const timer = setTimeout(() => {
									cancellationListener.dispose();
									resolve();
								}, currentDelay);

								const cancellationListener = token.onCancellationRequested(
									() => {
										clearTimeout(timer);
										cancellationListener.dispose();
										reject(new Error(ERROR_OPERATION_CANCELLED));
									},
								);
							});
						} catch (delayError: any) {
							if (delayError.message === ERROR_OPERATION_CANCELLED) {
								requestStatus = "cancelled";
								throw delayError;
							}
							throw delayError;
						}

						consecutiveTransientErrorCount++;
						continue;
					} else {
						requestStatus = "failed";
						throw err;
					}
				}
			}
		} finally {
			// Final token tracking for the overall request context
			if (this.tokenTrackingService && totalInputTokensConsumed > 0) {
				// If not already set via accurate count, estimate output tokens from whatever we accumulated
				if (requestStatus !== "success" || finalOutputTokensCount === 0) {
					finalOutputTokensCount =
						this.tokenTrackingService.estimateTokens(accumulatedResult);
				}

				this.tokenTrackingService.trackTokenUsage(
					totalInputTokensConsumed,
					finalOutputTokensCount,
					requestType,
					modelName,
					totalInputTextForContext.length > 1000
						? totalInputTextForContext.substring(0, 1000) + "..."
						: totalInputTextForContext,
					requestStatus,
				);
			}

			if (
				(requestStatus === "cancelled" || requestStatus === "failed") &&
				streamCallbacks?.onComplete
			) {
				streamCallbacks.onComplete();
			}
		}
	}

	/**
	 * Execute multiple AI requests in parallel with concurrency control
	 */
	public async generateMultipleInParallel(
		requests: Array<{
			id: string;
			userContentParts: HistoryEntryPart[];
			modelName: string;
			history?: readonly HistoryEntry[];
			generationConfig?: GenerationConfig;
			priority?: number;
		}>,
		config: {
			maxConcurrency?: number;
			timeout?: number;
			retries?: number;
		} = {},
		token?: vscode.CancellationToken,
	): Promise<Map<string, ParallelTaskResult<string>>> {
		const tasks: ParallelTask<string>[] = requests.map((request) => ({
			id: request.id,
			task: () =>
				this.generateWithRetry(
					request.userContentParts,
					request.modelName,
					request.history,
					`parallel-${request.id}`,
					request.generationConfig,
					undefined,
					token,
					false,
				),
			priority: request.priority ?? 0,
			timeout: config.timeout,
			retries: config.retries,
		}));

		return ParallelProcessor.executeParallel(tasks, {
			maxConcurrency: config.maxConcurrency ?? 3, // Limit concurrent AI requests
			defaultTimeout: config.timeout ?? 60000,
			defaultRetries: config.retries ?? 1,
			enableRetries: true,
			enableTimeout: true,
			cancellationToken: token,
		});
	}

	/**
	 * Process multiple files in parallel with AI analysis
	 */
	public async processFilesInParallel<T>(
		files: vscode.Uri[],
		processor: (file: vscode.Uri) => Promise<T>,
		config: {
			maxConcurrency?: number;
			timeout?: number;
			retries?: number;
		} = {},
		token?: vscode.CancellationToken,
	): Promise<Map<string, ParallelTaskResult<T>>> {
		return ParallelProcessor.processFilesInParallel(files, processor, {
			maxConcurrency: config.maxConcurrency ?? 4,
			defaultTimeout: config.timeout ?? 30000,
			defaultRetries: config.retries ?? 2,
			enableRetries: true,
			enableTimeout: true,
			cancellationToken: token,
		});
	}

	/**
	 * Execute AI requests in batches to manage memory and API limits
	 */
	public async generateInBatches(
		requests: Array<{
			id: string;
			userContentParts: HistoryEntryPart[];
			modelName: string;
			history?: readonly HistoryEntry[];
			generationConfig?: GenerationConfig;
			priority?: number;
		}>,
		batchSize: number = 5,
		config: {
			maxConcurrency?: number;
			timeout?: number;
			retries?: number;
		} = {},
		token?: vscode.CancellationToken,
	): Promise<Map<string, ParallelTaskResult<string>>> {
		const tasks: ParallelTask<string>[] = requests.map((request) => ({
			id: request.id,
			task: () =>
				this.generateWithRetry(
					request.userContentParts,
					request.modelName,
					request.history,
					`batch-${request.id}`,
					request.generationConfig,
					undefined,
					token,
					false,
				),
			priority: request.priority ?? 0,
			timeout: config.timeout,
			retries: config.retries,
		}));

		return ParallelProcessor.executeInBatches(tasks, batchSize, {
			maxConcurrency: config.maxConcurrency ?? 3,
			defaultTimeout: config.timeout ?? 60000,
			defaultRetries: config.retries ?? 1,
			enableRetries: true,
			enableTimeout: true,
			cancellationToken: token,
		});
	}

	/**
	 * Handles a simple text prompt completion request using the robust retry mechanism.
	 * This is typically used by internal services like PlanExecutionService for general reasoning tasks.
	 */
	public async requestCompletion(
		prompt: string,
		model: string,
		token: vscode.CancellationToken,
	): Promise<{ content: string }> {
		const result = await this.generateWithRetry(
			[{ text: prompt }], // userContentParts: [{ text: string }]
			model,
			undefined, // history
			"completion_request", // requestType
			undefined, // generationConfig
			undefined, // streamCallbacks (no streaming needed for simple completion)
			token,
			false, // isMergeOperation
			undefined, // systemInstruction
		);

		return { content: result };
	}

	/**
	 * Generates a function call response from the AI based on provided content and tools.
	 * It includes cancellation token support to abort long-running requests.
	 * @param apiKey The API key to use for the request.
	 * @param modelName The name of the AI model to use (e.g., 'gemini-pro').
	 * @param contents An array of `Content` objects representing the conversation history or prompt.
	 * @param tools An array of `Tool` objects defining the functions the model can call.
	 * @param functionCallingMode An optional `FunctionCallingMode` to specify how function calls are handled (e.g., "AUTO", "NONE", "ANY").
	 * @param token An optional `CancellationToken` to signal if the operation should be cancelled.
	 * @param contextString A descriptive string for the token tracking event, defaults to 'function_call'.
	 * @returns A Promise that resolves to a `FunctionCall` object, or rejects if the operation is cancelled or an error occurs.
	 */
	public async generateFunctionCall(
		apiKey: string,
		modelName: string,
		contents: Content[],
		tools: Tool[],
		functionCallingMode?: FunctionCallingMode,
		token?: vscode.CancellationToken,
		contextString: string = "function_call", // New parameter with default value
	): Promise<{ functionCall: FunctionCall | null; thought?: string }> {
		if (token?.isCancellationRequested) {
			console.log(
				"[AIRequestService] Function call generation cancelled at start.",
			);
			throw new Error(gemini.ERROR_OPERATION_CANCELLED);
		}

		let inputTokensCount = 0;
		let outputTokensCount = 0;
		let status: "success" | "failed" | "cancelled" = "failed";
		let result: { functionCall: FunctionCall | null; thought?: string } = {
			functionCall: null,
		};

		// Prepare input text for context string and token estimation
		const contentsText = contents
			.map((content) =>
				content.parts
					.map((part) => ("text" in part ? part.text : ""))
					.join(" "),
			)
			.join(" ");
		const inputContextForTracking =
			contentsText.length > 1000
				? contentsText.substring(0, 1000) + "..."
				: contentsText;

		try {
			// 1. Count input tokens
			try {
				inputTokensCount = await this.raceWithCancellation(
					gemini.countGeminiTokens(apiKey, modelName, contents),
					token,
				);
			} catch (e) {
				if ((e as Error).message === ERROR_OPERATION_CANCELLED) {
					status = "cancelled";
					throw e;
				}
				console.warn(
					`[AIRequestService] Failed to get accurate input token count for function call (${modelName}), falling back to estimate.`,
					e,
				);
				inputTokensCount =
					this.tokenTrackingService.estimateTokens(contentsText);
			}

			// 2. Generate function call with cancellation support
			result = await this.raceWithCancellation(
				gemini.generateFunctionCall(
					apiKey,
					modelName,
					contents,
					tools,
					functionCallingMode,
				),
				token,
			);

			if (result.functionCall === null && !result.thought) {
				status = "success"; // Successfully got a null response (no tool needed)
				return result;
			}

			// Convert functionCall to string for output token estimation/counting
			const functionCallString = JSON.stringify({
				name: result.functionCall?.name,
				args: result.functionCall?.args,
				thought: result.thought,
			});

			// 3. Count output tokens
			try {
				outputTokensCount = await this.raceWithCancellation(
					gemini.countGeminiTokens(apiKey, modelName, [
						{ role: "model", parts: [{ text: functionCallString }] },
					]),
					token,
				);
			} catch (e) {
				if ((e as Error).message === ERROR_OPERATION_CANCELLED) {
					status = "cancelled";
					throw e;
				}
				outputTokensCount =
					this.tokenTrackingService.estimateTokens(functionCallString);
			}

			status = "success";
			return result;
		} catch (error: any) {
			if (error.message === ERROR_OPERATION_CANCELLED) {
				status = "cancelled";
			} else {
				status = "failed";
			}
			throw error;
		} finally {
			if (this.tokenTrackingService && inputTokensCount > 0) {
				this.tokenTrackingService.trackTokenUsage(
					inputTokensCount,
					outputTokensCount,
					contextString,
					modelName,
					inputContextForTracking,
					status,
				);
			}
		}
	}

	/**
	 * Generates a function call response using the internally managed API key.
	 * Wraps generateFunctionCall with key retrieval.
	 */
	public async generateManagedFunctionCall(
		modelName: string,
		contents: Content[],
		tools: Tool[],
		functionCallingMode?: FunctionCallingMode,
		token?: vscode.CancellationToken,
		contextString: string = "function_call",
	): Promise<{ functionCall: FunctionCall | null; thought?: string }> {
		const apiKey = this.apiKeyManager.getActiveApiKey();
		if (!apiKey) {
			throw new Error("No API Key available.");
		}

		// We could add retry logic here similar to generateWithRetry if needed in the future
		return this.generateFunctionCall(
			apiKey,
			modelName,
			contents,
			tools,
			functionCallingMode,
			token,
			contextString,
		);
	}
}
