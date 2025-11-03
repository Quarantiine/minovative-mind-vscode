import * as vscode from "vscode";
import {
	Content,
	GenerationConfig,
	FunctionCall,
	Tool,
	FunctionCallingMode,
} from "@google/generative-ai";
import { ApiKeyManager } from "../sidebar/managers/apiKeyManager";
import { HistoryEntry, HistoryEntryPart } from "../sidebar/common/sidebarTypes";
import * as gemini from "../ai/gemini";
import {
	ERROR_OPERATION_CANCELLED,
	ERROR_QUOTA_EXCEEDED,
	generateContentStream,
	countGeminiTokens,
} from "../ai/gemini";
import {
	ParallelProcessor,
	ParallelTask,
	ParallelTaskResult,
} from "../utils/parallelProcessor";
import { TokenTrackingService } from "./tokenTrackingService";

export class AIRequestService {
	constructor(
		private apiKeyManager: ApiKeyManager,
		private postMessageToWebview: (message: any) => void,
		private tokenTrackingService: TokenTrackingService // Made tokenTrackingService a required dependency
	) {}

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
		isMergeOperation: boolean = false
	): Promise<string> {
		let currentApiKey = this.apiKeyManager.getActiveApiKey();

		if (!currentApiKey) {
			return `Error: No API Key available. Please add an API key in the settings.`;
		}

		let consecutiveTransientErrorCount = 0;
		const baseDelayMs = 15000;
		const maxDelayMs = 10 * 60 * 1000;

		// Initialize these variables at the top of generateWithRetry
		let finalInputTokens = 0;
		let finalOutputTokens = 0; // Initialize here for broader scope

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
					"inlineData" in part
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
					entry.parts.map((p) => ("text" in p ? p.text : "")).join(" ")
				)
				.join(" ");
			totalInputTextForContext =
				historyTextParts + " " + userMessageTextForContext;
		}

		if (this.tokenTrackingService && currentApiKey) {
			try {
				finalInputTokens = await countGeminiTokens(
					currentApiKey,
					modelName,
					requestContentsForGemini
				);
				console.log(
					`[AIRequestService] Accurately counted ${finalInputTokens} input tokens for model ${modelName}.`
				);
			} catch (e) {
				console.warn(
					`[AIRequestService] Failed to get accurate input token count from Gemini API (${modelName}), falling back to estimate. Error:`,
					e
				);
				finalInputTokens = this.tokenTrackingService.estimateTokens(
					totalInputTextForContext
				);
				console.log(
					`[AIRequestService] Estimated ${finalInputTokens} input tokens using heuristic for model ${modelName}.`
				);
			}
		}

		while (true) {
			if (token?.isCancellationRequested) {
				console.log(
					"[AIRequestService] Cancellation requested at start of retry loop."
				);
				if (streamCallbacks?.onComplete) {
					streamCallbacks.onComplete();
				}
				throw new Error(ERROR_OPERATION_CANCELLED);
			}

			console.log(
				`[AIRequestService] Attempt with key ...${currentApiKey.slice(
					-4
				)} for ${requestType}.`
			);

			let accumulatedResult = "";
			try {
				if (!currentApiKey) {
					throw new Error("API Key became invalid during retry loop.");
				}

				// The requestContents for generateContentStream is implicitly built inside gemini.ts
				// by combining 'prompt' and 'history'.
				const stream = generateContentStream(
					currentApiKey,
					modelName,
					requestContentsForGemini,
					generationConfig,
					token,
					isMergeOperation
				);

				let chunkCount = 0;
				for await (const chunk of stream) {
					if (token?.isCancellationRequested) {
						throw new Error(ERROR_OPERATION_CANCELLED);
					}
					accumulatedResult += chunk;
					chunkCount++;

					// Maintain Real-time Streaming Token Estimates:
					// This block remains, as it uses the heuristic for performance during streaming.
					// Update: Use totalInputTextForContext for more accurate real-time input estimation.
					if (this.tokenTrackingService && chunkCount % 10 === 0) {
						const estimates =
							this.tokenTrackingService.getRealTimeTokenEstimates(
								totalInputTextForContext, // <-- Use the prepared full input context here
								accumulatedResult
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
						// Update call to countGeminiTokens to pass only the output text for output token count
						finalOutputTokens = await countGeminiTokens(
							currentApiKey,
							modelName,
							[{ role: "model", parts: [{ text: accumulatedResult }] }]
						);
						console.log(
							`[AIRequestService] Accurately counted ${finalOutputTokens} output tokens for model ${modelName}.`
						);
					} catch (e) {
						console.warn(
							`[AIRequestService] Failed to get accurate output token count from Gemini API (${modelName}), falling back to estimate. Error:`,
							e
						);
						finalOutputTokens =
							this.tokenTrackingService.estimateTokens(accumulatedResult);
						console.log(
							`[AIRequestService] Estimated ${finalOutputTokens} output tokens using heuristic for model ${modelName}.`
						);
					}

					console.log(
						`[AIRequestService] generateWithRetry: Tracking usage for model: ${modelName}, requestType: ${requestType}`
					);
					// Update the trackTokenUsage call with the accurately counted tokens
					this.tokenTrackingService.trackTokenUsage(
						finalInputTokens, // Use the accurately counted input tokens
						finalOutputTokens, // Use the accurately counted output tokens
						requestType,
						modelName,
						totalInputTextForContext.length > 1000
							? totalInputTextForContext.substring(0, 1000) + "..."
							: totalInputTextForContext
					);
				}

				if (streamCallbacks?.onComplete) {
					streamCallbacks.onComplete();
				}
				consecutiveTransientErrorCount = 0; // Reset counter on success
				return accumulatedResult; // Success: return immediately
			} catch (error: unknown) {
				const err = error as Error;
				const errorMessage = err.message;

				if (errorMessage === ERROR_OPERATION_CANCELLED) {
					console.log(
						"[AIRequestService] Operation cancelled from underlying AI stream."
					);
					if (streamCallbacks?.onComplete) {
						streamCallbacks.onComplete();
					}
					throw err; // Re-throw cancellation immediately, do NOT retry
				}

				if (errorMessage === ERROR_QUOTA_EXCEEDED) {
					const currentDelay = Math.min(
						maxDelayMs,
						baseDelayMs * 2 ** consecutiveTransientErrorCount
					);
					console.warn(
						`[AIRequestService] Quota/Rate limit hit for key ...${currentApiKey?.slice(
							-4
						)}. Pausing for ${(currentDelay / 1000).toFixed(0)} seconds.`
					);
					// Dispatch new aiRetryNotification message
					this.postMessageToWebview({
						type: "aiRetryNotification",
						value: {
							currentDelay: currentDelay / 1000, // Convert to seconds for UI
							reason: "API Quota Exceeded. Retrying automatically.",
						},
					});

					// Await a cancellable delay
					await new Promise<void>((resolve) => {
						if (!token) {
							setTimeout(resolve, currentDelay);
							return;
						}

						const timer = setTimeout(() => {
							cancellationListener.dispose();
							resolve();
						}, currentDelay);

						const cancellationListener = token.onCancellationRequested(() => {
							clearTimeout(timer);
							cancellationListener.dispose();
							resolve(); // Resolve immediately to allow cancellation check to fire
						});
					});

					if (token?.isCancellationRequested) {
						console.log(
							"[AIRequestService] Operation cancelled during quota backoff delay."
						);
						if (streamCallbacks?.onComplete) {
							streamCallbacks.onComplete();
						}
						throw new Error(ERROR_OPERATION_CANCELLED);
					}
					consecutiveTransientErrorCount++;
					continue;
				} else {
					// For other errors, re-throw to allow higher-level handlers to manage them.
					if (streamCallbacks?.onComplete) {
						streamCallbacks.onComplete();
					}
					throw err;
				}
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
		token?: vscode.CancellationToken
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
					false
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
		token?: vscode.CancellationToken
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
		token?: vscode.CancellationToken
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
					false
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
		contextString: string = "function_call" // New parameter with default value
	): Promise<FunctionCall> {
		if (token?.isCancellationRequested) {
			console.log(
				"[AIRequestService] Function call generation cancelled at start."
			);
			throw new Error(gemini.ERROR_OPERATION_CANCELLED);
		}

		let inputTokens = 0;
		let outputTokens = 0;

		// Prepare input text for context string and token estimation
		const contentsText = contents
			.map((content) =>
				content.parts.map((part) => ("text" in part ? part.text : "")).join(" ")
			)
			.join(" ");
		const inputContextForTracking =
			contentsText.length > 1000
				? contentsText.substring(0, 1000) + "..."
				: contentsText;

		// 1. Count input tokens
		try {
			inputTokens = await gemini.countGeminiTokens(apiKey, modelName, contents);
			console.log(
				`[AIRequestService] Accurately counted ${inputTokens} input tokens for function call (${modelName}).`
			);
		} catch (e) {
			console.warn(
				`[AIRequestService] Failed to get accurate input token count from Gemini API for function call (${modelName}), falling back to estimate. Error:`,
				e
			);
			inputTokens = this.tokenTrackingService.estimateTokens(contentsText);
			console.log(
				`[AIRequestService] Estimated ${inputTokens} input tokens using heuristic for function call (${modelName}).`
			);
		}

		const functionCall = await gemini.generateFunctionCall(
			apiKey,
			modelName,
			contents,
			tools,
			functionCallingMode
		);

		if (functionCall === null) {
			console.log(
				`[AIRequestService] generateFunctionCall: Tracking usage for model: ${modelName}, contextString: ${contextString}`
			);
			// Track usage even on error if possible, but output tokens would be 0
			this.tokenTrackingService.trackTokenUsage(
				inputTokens,
				0, // 0 output tokens on null response
				contextString,
				modelName,
				inputContextForTracking
			);
			throw new Error(
				`AI response did not contain a valid function call for model ${modelName}`
			);
		}

		// Convert functionCall to string for output token estimation
		const functionCallString = JSON.stringify({
			name: functionCall.name,
			args: functionCall.args,
		});

		// 2. Count output tokens
		try {
			outputTokens = await gemini.countGeminiTokens(apiKey, modelName, [
				{ role: "model", parts: [{ text: functionCallString }] },
			]);
			console.log(
				`[AIRequestService] Accurately counted ${outputTokens} output tokens for function call (${modelName}).`
			);
		} catch (e) {
			console.warn(
				`[AIRequestService] Failed to get accurate output token count from Gemini API for function call (${modelName}), falling back to estimate. Error:`,
				e
			);
			outputTokens =
				this.tokenTrackingService.estimateTokens(functionCallString);
			console.log(
				`[AIRequestService] Estimated ${outputTokens} output tokens using heuristic for function call (${modelName}).`
			);
		}

		console.log(
			`[AIRequestService] generateFunctionCall: Tracking usage for model: ${modelName}, contextString: ${contextString}`
		);
		// 3. Track token usage
		this.tokenTrackingService.trackTokenUsage(
			inputTokens,
			outputTokens,
			contextString,
			modelName,
			inputContextForTracking // Use the truncated input context for tracking
		);

		if (token?.isCancellationRequested) {
			console.log(
				"[AIRequestService] Function call generation cancelled after response."
			);
			throw new Error(gemini.ERROR_OPERATION_CANCELLED);
		}

		return functionCall;
	}
}
