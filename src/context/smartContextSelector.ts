import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
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
import {
	gatherProjectConfigContext,
	formatProjectConfigForPrompt,
} from "./configContextProvider";

const MAX_FILE_SUMMARY_LENGTH_FOR_AI_SELECTION = 10000;
export { MAX_FILE_SUMMARY_LENGTH_FOR_AI_SELECTION };

/**
 * Represents a file selection with optional line range constraints.
 * Used for chunked/targeted file reading to reduce context size.
 */
/**
 * Represents a file selection with optional line range constraints.
 * Used for chunked/targeted file reading to reduce context size.
 */
export interface FileSelection {
	uri: vscode.Uri;
	startLine?: number; // 1-indexed, inclusive
	endLine?: number; // 1-indexed, inclusive
	symbolName?: string; // Optional symbol name to resolve range for
}

/**
 * Parses a file path that may contain a line range suffix.
 * Format: "filepath:startLine-endLine" or "filepath:line" or just "filepath"
 * Examples:
 *   "src/auth.ts:10-50" -> { path: "src/auth.ts", startLine: 10, endLine: 50 }
 *   "src/auth.ts:42" -> { path: "src/auth.ts", startLine: 42, endLine: 42 }
 *   "src/auth.ts" -> { path: "src/auth.ts", startLine: undefined, endLine: undefined }
 */
/**
 * Parses a file path that may contain a line range or symbol suffix.
 * Format: "filepath:startLine-endLine", "filepath:line", "filepath#symbol"
 */
