import * as vscode from "vscode";
import * as path from "path";
import type { GenerationConfig } from "@google/generative-ai";
import {
	HistoryEntry,
	PlanGenerationContext,
} from "../sidebar/common/sidebarTypes";
import { TEMPERATURE } from "../sidebar/common/sidebarConstants";
import * as SymbolService from "../services/symbolService";
import { ActiveSymbolDetailedInfo } from "../services/contextService";
import { SafeCommandExecutor } from "./safeCommandExecutor";
import { AIRequestService } from "../services/aiRequestService";
import {
	Tool,
	Content,
	FunctionCall,
	SchemaType,
	FunctionCallingMode,
} from "@google/generative-ai";

const MAX_FILE_SUMMARY_LENGTH_FOR_AI_SELECTION = 10000;
export { MAX_FILE_SUMMARY_LENGTH_FOR_AI_SELECTION };

/**
 * Represents a file selection with optional line range constraints.
 * Used for chunked/targeted file reading to reduce context size.
 */
export interface FileSelection {
	uri: vscode.Uri;
	startLine?: number; // 1-indexed, inclusive
	endLine?: number; // 1-indexed, inclusive
}

/**
 * Parses a file path that may contain a line range suffix.
 * Format: "filepath:startLine-endLine" or "filepath:line" or just "filepath"
 * Examples:
 *   "src/auth.ts:10-50" -> { path: "src/auth.ts", startLine: 10, endLine: 50 }
 *   "src/auth.ts:42" -> { path: "src/auth.ts", startLine: 42, endLine: 42 }
 *   "src/auth.ts" -> { path: "src/auth.ts", startLine: undefined, endLine: undefined }
 */
function parseLineRange(pathWithRange: string): {
	path: string;
	startLine?: number;
	endLine?: number;
} {
	// Match patterns like "file.ts:10-50" or "file.ts:42"
	const rangeMatch = pathWithRange.match(/^(.+):(\d+)(?:-(\d+))?$/);
	if (rangeMatch) {
		const [, filePath, startStr, endStr] = rangeMatch;
		const startLine = parseInt(startStr, 10);
		const endLine = endStr ? parseInt(endStr, 10) : startLine;
		return { path: filePath, startLine, endLine };
	}
	return { path: pathWithRange, startLine: undefined, endLine: undefined };
}

// Cache interface for AI selection results
interface AISelectionCache {
	timestamp: number;
	selectedFiles: vscode.Uri[];
	userRequest: string;
	activeFile?: string;
	fileCount: number;
	heuristicFilesCount: number;
}

// Cache storage
const aiSelectionCache = new Map<string, AISelectionCache>();

// Configuration for AI selection
interface AISelectionOptions {
	useCache?: boolean;
	cacheTimeout?: number;
	maxPromptLength?: number;
	enableStreaming?: boolean;
	fallbackToHeuristics?: boolean;
	alwaysRunInvestigation?: boolean;
}

export interface SelectRelevantFilesAIOptions {
	userRequest: string;
	chatHistory: ReadonlyArray<HistoryEntry>;
	allScannedFiles: ReadonlyArray<vscode.Uri>;
	projectRoot: vscode.Uri;
	activeEditorContext?: PlanGenerationContext["editorContext"];
	diagnostics?: string;
	fileDependencies?: Map<string, string[]>;
	activeEditorSymbols?: vscode.DocumentSymbol[];
	preSelectedHeuristicFiles?: vscode.Uri[];
	fileSummaries?: Map<string, string>;
	activeSymbolDetailedInfo?: ActiveSymbolDetailedInfo;
	aiModelCall?: (
		prompt: string,
		modelName: string,
		history: HistoryEntry[] | undefined,
		requestType: string,
		generationConfig: GenerationConfig | undefined,
		streamCallbacks:
			| {
					onChunk: (chunk: string) => Promise<void> | void;
					onComplete?: () => void;
			  }
			| undefined,
		token: vscode.CancellationToken | undefined
	) => Promise<string>;
	aiRequestService?: AIRequestService; // New: Pass service for tool calls
	postMessageToWebview?: (message: any) => void; // New: For logging to chat
	addContextAgentLogToHistory?: (logText: string) => void; // For persisting logs to history
	modelName: string;
	cancellationToken?: vscode.CancellationToken;
	selectionOptions?: AISelectionOptions; // Selection options
}

