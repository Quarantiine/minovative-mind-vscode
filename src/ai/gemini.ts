import * as vscode from "vscode";
import {
	GoogleGenerativeAI,
	GenerativeModel,
	Content,
	GenerationConfig,
	Tool,
	FunctionCall,
	FunctionCallingMode, // Added FunctionCallingMode import
} from "@google/generative-ai";
import { MINO_SYSTEM_INSTRUCTION } from "./prompts/systemInstructions";
import { geminiLogger } from "../utils/logger";

export const ERROR_QUOTA_EXCEEDED = "ERROR_GEMINI_QUOTA_EXCEEDED";
// Define a specific error message constant for cancellation
export const ERROR_OPERATION_CANCELLED = "Operation cancelled by user.";
// Add a new error constant for service unavailability
export const ERROR_SERVICE_UNAVAILABLE = "ERROR_GEMINI_SERVICE_UNAVAILABLE";
// Add a new error constant for stream parsing failures
export const ERROR_STREAM_PARSING_FAILED = "ERROR_GEMINI_STREAM_PARSING_FAILED";

let generativeAI: GoogleGenerativeAI | null = null;
let model: GenerativeModel | null = null;
let currentApiKey: string | null = null;
let currentModelName: string | null = null;
let currentToolsHash: string | null = null; // New module-level variable for tools hash

/**
 * Creates a truncated log string for content parts, useful for logging API requests without exposing full content.
 * @param contents The array of Content objects to truncate.
 * @returns A truncated string representation of the contents.
 */
function _getTruncatedContentsLog(contents: Content[]): string {
	return contents
		.map((c) =>
			c.parts
				.map((p) =>
					"text" in p
						? (p as { text: string }).text.substring(0, 50) +
						  ((p as { text: string }).text.length > 50 ? "..." : "")
						: "[IMAGE]"
				)
				.join(" ")
		)
		.join(" | ");
}

/**
 * Handles common Gemini API errors, centralizing logging and specific error re-throws.
 *
 * @param error The raw error object caught from a Gemini API call.
 * @param modelName The name of the model being used.
 * @param contextString A string describing the context of the error (e.g., "stream generation").
 * @param shouldResetClient If true, resets the client for API key/model not found errors.
 */
function _handleGeminiError(
	error: any,
	modelName: string,
	contextString: string,
	shouldResetClient: boolean
): never {
	geminiLogger.error(
		modelName,
		`Raw error during ${contextString}:`,
		error,
		error instanceof Error ? error.stack : ""
	);

	if (error instanceof Error && error.message === ERROR_OPERATION_CANCELLED) {
		throw error;
	}

	const lowerErrorMessage = (error.message || "").toLowerCase();
	const status = error.httpGoogleError?.code || error.status;

	if (lowerErrorMessage.includes("quota") || status === 429) {
		throw new Error(ERROR_QUOTA_EXCEEDED);
	} else if (lowerErrorMessage.includes("failed to parse stream")) {
		geminiLogger.error(
			modelName,
			`Stream parsing failed. Error: ${error.message}`
		);
		throw new Error(ERROR_STREAM_PARSING_FAILED);
	} else if (
		lowerErrorMessage.includes("api key not valid") ||
		status === 400
	) {
		const errorMessage = `Invalid API Key for Gemini model ${modelName}. Please verify your key.`;
		geminiLogger.error(modelName, errorMessage);
		if (shouldResetClient) {
			resetClient();
		}
		throw new Error(errorMessage);
	} else if (lowerErrorMessage.includes("model not found") || status === 404) {
		const errorMessage = `The model '${modelName}' is not valid or accessible.`;
		geminiLogger.error(modelName, errorMessage);
		if (shouldResetClient) {
			resetClient();
		}
		throw new Error(errorMessage);
	} else if (
		status === 503 ||
		status === 403 ||
		lowerErrorMessage.includes("service unavailable")
	) {
		throw new Error(ERROR_SERVICE_UNAVAILABLE);
	} else {
		throw new Error(
			`Gemini (${modelName}) error during ${contextString}: ${
				error.message || String(error)
			}`
		);
	}
}