function parseFileSelector(pathWithSelector: string): {
	path: string;
	startLine?: number;
	endLine?: number;
	symbolName?: string;
} {
	// 1. Check for Symbol: "file.ts#symbolName"
	const symbolMatch = pathWithSelector.match(/^(.+)#(.+)$/);
	if (symbolMatch) {
		return {
			path: symbolMatch[1],
			symbolName: symbolMatch[2],
			startLine: undefined,
			endLine: undefined,
		};
	}

	// 2. Check for Line Range: "file.ts:10-50" or "file.ts:42"
	const rangeMatch = pathWithSelector.match(/^(.+):(\d+)(?:-(\d+))?$/);
	if (rangeMatch) {
		const [, filePath, startStr, endStr] = rangeMatch;
		const startLine = parseInt(startStr, 10);
		const endLine = endStr ? parseInt(endStr, 10) : startLine;
		return { path: filePath, startLine, endLine };
	}

	// 3. Default: Just file path
	return { path: pathWithSelector, startLine: undefined, endLine: undefined };
}

// Cache interface for AI selection results
interface AISelectionCache {
	timestamp: number;
	selectedFiles: FileSelection[];
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
	reverseDependencies?: Map<string, string[]>; // Files that import each file
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
		token: vscode.CancellationToken | undefined,
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
	preSelectedHeuristicFiles?: vscode.Uri[],
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
	maxLength: number = 50000,
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
			(targetLength - contextPrompt.length - dependencyInfo.length) / 100,
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
 * Builds an optimized project structure string.
 * If the file list is small, it shows everything.
 * If large, it shows top-level directories and important/root files, forcing the agent to explore.
 */
function buildOptimizedProjectStructure(
	relativeFilePaths: string[],
	fileSummaries: Map<string, string> | undefined,
	heuristicPathSet: Set<string>,
	fileDependencies: Map<string, string[]> | undefined,
	reverseDependencies: Map<string, string[]> | undefined,
	forceOptimization: boolean,
): { fileListString: string; isTruncated: boolean } {
	const fileCount = relativeFilePaths.length;
	const FILE_LIST_THRESHOLD = 10; // Threshold to switch to optimized view

	if (forceOptimization || fileCount > FILE_LIST_THRESHOLD) {
		// Optimized Mode: Show top-level structure + heuristic/root files
		const topLevelDirs = new Set<string>();
		const importantFiles = new Set<string>();

		relativeFilePaths.forEach((p) => {
			// Always include pre-selected heuristic files
			if (heuristicPathSet.has(p)) {
				importantFiles.add(p);
				return;
			}

			// Always include root-level configuration/readme files
			if (!p.includes("/")) {
				importantFiles.add(p);
				return;
			}

			// Group others into directories
			const firstSegment = p.split("/")[0];
			topLevelDirs.add(firstSegment + "/");
		});

		let output = "--- Project Structure (Optimized View) ---\n";
		output += `Total Files: ${fileCount}\n`;
		output +=
			"Note: To save context, this view is TRUNCATED. It shows only top-level directories and important root files.\n";
		output +=
			"YOU MUST USE `run_terminal_command` (ls -R, find) TO DISCOVER SPECIFIC FILES IN SUBDIRECTORIES.\n\n";

		output += "--- Top-Level Directories ---\n";
		if (topLevelDirs.size > 0) {
			output +=
				Array.from(topLevelDirs)
					.sort()
					.map((d) => `- ${d} (contains files)`)
					.join("\n") + "\n";
		} else {
			output += "(None)\n";
		}

		output += "\n--- Root & Important Files ---\n";
		output +=
			Array.from(importantFiles)
				.sort()
				.map((p) => {
					// Add summary if available
					const summary = fileSummaries?.get(p);
					let fileEntry = `- "${p}"`;
					if (summary) {
						fileEntry += ` (${summary
							.substring(0, 100)
							.replace(/\s+/g, " ")}...)`;
					}

					// Add relationships only for relevant files to reduce noise
					if (heuristicPathSet.has(p)) {
						const imports = fileDependencies?.get(p);
						const importedBy = reverseDependencies?.get(p);

						if (imports && imports.length > 0) {
							const importList = imports
								.slice(0, 3)
								.map((i) => path.basename(i))
								.join(", ");
							fileEntry += `\n    ↳ imports: ${importList}${
								imports.length > 3 ? "..." : ""
							}`;
						}
						if (importedBy && importedBy.length > 0) {
							const importedByList = importedBy
								.slice(0, 3)
								.map((i) => path.basename(i))
								.join(", ");
							fileEntry += `\n    ↳ imported by: ${importedByList}${
								importedBy.length > 3 ? "..." : ""
							}`;
						}
					}
					return fileEntry;
				})
				.join("\n") + "\n";

		return { fileListString: output, isTruncated: true };
	} else {
		// Standard Mode: Full file list
		const output =
			"--- Available Project Files ---\n" +
			relativeFilePaths
				.map((p) => {
					const summary = fileSummaries?.get(p);
					let fileEntry = `- "${p}"`;

					// Add summary if available
					if (summary) {
						fileEntry += ` (${summary
							.substring(0, 150)
							.replace(/\s+/g, " ")}...)`;
					}

					// Add relationship info for heuristic files (most relevant)
					if (heuristicPathSet.has(p)) {
						const imports = fileDependencies?.get(p);
						const importedBy = reverseDependencies?.get(p);

						if (imports && imports.length > 0) {
							const importList = imports
								.slice(0, 5)
								.map((i) => path.basename(i))
								.join(", ");
							const moreCount =
								imports.length > 5 ? ` +${imports.length - 5} more` : "";
							fileEntry += `\n    ↳ imports: ${importList}${moreCount}`;
						}

						if (importedBy && importedBy.length > 0) {
							const importedByList = importedBy
								.slice(0, 3)
								.map((i) => path.basename(i))
								.join(", ");
							const moreCount =
								importedBy.length > 3 ? ` +${importedBy.length - 3} more` : "";
							fileEntry += `\n    ↳ imported by: ${importedByList}${moreCount}`;
						}
					}

					return fileEntry;
				})
				.join("\n");

		return { fileListString: output, isTruncated: false };
	}
}

/**
 * Uses an AI model to select the most relevant files for a given user request and context.
 * Now includes caching, better prompt optimization, and performance improvements.
 */
export async function selectRelevantFilesAI(
	options: SelectRelevantFilesAIOptions,
): Promise<FileSelection[]> {
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
			preSelectedHeuristicFiles,
		);

		const cached = aiSelectionCache.get(cacheKey);
		if (cached && Date.now() - cached.timestamp < cacheTimeout) {
			console.log(
				`Using cached AI selection results for request: ${userRequest.substring(
					0,
					50,
				)}...`,
			);
			if (postMessageToWebview) {
				postMessageToWebview({
					type: "contextAgentLog",
					value: {
						text: `[Context Agent] Using cached context analysis for this request.`,
					},
				});
				// Also simulate the loading state toggle for consistent UX
				postMessageToWebview({
					type: "setContextAgentLoading",
					value: true,
				});
				setTimeout(() => {
					postMessageToWebview({
						type: "setContextAgentLoading",
						value: false,
					});
				}, 600);
			}
			return cached.selectedFiles;
		}
	}

	const relativeFilePaths = allScannedFiles.map((uri) =>
		path.relative(projectRoot.fsPath, uri.fsPath).replace(/\\/g, "/"),
	);

	// Start logging for visibility
	if (postMessageToWebview) {
		postMessageToWebview({
			type: "setContextAgentLoading",
			value: true,
		});
		postMessageToWebview({
			type: "contextAgentLog",
			value: {
				text: `[Context Agent] Analysis started for: "${userRequest.substring(
					0,
					50,
				)}..."`,
			},
		});
	}

	// Gather project configuration context
	const projectConfig = await gatherProjectConfigContext(projectRoot);
	const projectConfigPrompt = formatProjectConfigForPrompt(projectConfig);

	let contextPrompt = `User Request: "${userRequest}"\n`;

	// Add project configuration context if available
	if (projectConfigPrompt) {
		contextPrompt += `\n${projectConfigPrompt}\n`;
	}

	if (preSelectedHeuristicFiles && preSelectedHeuristicFiles.length > 0) {
		const heuristicPaths = preSelectedHeuristicFiles.map((uri) =>
			path.relative(projectRoot.fsPath, uri.fsPath).replace(/\\/g, "/"),
		);
		contextPrompt += `\nHeuristically Pre-selected Files (strong candidates, but critically evaluate them): ${heuristicPaths.join(
			", ",
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
				200,
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
				activeSymbolDetailedInfo.implementations.map((i) => i.uri),
			);
		}
		if (activeSymbolDetailedInfo.incomingCalls) {
			addPathsToPrompt(
				"Incoming calls from",
				activeSymbolDetailedInfo.incomingCalls.map((c) => c.from.uri),
			);
		}
		if (activeSymbolDetailedInfo.outgoingCalls) {
			addPathsToPrompt(
				"Outgoing calls to",
				activeSymbolDetailedInfo.outgoingCalls.map((c) => c.to.uri),
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
					", ",
				)}\n`;
			}
		}
		contextPrompt += `--- End Active Symbol Information ---\n`;
	}

	// Create a set of heuristic files for faster lookup
	const heuristicPathSet = new Set(
		preSelectedHeuristicFiles?.map((uri) =>
			path.relative(projectRoot.fsPath, uri.fsPath).replace(/\\/g, "/"),
		) || [],
	);

	const alwaysRunInvestigation =
		selectionOptions?.alwaysRunInvestigation ?? false;

	const { fileListString, isTruncated } = buildOptimizedProjectStructure(
		relativeFilePaths,
		fileSummaries,
		heuristicPathSet,
		options.fileDependencies,
		options.reverseDependencies,
		alwaysRunInvestigation,
	);

	// Detect if the user request appears to be about fixing an error
	// Use AI classification if available, otherwise fallback to regex
	const errorKeywordsRegex =
		/\b(error|bug|fix|issue|exception|crash|fail|broken|undefined|null|cannot|warning|problem)\b/i;

	let isLikelyErrorRequest = errorKeywordsRegex.test(userRequest);

	if (aiRequestService) {
		try {
			const classificationPrompt = `Analyze the following user request and determine if it is asking to fix a bug, error, or issue.
User Request: "${userRequest}"
Return ONLY a JSON object: { "isErrorFix": boolean }`;

			const response = await aiRequestService.generateWithRetry(
				[{ text: classificationPrompt }],
				modelName,
				undefined,
				"intent_classification",
				{ responseMimeType: "application/json" },
				undefined,
				undefined, // token
				false, // isMergeOperation
				"You are an intelligent intent classifier. Your job is to determine if a user request indicates a software bug, error, or issue that requires investigation. Output strict JSON.", // systemInstruction
			);

			const jsonMatch = response.match(/\{.*\}/s);
			if (jsonMatch) {
				const parsed = JSON.parse(jsonMatch[0]);
				if (typeof parsed.isErrorFix === "boolean") {
					isLikelyErrorRequest = parsed.isErrorFix;
					console.log(
						`[SmartContextSelector] AI classified intent: isErrorFix=${isLikelyErrorRequest}`,
					);
				}
			}
		} catch (error) {
			console.warn(
				"[SmartContextSelector] AI intent classification failed, using regex fallback:",
				error,
			);
		}
	}

	// Build diagnostics context if available
	let diagnosticsContext = "";
	if (diagnostics && diagnostics.trim().length > 0) {
		diagnosticsContext = `\n--- VS Code Diagnostics (Errors/Warnings) ---\n${diagnostics.substring(
			0,
			2000,
		)}\n--- End Diagnostics ---\n`;
	}

	// Build Chat History Context
	let historyContext = "";
	if (options.chatHistory && options.chatHistory.length > 0) {
		const MAX_HISTORY_LENGTH = 3000;
		// Filter out context agent logs and non-text parts if needed, keep last 5 turns
		const recentHistory = [...options.chatHistory]
			.filter((entry) => !entry.isContextAgentLog) // Exclude internal agent logs
			.slice(-5);

		const historyString = recentHistory
			.map((entry) => {
				const role = entry.role === "user" ? "User" : "Model";
				const text = entry.parts
					.filter((p): p is { text: string } => "text" in p)
					.map((p) => p.text)
					.join(" ");
				return `${role}: ${text}`;
			})
			.join("\n");

		if (historyString.length > 0) {
			const truncatedHistory =
				historyString.length > MAX_HISTORY_LENGTH
					? "...(older history truncated)\n" +
						historyString.substring(historyString.length - MAX_HISTORY_LENGTH)
					: historyString;

			historyContext = `\n--- Recent Conversation History ---\n${truncatedHistory}\n--- End Conversation History ---\n`;
		}
	}

	// Append history to contextPrompt
	contextPrompt += historyContext;

	// Build investigation instruction based on context
	let investigationInstruction: string;
	if (isTruncated || alwaysRunInvestigation || isLikelyErrorRequest) {
		investigationInstruction = `2.  **Investigate (REQUIRED)**: The file list is TRUNCATED (it shows only the top level). You MUST run at least one \`run_terminal_command\` (like \`ls -R subfolder\` or \`find .\`) to explore the codebase and find the specific files you need.
    *   **ERROR DETECTION TIP**: If the user mentions an error, extract file paths, function names, or error messages and use \`grep -i\` (case insensitive) to find them.
    *   **IMPORTANT**: No pipes (|), OR chaining (||), or AND chaining (&&) allowed. Run ONE command at a time.
    *   **CHECK BEFORE READING**: Use \`wc -l file\` to check size. Use \`file file\` to check type (avoid binary).
    *   **PEEK**: Use \`head -n 50 file\` or \`tail -n 20 file\` to verify content without reading the whole file.
    *   **EXIT STRATEGY**: As soon as you find the relevant file path or line number using grep/find/ls, **STOP** investigating. Call \`finish_selection\` immediately with that file. Do NOT cat the file to verify if you are sure.`;
	} else {
		investigationInstruction =
			"2.  **Investigate (Highly Recommended)**: Unless you are 100% certain of the file path, use `run_terminal_command` to verify. It is better to check than to guess wrong.";
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
    *   **Loop Prevention**: Do not run the same command twice. If a command returns the same output, stop and proceed to selection.
    *   **Peek Content**: Use \`head -n 50 src/file.ts\` to verify the header/imports or \`tail -n 20 src/file.ts\` to check the end.
    *   **View Specific Lines**: If you MUST view specific lines (rare), use \`sed -n '10,20p' src/file.ts\`. **NEVER** use \`cat src/file.ts:10\`.
2b. **Symbol Lookup (PREFERRED for finding definitions)**: If you see a symbol used (like \`auth.User\`, \`PlanGenerationContext\`, or \`handleLogin\`), use \`lookup_workspace_symbol\` to find its definition. This is more accurate than guessing file paths with grep.
    *   Example: You see \`sidebarTypes.PlanGenerationContext\` in the code. Run \`lookup_workspace_symbol\` with query "PlanGenerationContext" to find the exact file and line number.
3.  **Select**: Once you have identified the files, call \`finish_selection\` with the list of file paths.
    *   **LINE RANGES (ONLY in finish_selection)**: To save tokens, you can specify line ranges in finish_selection: \`filepath:startLine-endLine\`
    *   Example: \`src/auth.ts:40-80\` returns only lines 40-80. \`src/auth.ts:42\` returns just line 42.
    *   **CRITICAL WARNING - INVALID SYNTAX**: Line range syntax (e.g. \`:10\`) is **ONLY** allowed inside \`finish_selection\`.
        *   ❌ **WRONG**: \`cat src/file.ts:10\` (This will fail)
        *   ❌ **WRONG**: \`grep "foo" src/file.ts:10\` (This will fail)
        *   ✅ **CORRECT**: \`finish_selection(selectedFiles=["src/file.ts:10"])\`
4.  **Constraint**: Return ONLY the function call. Do not return markdown text.
`.trim();

	console.log(
		`[SmartContextSelector] Sending prompt to AI for file selection (${selectionPrompt.length} chars)`,
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
							"Execute a safe terminal command (ls, grep, find, cat, git grep, sed, head, tail, wc, file) to investigate the codebase. Use this to find files relevant to the user request. Returns stdout/stderr. NOTE: To read specific lines, use `sed -n 'start,endp' file`. DO NOT use `cat file:line` syntax.",
						parameters: {
							type: SchemaType.OBJECT,
							properties: {
								command: {
									type: SchemaType.STRING,
									description:
										"The terminal command to execute. Must be one of: ls, grep, find, cat, git grep, sed, head, tail, wc, file. NO chaining allowed (no |, ||, or &&). Run one command at a time.",
								},
							},
							required: ["command"],
						},
					},
					{
						name: "finish_selection",
						description:
							"Call this when you have found all relevant file paths. Supports optional line ranges OR symbol names. Returns the final list.",
						parameters: {
							type: SchemaType.OBJECT,
							properties: {
								selectedFiles: {
									type: SchemaType.ARRAY,
									description:
										"JSON Array of file paths. Supports line ranges: 'path/file.ts' (full), 'path/file.ts:10-50' (lines), OR symbols: 'path/file.ts#symbolName' (e.g. 'auth.ts#login'). You can also use objects: { \"path\": \"src/auth.ts\", \"symbol\": \"login\" }.",
									items: {
										type: SchemaType.STRING, // Use STRING to avoid enum errors, rely on string parsing
									},
								},
							},
							required: ["selectedFiles"],
						},
					},
					{
						name: "lookup_workspace_symbol",
						description:
							"Search the workspace for a symbol by name (class, interface, function, etc.). Returns an array of matching symbols with their file paths and locations. Use this FIRST when you need to find where a type or function is defined, instead of guessing file paths with grep.",
						parameters: {
							type: SchemaType.OBJECT,
							properties: {
								query: {
									type: SchemaType.STRING,
									description:
										"The symbol name to search for (e.g., 'PlanGenerationContext', 'UserService', 'handleLogin').",
								},
							},
							required: ["query"],
						},
					},
				],
			},
		];

		// 2. Run Loop if Service Available
		let currentHistory: Content[] | undefined;
		if (aiRequestService) {
			console.log(`[SmartContextSelector] Starting Agentic Selection Loop`);
			if (postMessageToWebview) {
				postMessageToWebview({
					type: "setContextAgentLoading",
					value: true,
				});
			}

			currentHistory = [
				{
					role: "user",
					parts: [{ text: selectionPrompt }],
				},
			];

			const MAX_TURNS = 15;

			for (let turn = 0; turn < MAX_TURNS; turn++) {
				if (cancellationToken?.isCancellationRequested) {
					break;
				}

				// Generate
				let functionCall: FunctionCall | null;
				try {
					functionCall = await aiRequestService.generateManagedFunctionCall(
						modelName,
						currentHistory,
						tools,
						FunctionCallingMode.AUTO,
						cancellationToken,
						"context_agent_turn",
					);
				} catch (e) {
					console.warn(
						`[SmartContextSelector] Agentic loop error: ${(e as Error).message}`,
					);
					break;
				}

				if (!functionCall) {
					console.warn(
						`[SmartContextSelector] Agent returned text instead of function call. Retrying.`,
					);
					currentHistory.push({
						role: "user",
						parts: [
							{
								text: "Error: You responded with conversational text. You MUST call one of the provided tools (run_terminal_command, lookup_workspace_symbol, or finish_selection). Do not provide explanations.",
							},
						],
					});
					continue;
				}

				// Handle
				if (functionCall.name === "finish_selection") {
					console.log(
						`[SmartContextSelector] Agent finished selection used tool.`,
					);
					const args = functionCall.args as any;
					const selectedPaths = args["selectedFiles"];
					const result = _processSelectedPaths(
						selectedPaths,
						allScannedFiles,
						projectRoot,
						relativeFilePaths,
						activeEditorContext,
					);

					// Cache result
					if (useCache) {
						const cacheKey = generateAISelectionCacheKey(
							userRequest,
							allScannedFiles,
							activeEditorContext,
							preSelectedHeuristicFiles,
						);
						aiSelectionCache.set(cacheKey, {
							timestamp: Date.now(),
							selectedFiles: result,
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
					return result;
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
							projectRoot.fsPath,
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
				} else if (functionCall.name === "lookup_workspace_symbol") {
					const args = functionCall.args as any;
					const query = args["query"] as string;

					// Log to Chat
					const symbolLogText = `Looking up symbol \`${query}\`...`;
					if (postMessageToWebview) {
						postMessageToWebview({
							type: "contextAgentLog",
							value: {
								text: symbolLogText,
							},
						});
					}
					if (addContextAgentLogToHistory) {
						addContextAgentLogToHistory(symbolLogText);
					}

					// Execute workspace symbol search
					let output = "";
					try {
						const symbols: vscode.SymbolInformation[] =
							await vscode.commands.executeCommand(
								"vscode.executeWorkspaceSymbolProvider",
								query,
							);

						if (symbols && symbols.length > 0) {
							// Format results with relative paths
							const results = symbols.slice(0, 10).map((s) => {
								const relativePath = path
									.relative(projectRoot.fsPath, s.location.uri.fsPath)
									.replace(/\\/g, "/");
								return `${s.name} (${
									vscode.SymbolKind[s.kind]
								}) - ${relativePath}:${s.location.range.start.line + 1}`;
							});
							output = `Found ${symbols.length} symbol(s):\n${results.join(
								"\n",
							)}`;
						} else {
							output = `No symbols found matching "${query}".`;
						}
					} catch (e: any) {
						output = `Error looking up symbol: ${e.message}`;
					}

					// Log output to chat
					const displayOutput =
						output.length > 300 ? output.substring(0, 300) + "..." : output;
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
									name: "lookup_workspace_symbol",
									response: { result: output },
								},
							},
						],
					});
				} else {
					console.warn(
						`[SmartContextSelector] Unknown tool: ${functionCall.name}`,
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
				`[SmartContextSelector] Agentic loop finished without selection, falling back.`,
			);
		}

		// --- Fallback / Legacy Logic ---
		if (!aiModelCall) {
			throw new Error("No AI model call function provided.");
		}

		console.warn(
			"[SmartContextSelector] Agentic Selection not available or failed. Falling back to simple prompt.",
		);

		const generationConfig: GenerationConfig = {
			temperature: TEMPERATURE,
			responseMimeType: "application/json",
		};

		// Gather investigation history if available
		let investigationContext = "";
		if (aiRequestService && currentHistory && currentHistory.length > 1) {
			const toolOutputs: string[] = [];
			for (const content of currentHistory) {
				if (content.role === "function" && content.parts) {
					for (const part of content.parts) {
						if (part.functionResponse) {
							const name = part.functionResponse.name;
							const res = part.functionResponse.response as any;
							if (name === "run_terminal_command") {
								toolOutputs.push(`Command output: ${res.result}`);
							} else if (name === "lookup_workspace_symbol") {
								toolOutputs.push(`Symbol lookup result: ${res.result}`);
							}
						}
					}
				}
			}

			if (toolOutputs.length > 0) {
				investigationContext = `
-- Investigation Findings (Previous Attempt) --
The following information was gathered during an investigation phase:
${toolOutputs.join("\n\n")}
-- End Investigation Findings --
`;
			}
		}

		// Simple prompt for legacy/fallback
		const legacyPrompt = `
You are an expert AI developer assistant. Your task is to select the most relevant files to help with a user's request.

-- Context --
${contextPrompt}
-- End Context --

${investigationContext}

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
			cancellationToken,
		);

		console.log(
			"[SmartContextSelector] AI response for file selection (Legacy):",
			aiResponse,
		);

		const selectedPaths = JSON.parse(aiResponse.trim());
		const result = _processSelectedPaths(
			selectedPaths,
			allScannedFiles,
			projectRoot,
			relativeFilePaths,
			activeEditorContext,
		);

		// Cache result for legacy path too
		if (useCache) {
			const cacheKey = generateAISelectionCacheKey(
				userRequest,
				allScannedFiles,
				activeEditorContext,
				preSelectedHeuristicFiles,
			);
			aiSelectionCache.set(cacheKey, {
				timestamp: Date.now(),
				selectedFiles: result,
				userRequest,
				activeFile: activeEditorContext?.filePath,
				fileCount: allScannedFiles.length,
				heuristicFilesCount: preSelectedHeuristicFiles?.length || 0,
			});
		}

		return result;
	} catch (error) {
		console.error(
			"[SmartContextSelector] Error during AI file selection:",
			error,
		);
		// Fallback to heuristics + active file on any error
		const fallbackFiles = new Set(preSelectedHeuristicFiles || []);
		if (activeEditorContext?.documentUri) {
			fallbackFiles.add(activeEditorContext.documentUri);
		}

		// Map Set<vscode.Uri> to FileSelection[]
		return Array.from(fallbackFiles).map((uri) => ({
			uri,
			startLine: undefined,
			endLine: undefined,
		}));
	}
}

// Helper function to process selected paths with optional line range support
function _processSelectedPaths(
	selectedPaths: any,
	allScannedFiles: readonly vscode.Uri[],
	projectRoot: vscode.Uri,
	relativeFilePaths: string[],
	activeEditorContext: any,
): FileSelection[] {
	if (
		!Array.isArray(selectedPaths) ||
		!selectedPaths.every((p) => typeof p === "string")
	) {
		throw new Error("AI did not return a valid JSON array of strings.");
	}

	const projectFileSet = new Set(relativeFilePaths.map((p) => p.toLowerCase()));
	const finalSelections = new Map<string, FileSelection>(); // Use map to dedupe by fsPath

	// Add AI selected files with optional line ranges or symbols
	for (const selectedPath of selectedPaths as string[]) {
		const {
			path: filePath,
			startLine,
			endLine,
			symbolName,
		} = parseFileSelector(selectedPath);
		const normalizedPath = filePath.replace(/\\/g, "/");

		if (projectFileSet.has(normalizedPath.toLowerCase())) {
			const originalUri = allScannedFiles.find(
				(uri) =>
					path
						.relative(projectRoot.fsPath, uri.fsPath)
						.replace(/\\/g, "/")
						.toLowerCase() === normalizedPath.toLowerCase(),
			);
			if (originalUri) {
				const existingSelection = finalSelections.get(originalUri.fsPath);
				if (existingSelection) {
					// If file already selected, expand the range to include both
					// (This handles cases where AI selects overlapping ranges)
					// Verify logic: Overlapping ranges might need merge.
					// Symbols might override ranges or exist alongside.
					// For simplicity, if symbol is present, we keep it. If range, expand.
					if (startLine && endLine) {
						existingSelection.startLine = existingSelection.startLine
							? Math.min(existingSelection.startLine, startLine)
							: startLine;
						existingSelection.endLine = existingSelection.endLine
							? Math.max(existingSelection.endLine, endLine)
							: endLine;
					}
					if (symbolName) {
						existingSelection.symbolName = symbolName; // Overwrite or keep last? Keep last for now.
					}
				} else {
					finalSelections.set(originalUri.fsPath, {
						uri: originalUri,
						startLine,
						endLine,
						symbolName,
					});
				}
			}
		} else {
			// Allow files not in the scanned list if they exist on disk (e.g. found via terminal commands)
			try {
				const absolutePath = path.resolve(projectRoot.fsPath, normalizedPath);
				// Check if file exists and is inside the project
				if (
					absolutePath.startsWith(projectRoot.fsPath) &&
					fs.existsSync(absolutePath)
				) {
					const newUri = vscode.Uri.file(absolutePath);
					finalSelections.set(newUri.fsPath, {
						uri: newUri,
						startLine,
						endLine,
					});
				}
			} catch (e) {
				// Ignore invalid paths
			}
		}
	}

	let finalResultSelections = Array.from(finalSelections.values());

	// Always include the active file if it exists (full file, not chunked)
	if (
		activeEditorContext?.documentUri &&
		!finalResultSelections.some(
			(sel) => sel.uri.fsPath === activeEditorContext.documentUri.fsPath,
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
		}),
	);

	return {
		size: aiSelectionCache.size,
		entries,
	};
}