/**
 * Generate cache key for AI selection
 */
function generateAISelectionCacheKey(
	userRequest: string,
	allScannedFiles: ReadonlyArray<vscode.Uri>,
	activeEditorContext?: PlanGenerationContext["editorContext"],
	preSelectedHeuristicFiles?: vscode.Uri[]
): string {
	const activeFile = activeEditorContext?.filePath || "";
	const heuristicFiles =
		preSelectedHeuristicFiles
			?.map((f) => f.fsPath)
			.sort()
			.join("|") || "";
	const fileCount = allScannedFiles.length;

	// Create a hash-like key from the request and context
	const keyComponents = [
		userRequest.substring(0, 100), // First 100 chars of request
		activeFile,
		heuristicFiles,
		fileCount.toString(),
	];

	return keyComponents.join("|");
}

/**
 * Truncate and optimize prompt for better performance
 */
function optimizePrompt(
	contextPrompt: string,
	dependencyInfo: string,
	fileListString: string,
	maxLength: number = 50000
): string {
	let totalLength =
		contextPrompt.length + dependencyInfo.length + fileListString.length;

	if (totalLength <= maxLength) {
		return contextPrompt + dependencyInfo + fileListString;
	}

	// Smart truncation strategy
	const targetLength = maxLength - 2000; // Leave room for instructions

	// Prioritize context prompt (most important)
	let optimizedContext = contextPrompt;
	let optimizedDependency = dependencyInfo;
	let optimizedFileList = fileListString;

	// If still too long, truncate file list (least important for selection)
	if (totalLength > targetLength) {
		const fileListLines = fileListString.split("\n");
		const maxFileLines = Math.floor(
			(targetLength - contextPrompt.length - dependencyInfo.length) / 100
		);

		if (fileListLines.length > maxFileLines) {
			optimizedFileList =
				fileListLines.slice(0, maxFileLines).join("\n") +
				`\n... and ${fileListLines.length - maxFileLines} more files`;
		}
	}

	// If still too long, truncate dependency info
	if (
		optimizedContext.length +
			optimizedDependency.length +
			optimizedFileList.length >
		targetLength
	) {
		const maxDependencyLength =
			targetLength - optimizedContext.length - optimizedFileList.length;
		if (optimizedDependency.length > maxDependencyLength) {
			optimizedDependency =
				optimizedDependency.substring(0, maxDependencyLength) +
				"...(truncated)";
		}
	}

	return optimizedContext + optimizedDependency + optimizedFileList;
}

/**
 * Uses an AI model to select the most relevant files for a given user request and context.
 * Now includes caching, better prompt optimization, and performance improvements.
 */