/**
 * Initializes the GoogleGenerativeAI client and the GenerativeModel if needed.
 * Re-initializes if the API key, model name, or tools configuration changes.
 *
 * @param apiKey The Google Gemini API key.
 * @param modelName The specific Gemini model name to use (e.g., "gemini-2.5-pro-latest").
 * @param tools Optional array of tools to configure the model with.
 * @returns True if initialization was successful or already initialized correctly, false otherwise.
 */
export function initializeGenerativeAI(
	apiKey: string,
	modelName: string,
	tools?: Tool[]
): boolean {
	geminiLogger.log(
		modelName,
		`[gemini.ts] initializeGenerativeAI called with modelName: ${modelName}`
	);
	geminiLogger.log(
		modelName,
		`Attempting to initialize GoogleGenerativeAI with model: ${modelName}...`
	);
	try {
		if (!apiKey) {
			geminiLogger.error(modelName, "API Key is missing.");
			if (model) {
				resetClient();
			}
			return false;
		}
		if (!modelName) {
			geminiLogger.error(modelName, "Model Name is missing.");
			if (model) {
				resetClient();
			}
			return false;
		}

		const newToolsHash = tools ? JSON.stringify(tools) : null;

		const needsInitialization =
			!generativeAI ||
			!model ||
			apiKey !== currentApiKey ||
			modelName !== currentModelName ||
			newToolsHash !== currentToolsHash; // Include tools hash in initialization check

		if (needsInitialization) {
			geminiLogger.log(
				modelName,
				`Re-initializing client. Key changed: ${
					apiKey !== currentApiKey
				}, Model changed: ${modelName !== currentModelName}, Tools changed: ${
					newToolsHash !== currentToolsHash
				}. New model: ${modelName}`
			);
			generativeAI = new GoogleGenerativeAI(apiKey);
			model = generativeAI.getGenerativeModel({
				model: modelName,
				tools: tools,
				systemInstruction: MINO_SYSTEM_INSTRUCTION,
			});
			currentApiKey = apiKey;
			currentModelName = modelName;
			currentToolsHash = newToolsHash; // Update tools hash after successful initialization
			geminiLogger.log(
				modelName,
				`[gemini.ts] currentModelName set to: ${currentModelName}`
			);
			geminiLogger.log(
				modelName,
				"GoogleGenerativeAI initialized successfully."
			);
		} else {
			geminiLogger.log(
				modelName,
				"Client already initialized with correct settings."
			);
		}
		return true;
	} catch (error) {
		geminiLogger.error(
			modelName,
			"Error initializing GoogleGenerativeAI:",
			error,
			error instanceof Error ? error.stack : ""
		);
		vscode.window.showErrorMessage(
			`Failed to initialize Gemini AI (${modelName}): ${
				error instanceof Error ? error.message : String(error)
			}`
		);
		resetClient();
		return false;
	}
}

/**
 * Generates content as an asynchronous stream using the initialized Gemini model.
 *
 * @param apiKey The API key.
 * @param modelName The specific Gemini model name to use.
 * @param contents The content array for the Gemini model.
 * @param generationConfig Optional configuration for this generation request (e.g., for JSON mode).
 * @param token Optional cancellation token from VS Code.
 * @param isMergeOperation Optional boolean, true if this generation is for a merge conflict resolution.
 * @returns An AsyncIterableIterator yielding generated text chunks.
 */