export async function selectRelevantFilesAI(
	options: SelectRelevantFilesAIOptions
): Promise<vscode.Uri[]> {
	const {
		userRequest,
		allScannedFiles,
		projectRoot,
		activeEditorContext,
		diagnostics,
		preSelectedHeuristicFiles,
		fileSummaries,
		activeSymbolDetailedInfo,
		aiModelCall,
		modelName,
		cancellationToken,
		selectionOptions,
		aiRequestService,
		postMessageToWebview,
		addContextAgentLogToHistory,
	} = options;

	if (allScannedFiles.length === 0) {
		return [];
	}

	// Check cache first
	const useCache = selectionOptions?.useCache ?? true;
	const cacheTimeout = selectionOptions?.cacheTimeout ?? 10 * 60 * 1000; // 10 minutes default

	if (useCache) {
		const cacheKey = generateAISelectionCacheKey(
			userRequest,
			allScannedFiles,
			activeEditorContext,
			preSelectedHeuristicFiles
		);

		const cached = aiSelectionCache.get(cacheKey);
		if (cached && Date.now() - cached.timestamp < cacheTimeout) {
			console.log(
				`Using cached AI selection results for request: ${userRequest.substring(
					0,
					50
				)}...`
			);
			return cached.selectedFiles;
		}
	}

	const relativeFilePaths = allScannedFiles.map((uri) =>
		path.relative(projectRoot.fsPath, uri.fsPath).replace(/\\/g, "/")
	);

	let contextPrompt = `User Request: "${userRequest}"\n`;

	if (preSelectedHeuristicFiles && preSelectedHeuristicFiles.length > 0) {
		const heuristicPaths = preSelectedHeuristicFiles.map((uri) =>
			path.relative(projectRoot.fsPath, uri.fsPath).replace(/\\/g, "/")
		);
		contextPrompt += `\nHeuristically Pre-selected Files (strong candidates, but critically evaluate them): ${heuristicPaths.join(
			", "
		)}\n`;
	}

	if (activeEditorContext) {
		const relativeActiveFilePath = path
			.relative(projectRoot.fsPath, activeEditorContext.filePath)
			.replace(/\\/g, "/");
		contextPrompt += `\nActive File: ${relativeActiveFilePath}\n`;
		if (activeEditorContext.selectedText?.trim()) {
			contextPrompt += `Selected Text: "${activeEditorContext.selectedText.substring(
				0,
				200
			)}"\n`;
		}
	}

	if (activeSymbolDetailedInfo?.name) {
		contextPrompt += `\n--- Active Symbol Detailed Information (Primary Context) ---\n`;
		contextPrompt += `Symbol: "${activeSymbolDetailedInfo.name}" (Type: ${
			activeSymbolDetailedInfo.kind !== undefined
				? activeSymbolDetailedInfo.kind
				: "Unknown"
		})\n`;

		const getRelativePath = (uri: vscode.Uri) =>
			path.relative(projectRoot.fsPath, uri.fsPath).replace(/\\/g, "/");
		const addPathsToPrompt = (label: string, uris: vscode.Uri[]) => {
			const uniquePaths = [...new Set(uris.map(getRelativePath))];
			if (uniquePaths.length > 0) {
				contextPrompt += `${label}: ${uniquePaths.slice(0, 10).join(", ")}\n`;
			}
		};

		if (activeSymbolDetailedInfo.definition) {
			const defUris = Array.isArray(activeSymbolDetailedInfo.definition)
				? activeSymbolDetailedInfo.definition.map((d) => d.uri)
				: [activeSymbolDetailedInfo.definition.uri];
			addPathsToPrompt("Definition in", defUris);
		}
		if (activeSymbolDetailedInfo.implementations) {
			addPathsToPrompt(
				"Implementations in",
				activeSymbolDetailedInfo.implementations.map((i) => i.uri)
			);
		}
		if (activeSymbolDetailedInfo.incomingCalls) {
			addPathsToPrompt(
				"Incoming calls from",
				activeSymbolDetailedInfo.incomingCalls.map((c) => c.from.uri)
			);
		}
		if (activeSymbolDetailedInfo.outgoingCalls) {
			addPathsToPrompt(
				"Outgoing calls to",
				activeSymbolDetailedInfo.outgoingCalls.map((c) => c.to.uri)
			);
		}
		if (
			activeSymbolDetailedInfo.referencedTypeDefinitions &&
			activeSymbolDetailedInfo.referencedTypeDefinitions.size > 0
		) {
			const typeDefPaths = [
				...activeSymbolDetailedInfo.referencedTypeDefinitions.keys(),
			].slice(0, 10);
			if (typeDefPaths.length > 0) {
				contextPrompt += `References types defined in: ${typeDefPaths.join(
					", "
				)}\n`;
			}
		}
		contextPrompt += `--- End Active Symbol Information ---\n`;
	}

	const alwaysRunInvestigation =
		selectionOptions?.alwaysRunInvestigation ?? false;

	// When investigation mode is enabled, only show top-level directories
	// since the AI can explore the structure using terminal commands
	let fileListString: string;
	if (alwaysRunInvestigation) {
		// Extract unique top-level directories from relative file paths
		const topLevelDirs = new Set<string>();
		relativeFilePaths.forEach((p) => {
			const firstSegment = p.split("/")[0];
			// Only add if it looks like a directory (contains files deeper)
			if (p.includes("/")) {
				topLevelDirs.add(firstSegment + "/");
			} else {
				// Root-level files
				topLevelDirs.add(firstSegment);
			}
		});

		fileListString =
			"--- Project Structure (Top-Level) ---\n" +
			"Use `ls` or `find` to explore subdirectories.\n" +
			Array.from(topLevelDirs)
				.sort()
				.map((d) => `- ${d}`)
				.join("\n");
	} else {
		// Standard mode: list all files with optional summaries
		fileListString =
			"--- Available Project Files ---\n" +
			relativeFilePaths
				.map((p) => {
					const summary = fileSummaries?.get(p);
					return `- "${p}"${
						summary
							? ` (Summary: ${summary
									.substring(0, 200)
									.replace(/\s+/g, " ")}...)`
							: ""
					}`;
				})
				.join("\n");
	}

	// Detect if the user request appears to be about fixing an error
	const errorKeywords =
		/\b(error|bug|fix|issue|exception|crash|fail|broken|undefined|null|cannot|warning|problem)\b/i;
	const isLikelyErrorRequest = errorKeywords.test(userRequest);

	// Build diagnostics context if available
	let diagnosticsContext = "";
	if (diagnostics && diagnostics.trim().length > 0) {
		diagnosticsContext = `\n--- VS Code Diagnostics (Errors/Warnings) ---\n${diagnostics.substring(
			0,
			2000
		)}\n--- End Diagnostics ---\n`;
	}

	// Build investigation instruction based on context
	let investigationInstruction: string;
	if (alwaysRunInvestigation || isLikelyErrorRequest) {
		investigationInstruction = `2.  **Investigate (REQUIRED)**: You MUST run at least one \`run_terminal_command\` to explore the codebase before selecting files. This is especially important for error-fixing requests.
    *   **ERROR DETECTION TIP**: If the user mentions an error, extract file paths, function names, or error messages and use \`grep\` to find them.
    *   **Example**: Error says \"Cannot read property 'foo' of undefined in authService.ts:42\". Run \`cat src/services/authService.ts\` or \`grep -n "foo" src/\` to investigate.`;
	} else {
		investigationInstruction =
			"2.  **Investigate (Optional)**: If the 'Available Project Files' list is not enough, or if you need to find specific code patterns, USE THE `run_terminal_command` tool.";
	}

	const selectionPrompt = `
You are an expert AI developer assistant. Your task is to select the most relevant files to help with a user's request.

-- Context --
${contextPrompt}${diagnosticsContext}
-- End Context --

${fileListString}

-- Instructions --
1.  **Analyze the Goal**: Understand the user's request and the provided context.${
		isLikelyErrorRequest
			? " This appears to be an ERROR-FIXING request - prioritize investigation!"
			: ""
	}
${investigationInstruction}
    *   Example: User asks "Where is the auth logic?". You can run \`grep -r "auth" src/\` to find it.
    *   Example: User asks "Fix the login bug". You run \`grep -r "login" .\`
3.  **Select**: Once you have identified the files, call \`finish_selection\` with the list of file paths.
    *   **LINE RANGES (OPTIONAL)**: To save tokens, you can specify line ranges: \`filepath:startLine-endLine\`
    *   Example: \`src/auth.ts:40-80\` returns only lines 40-80. \`src/auth.ts:42\` returns just line 42.
    *   Use line ranges when you've identified specific code sections via \`grep -n\` or \`cat\`.
4.  **Constraint**: Return ONLY the function call. Do not return markdown text.
`.trim();

	console.log(
		`[SmartContextSelector] Sending prompt to AI for file selection (${selectionPrompt.length} chars)`
	);

	try {
		// --- AGENTIC LOOP ---
		// 1. Define Tools
		const tools: Tool[] = [
			{
				functionDeclarations: [
					{
						name: "run_terminal_command",
						description:
							"Execute a safe terminal command (ls, grep, find, cat, git grep) to investigate the codebase. Use this to find files relevant to the user request. Returns stdout/stderr.",
						parameters: {
							type: SchemaType.OBJECT,
							properties: {
								command: {
									type: SchemaType.STRING,
									description:
										"The terminal command to execute. Must be one of: ls, grep, find, cat, git grep. No pipes/chaining allowed.",
								},
							},
							required: ["command"],
						},
					},
					{
						name: "finish_selection",
						description:
							"Call this when you have found all relevant file paths. Supports optional line ranges (e.g., 'file.ts:10-50' for lines 10-50, 'file.ts:42' for line 42 only). Returns the final list.",
						parameters: {
							type: SchemaType.OBJECT,
							properties: {
								selectedFiles: {
									type: SchemaType.ARRAY,
									description:
										"JSON Array of file paths. Supports line ranges: 'path/file.ts' (full file), 'path/file.ts:10-50' (lines 10-50), 'path/file.ts:42' (line 42 only)",
									items: { type: SchemaType.STRING },
								},
							},
							required: ["selectedFiles"],
						},
					},
				],
			},
		];

		// 2. Run Loop if Service Available
		if (aiRequestService) {
			console.log(`[SmartContextSelector] Starting Agentic Selection Loop`);
			if (postMessageToWebview) {
				postMessageToWebview({
					type: "setContextAgentLoading",
					value: true,
				});
			}

			let currentHistory: Content[] = [
				{
					role: "user",
					parts: [{ text: selectionPrompt }],
				},
			];

			const MAX_TURNS = 5;

			for (let turn = 0; turn < MAX_TURNS; turn++) {
				if (cancellationToken?.isCancellationRequested) break;

				// Generate
				let functionCall: FunctionCall;
				try {
					functionCall = await aiRequestService.generateManagedFunctionCall(
						modelName,
						currentHistory,
						tools,
						FunctionCallingMode.AUTO,
						cancellationToken,
						"context_agent_turn"
					);
				} catch (e) {
					console.warn(
						`[SmartContextSelector] Agentic loop error: ${(e as Error).message}`
					);
					break;
				}

				// Handle
				if (functionCall.name === "finish_selection") {
					console.log(
						`[SmartContextSelector] Agent finished selection used tool.`
					);
					const args = functionCall.args as any;
					const selectedPaths = args["selectedFiles"];
					const result = _processSelectedPaths(
						selectedPaths,
						allScannedFiles,
						projectRoot,
						relativeFilePaths,
						activeEditorContext
					);
					// Extract URIs for backward compatibility (line ranges preserved in result)
					const resultUris = _extractUrisFromSelections(result);

					// Cache result
					if (useCache) {
						const cacheKey = generateAISelectionCacheKey(
							userRequest,
							allScannedFiles,
							activeEditorContext,
							preSelectedHeuristicFiles
						);
						aiSelectionCache.set(cacheKey, {
							timestamp: Date.now(),
							selectedFiles: resultUris,
							userRequest,
							activeFile: activeEditorContext?.filePath,
							fileCount: allScannedFiles.length,
							heuristicFilesCount: preSelectedHeuristicFiles?.length || 0,
						});
					}
					if (postMessageToWebview) {
						postMessageToWebview({
							type: "setContextAgentLoading",
							value: false,
						});
					}
					return resultUris;
				} else if (functionCall.name === "run_terminal_command") {
					const args = functionCall.args as any;
					const command = args["command"] as string;

					// Log to Chat
					const commandLogText = `Running \`${command}\`...`;
					if (postMessageToWebview) {
						postMessageToWebview({
							type: "contextAgentLog",
							value: {
								text: commandLogText,
							},
						});
					}
					if (addContextAgentLogToHistory) {
						addContextAgentLogToHistory(commandLogText);
					}

					// Execute
					let output = "";
					try {
						output = await SafeCommandExecutor.execute(
							command,
							projectRoot.fsPath
						);
					} catch (e: any) {
						output = `Error: ${e.message}`;
					}

					// Log output to chat
					const displayOutput =
						output.length > 200 ? output.substring(0, 200) + "..." : output;
					const outputLogText = `\`\`\`\n${displayOutput}\n\`\`\``;
					if (postMessageToWebview) {
						postMessageToWebview({
							type: "contextAgentLog",
							value: {
								text: outputLogText,
							},
						});
					}
					if (addContextAgentLogToHistory) {
						addContextAgentLogToHistory(outputLogText);
					}

					// Update History
					currentHistory.push({
						role: "model",
						parts: [{ functionCall: functionCall }],
					});
					currentHistory.push({
						role: "function",
						parts: [
							{
								functionResponse: {
									name: "run_terminal_command",
									response: { result: output.substring(0, 10000) }, // Truncate for prompt limit
								},
							},
						],
					});
				} else {
					console.warn(
						`[SmartContextSelector] Unknown tool: ${functionCall.name}`
					);
					break;
				}
			}
			if (postMessageToWebview) {
				postMessageToWebview({
					type: "setContextAgentLoading",
					value: false,
				});
			}
			console.log(
				`[SmartContextSelector] Agentic loop finished without selection, falling back.`
			);
		}

		// --- Fallback / Legacy Logic ---
		if (!aiModelCall) {
			throw new Error("No AI model call function provided.");
		}

		console.warn(
			"[SmartContextSelector] Agentic Selection not available or failed. Falling back to simple prompt."
		);

		const generationConfig: GenerationConfig = {
			temperature: TEMPERATURE,
			responseMimeType: "application/json",
		};

		// Simple prompt for legacy/fallback
		const legacyPrompt = `
You are an expert AI developer assistant. Your task is to select the most relevant files to help with a user's request.

-- Context --
${contextPrompt}
-- End Context --

${fileListString}

-- Instructions --
1. Analyze the user request.
2. Select files from the list.
3. Return ONLY a JSON array of strings.

JSON Array of selected file paths:
`.trim();

		const aiResponse = await aiModelCall(
			legacyPrompt,
			modelName,
			undefined,
			"file_selection",
			generationConfig,
			undefined,
			cancellationToken
		);

		console.log(
			"[SmartContextSelector] AI response for file selection (Legacy):",
			aiResponse
		);

		const selectedPaths = JSON.parse(aiResponse.trim());
		const result = _processSelectedPaths(
			selectedPaths,
			allScannedFiles,
			projectRoot,
			relativeFilePaths,
			activeEditorContext
		);
		// Extract URIs for backward compatibility
		const resultUris = _extractUrisFromSelections(result);

		// Cache result for legacy path too
		if (useCache) {
			const cacheKey = generateAISelectionCacheKey(
				userRequest,
				allScannedFiles,
				activeEditorContext,
				preSelectedHeuristicFiles
			);
			aiSelectionCache.set(cacheKey, {
				timestamp: Date.now(),
				selectedFiles: resultUris,
				userRequest,
				activeFile: activeEditorContext?.filePath,
				fileCount: allScannedFiles.length,
				heuristicFilesCount: preSelectedHeuristicFiles?.length || 0,
			});
		}

		return resultUris;
	} catch (error) {
		console.error(
			"[SmartContextSelector] Error during AI file selection:",
			error
		);
		// Fallback to heuristics + active file on any error
		const fallbackFiles = new Set(preSelectedHeuristicFiles || []);
		if (activeEditorContext?.documentUri) {
			fallbackFiles.add(activeEditorContext.documentUri);
		}
		return Array.from(fallbackFiles);
	}
}

// Helper function to process selected paths with optional line range support
function _processSelectedPaths(
	selectedPaths: any,
	allScannedFiles: readonly vscode.Uri[],
	projectRoot: vscode.Uri,
	relativeFilePaths: string[],
	activeEditorContext: any
): FileSelection[] {
	if (
		!Array.isArray(selectedPaths) ||
		!selectedPaths.every((p) => typeof p === "string")
	) {
		throw new Error("AI did not return a valid JSON array of strings.");
	}

	const projectFileSet = new Set(relativeFilePaths.map((p) => p.toLowerCase()));
	const finalSelections = new Map<string, FileSelection>(); // Use map to dedupe by fsPath

	// Add AI selected files with optional line ranges
	for (const selectedPath of selectedPaths as string[]) {
		const { path: filePath, startLine, endLine } = parseLineRange(selectedPath);
		const normalizedPath = filePath.replace(/\\/g, "/");

		if (projectFileSet.has(normalizedPath.toLowerCase())) {
			const originalUri = allScannedFiles.find(
				(uri) =>
					path
						.relative(projectRoot.fsPath, uri.fsPath)
						.replace(/\\/g, "/")
						.toLowerCase() === normalizedPath.toLowerCase()
			);
			if (originalUri) {
				const existingSelection = finalSelections.get(originalUri.fsPath);
				if (existingSelection) {
					// If file already selected, expand the range to include both
					// (This handles cases where AI selects overlapping ranges)
					if (startLine && endLine) {
						existingSelection.startLine = existingSelection.startLine
							? Math.min(existingSelection.startLine, startLine)
							: startLine;
						existingSelection.endLine = existingSelection.endLine
							? Math.max(existingSelection.endLine, endLine)
							: endLine;
					}
				} else {
					finalSelections.set(originalUri.fsPath, {
						uri: originalUri,
						startLine,
						endLine,
					});
				}
			}
		}
	}

	let finalResultSelections = Array.from(finalSelections.values());

	// Always include the active file if it exists (full file, not chunked)
	if (
		activeEditorContext?.documentUri &&
		!finalResultSelections.some(
			(sel) => sel.uri.fsPath === activeEditorContext.documentUri.fsPath
		)
	) {
		finalResultSelections.unshift({
			uri: activeEditorContext.documentUri,
			startLine: undefined,
			endLine: undefined,
		});
	}

	return finalResultSelections;
}