export async function* generateContentStream(
	apiKey: string,
	modelName: string,
	contents: Content[],
	generationConfig?: GenerationConfig,
	token?: vscode.CancellationToken,
	isMergeOperation: boolean = false
): AsyncIterableIterator<string> {
	if (token?.isCancellationRequested) {
		geminiLogger.log(
			modelName,
			"Cancellation requested before starting stream generation."
		);
		throw new Error(ERROR_OPERATION_CANCELLED);
	}

	if (!initializeGenerativeAI(apiKey, modelName)) {
		throw new Error(
			`Gemini AI client not initialized. Please check API key and selected model (${modelName}).`
		);
	}
	if (!model) {
		throw new Error(
			`Gemini model (${modelName}) is not available after initialization attempt.`
		);
	}

	// This is now valid after updating the @google/generative-ai package.
	const requestConfig = {
		...generationConfig,
		thinkingConfig: {
			thinkingBudget: -1,
		},
	};

	let contentYielded = false;

	try {
		const truncatedContentsLog = _getTruncatedContentsLog(contents);
		geminiLogger.log(
			modelName,
			`Sending stream request. Contents: "${truncatedContentsLog}"`
		);
		geminiLogger.log(
			modelName,
			`Using generationConfig: ${JSON.stringify(requestConfig)}`
		);
		if (isMergeOperation) {
			geminiLogger.log(modelName, `This is a merge operation.`);
		}
		geminiLogger.log(
			modelName,
			`[gemini.ts] generateContentStream using currentModelName: ${currentModelName}`
		);
		const result = await model.generateContentStream({
			contents: contents,
			generationConfig: requestConfig,
		});

		for await (const chunk of result.stream) {
			if (token?.isCancellationRequested) {
				geminiLogger.log(modelName, "Cancellation requested during streaming.");
				throw new Error(ERROR_OPERATION_CANCELLED);
			}

			const text = chunk.text();
			if (text && text.length > 0) {
				contentYielded = true;
				const truncatedChunk =
					text.length > 50 ? `${text.substring(0, 50)}...` : text;
				geminiLogger.log(modelName, `Received chunk: "${truncatedChunk}"`);
				yield text;
			}
		}

		geminiLogger.log(modelName, `Stream finished.`);
		const finalResponse = await result.response;

		if (finalResponse.promptFeedback?.blockReason) {
			const { blockReason, safetyRatings } = finalResponse.promptFeedback;
			const message = `Gemini (${modelName}) request blocked. Reason: ${blockReason}. Ratings: ${JSON.stringify(
				safetyRatings
			)}`;
			if (!contentYielded) {
				geminiLogger.error(modelName, message);
				throw new Error(`Request blocked by Gemini (reason: ${blockReason}).`);
			} else {
				geminiLogger.warn(modelName, `${message} (partially yielded)`);
			}
		}

		const candidate = finalResponse.candidates?.[0];
		if (candidate) {
			const { finishReason, safetyRatings } = candidate;
			if (
				finishReason &&
				finishReason !== "STOP" &&
				finishReason !== "MAX_TOKENS"
			) {
				const message = `Gemini (${modelName}) stream finished unexpectedly. Reason: ${finishReason}. Ratings: ${JSON.stringify(
					safetyRatings
				)}`;
				if (!contentYielded) {
					geminiLogger.error(modelName, message);
					throw new Error(
						`Gemini stream stopped prematurely (reason: ${finishReason}).`
					);
				} else {
					geminiLogger.warn(modelName, `${message} (partially yielded)`);
				}
			}
		} else if (!contentYielded && !finalResponse.promptFeedback?.blockReason) {
			geminiLogger.warn(
				modelName,
				`Stream ended without yielding content or a block reason.`
			);
		}
	} catch (error: any) {
		_handleGeminiError(error, modelName, "stream generation", true);
	}
}

/**
 * Generates content and attempts to extract a function call.
 *
 * @param apiKey The Google Gemini API key.
 * @param modelName The specific Gemini model name to use.
 * @param contents The content array for the Gemini model.
 * @param tools Array of tools to configure the model with for function calling.
 * @param functionCallingMode Optional: Specifies the function calling mode (e.g., "AUTO", "NONE", "ANY").
 * @returns The extracted FunctionCall object or null if not present.
 */