// Backward compatibility wrapper: extracts just URIs from FileSelection[]
function _extractUrisFromSelections(selections: FileSelection[]): vscode.Uri[] {
	return selections.map((sel) => sel.uri);
}

/**
 * Clear AI selection cache for a specific workspace or all workspaces
 */
export function clearAISelectionCache(workspacePath?: string): void {
	if (workspacePath) {
		// Clear entries for this workspace
		for (const [key, cache] of aiSelectionCache.entries()) {
			if (key.includes(workspacePath)) {
				aiSelectionCache.delete(key);
			}
		}
		console.log(`Cleared AI selection cache for: ${workspacePath}`);
	} else {
		aiSelectionCache.clear();
		console.log("Cleared all AI selection caches");
	}
}

/**
 * Get AI selection cache statistics
 */
export function getAISelectionCacheStats(): {
	size: number;
	entries: Array<{
		request: string;
		age: number;
		fileCount: number;
		selectedCount: number;
		heuristicCount: number;
	}>;
} {
	const entries = Array.from(aiSelectionCache.entries()).map(
		([key, cache]) => ({
			request: cache.userRequest.substring(0, 50) + "...",
			age: Date.now() - cache.timestamp,
			fileCount: cache.fileCount,
			selectedCount: cache.selectedFiles.length,
			heuristicCount: cache.heuristicFilesCount,
		})
	);

	return {
		size: aiSelectionCache.size,
		entries,
	};
}