export async function generateFunctionCall(
	apiKey: string,
	modelName: string,
	contents: Content[],
	tools: Tool[],
	functionCallingMode?: FunctionCallingMode // Modified function signature
): Promise<FunctionCall | null> {
	geminiLogger.log(modelName, `Attempting to generate function call.`);

	if (!initializeGenerativeAI(apiKey, modelName, tools)) {
		throw new Error(
			`Gemini AI client not initialized for function call generation. Please check API key, selected model (${modelName}), and tools.`
		);
	}
	if (!model) {
		throw new Error(
			`Gemini model (${modelName}) is not available after initialization attempt for function call.`
		);
	}

	try {
		const requestOptions: {
			contents: Content[];
			tools: Tool[];
			toolConfig?: {
				functionCallingConfig: {
					mode: FunctionCallingMode;
				};
			};
		} = {
			contents: contents,
			tools: tools,
		};

		// Add toolConfig with functionCallingConfig.mode if functionCallingMode is provided
		if (functionCallingMode) {
			requestOptions.toolConfig = {
				functionCallingConfig: {
					mode: functionCallingMode,
				},
			};
		}
		geminiLogger.log(
			modelName,
			`[gemini.ts] generateFunctionCall using currentModelName: ${currentModelName}`
		);
		const result = await model.generateContent(requestOptions); // Modified call
		const response = result.response;

		if (response.promptFeedback?.blockReason) {
			const { blockReason, safetyRatings } = response.promptFeedback;
			geminiLogger.error(
				modelName,
				`Function call request blocked. Reason: ${blockReason}. Ratings: ${JSON.stringify(
					safetyRatings
				)}`
			);
			throw new Error(`Request blocked by Gemini (reason: ${blockReason}).`);
		}

		const functionCall =
			response.candidates?.[0]?.content?.parts?.[0]?.functionCall;

		if (functionCall) {
			geminiLogger.log(
				modelName,
				`Successfully received function call:`,
				functionCall
			);
			return functionCall;
		} else {
			geminiLogger.warn(
				modelName,
				`No function call found in the response. Full response:`,
				response
			);
			return null;
		}
	} catch (error: any) {
		_handleGeminiError(error, modelName, "function call", true);
	}
}

/**
 * Resets the client state.
 */
export function resetClient() {
	generativeAI = null;
	model = null;
	currentApiKey = null;
	currentModelName = null;
	currentToolsHash = null; // Reset tools hash on client reset
	geminiLogger.log(undefined, "AI client state has been reset.");
}

/**
 * Accurately counts tokens using the Gemini API's countTokens method.
 * It ensures the Gemini model client is initialized for the given API key and model.
 *
 * @param apiKey The API key to use.
 * @param modelName The name of the model (e.g., 'gemini-2.5-pro').
 * @param contents The content array for the Gemini model.
 * @returns The total token count.
 */
export async function countGeminiTokens(
	apiKey: string,
	modelName: string,
	contents: Content[]
): Promise<number> {
	// Ensure the generative AI client and model are initialized for the given key and model name.
	// This function internally sets the global 'model' variable if needed.
	if (!initializeGenerativeAI(apiKey, modelName)) {
		throw new Error(
			`Gemini AI client not initialized for token counting. Please check API key and selected model (${modelName}).`
		);
	}
	if (!model) {
		// This check is a safeguard, as initializeGenerativeAI should ensure 'model' is set upon success.
		throw new Error(
			`Gemini model (${modelName}) is not available after initialization attempt for token counting.`
		);
	}

	try {
		geminiLogger.log(
			modelName,
			`[Gemini Token Counter] Requesting token count for model '${modelName}'...`
		);
		const { totalTokens } = await model.countTokens({
			contents: contents,
		});
		geminiLogger.log(
			modelName,
			`[Gemini Token Counter] Successfully counted ${totalTokens} tokens for model '${modelName}'.`
		);
		return totalTokens;
	} catch (error) {
		_handleGeminiError(error, modelName, "token counting", true);
	}
}
