import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import type { GenerationConfig } from "@google/generative-ai";
import {
	HistoryEntry,
	PlanGenerationContext,
} from "../sidebar/common/sidebarTypes";
import { TEMPERATURE } from "../sidebar/common/sidebarConstants";
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
import { ContextAgentCacheService } from "../services/contextAgentCacheService";
import { getHeuristicRelevantFiles } from "./heuristicContextSelector";
import { DependencyRelation } from "./dependencyGraphBuilder";
import { HeuristicSelectionOptions } from "./heuristicContextSelector";
import { FileSummary } from "../services/sequentialFileProcessor";

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
	fileDependencies?: Map<string, DependencyRelation[]>;
	reverseDependencies?: Map<string, DependencyRelation[]>; // Files that import each file
	activeEditorSymbols?: vscode.DocumentSymbol[];
	preSelectedHeuristicFiles?: vscode.Uri[];
	fileSummaries?: Map<string, FileSummary>;
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
	heuristicSelectionOptions?: HeuristicSelectionOptions; // Heuristic selection options
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
	fileSummaries: Map<string, FileSummary> | undefined,
	heuristicPathSet: Set<string>,
	fileDependencies: Map<string, DependencyRelation[]> | undefined,
	reverseDependencies: Map<string, DependencyRelation[]> | undefined,
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
				Array.from(topLevelDirs) // Corrected from duplicate to original logic
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
					const summaryObj = fileSummaries?.get(p);
					let fileEntry = `- "${p}"`;
					if (summaryObj) {
						const summaryText = summaryObj.summary;
						const lineCount = summaryObj.lineCount;
						const lineCountStr = lineCount ? `[${lineCount} lines] ` : "";
						fileEntry += ` (${lineCountStr}${summaryText
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
								.map((i) => path.basename(i.path)) // Fixed property access
								.join(", ");
							fileEntry += `\n    ↳ imports: ${importList}${
								imports.length > 3 ? "..." : ""
							}`;
						}
						if (importedBy && importedBy.length > 0) {
							const importedByList = importedBy
								.slice(0, 3)
								.map((i) => path.basename(i.path))
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
						const summaryText = summary.summary;
						const lineCount = summary.lineCount;
						const lineCountStr = lineCount ? `[${lineCount} lines] ` : "";
						fileEntry += ` (${lineCountStr}${summaryText
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
								.map((i) => path.basename(i.path))
								.join(", ");
							const moreCount =
								imports.length > 5 ? ` +${imports.length - 5} more` : "";
							fileEntry += `\n    ↳ imports: ${importList}${moreCount}`;
						}

						if (importedBy && importedBy.length > 0) {
							const importedByList = importedBy
								.slice(0, 3)
								.map((i) => path.basename(i.path))
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

	// 1. Detect if the user request appears to be about fixing an error OR refactoring/searching
	// Use AI classification if available, otherwise fallback to regex
	const projectAnalysisKeywordsRegex =
		/\b(error|bug|fix|issue|exception|crash|fail|broken|undefined|null|cannot|warning|problem|refactor|restructure|optimize|find|search|where|locate|architecture|dependency|structure)\b/i;

	let isLikelyAnalysisRequired = false;

	if (aiRequestService) {
		try {
			const classificationPrompt = `Analyze the following user request and determine if it requires deep codebase investigation (e.g., fixing a bug, refactoring code, searching for patterns, or understanding architecture).
User Request: "${userRequest}"
Return ONLY a JSON object: { "requiresInvestigation": boolean }`;

			const response = await aiRequestService.generateWithRetry(
				[{ text: classificationPrompt }],
				modelName,
				undefined,
				"intent_classification",
				{ responseMimeType: "application/json" },
				undefined,
				undefined, // token
				false, // isMergeOperation
				"You are an intelligent intent classifier specialized in codebase analysis. Your job is to determine if a user request indicates a need for deep investigation. Output strict JSON.", // systemInstruction
			);

			const jsonMatch = response.match(/\{.*\}/s);
			if (jsonMatch) {
				const parsed = JSON.parse(jsonMatch[0]);
				if (typeof parsed.requiresInvestigation === "boolean") {
					isLikelyAnalysisRequired = parsed.requiresInvestigation;
					console.log(
						`[SmartContextSelector] AI classified intent: requiresInvestigation=${isLikelyAnalysisRequired}`,
					);
				}
			}
		} catch (error) {
			console.warn(
				"[SmartContextSelector] AI intent classification failed, falling back to regex.",
				error,
			);
		}
	}

	// Safety Net: If AI failed OR returned false, still check common keywords
	if (!isLikelyAnalysisRequired) {
		isLikelyAnalysisRequired = projectAnalysisKeywordsRegex.test(userRequest);
		if (isLikelyAnalysisRequired) {
			console.log(
				`[SmartContextSelector] Regex safety net triggered requiresInvestigation.`,
			);
		}
	}

	let contextPrompt = `User Request: "${userRequest}"\n`;

	// Add project configuration context if available
	if (projectConfigPrompt) {
		contextPrompt += `\n${projectConfigPrompt}\n`;
	}

	let heuristicSection = "";
	if (preSelectedHeuristicFiles && preSelectedHeuristicFiles.length > 0) {
		const heuristicPaths = preSelectedHeuristicFiles.map((uri) =>
			path.relative(projectRoot.fsPath, uri.fsPath).replace(/\\/g, "/"),
		);

		if (isLikelyAnalysisRequired) {
			heuristicSection = `\n--- Initial Heuristic Leads (UNVERIFIED / LOW CONFIDENCE) ---\nThese files were selected by a simple keyword-matching algorithm. They may be incomplete or irrelevant for this complex request.\nPotential Leads: ${heuristicPaths.join(
				", ",
			)}\n--- End Heuristic Leads ---\n`;
		} else {
			contextPrompt += `\nHeuristically Pre-selected Files (strong candidates, but critically evaluate them): ${heuristicPaths.join(
				", ",
			)}\n`;
		}
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

	// Append reframed heuristics at the end of context if analysis is required
	if (isLikelyAnalysisRequired && heuristicSection) {
		contextPrompt += heuristicSection;
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

	if (isTruncated || alwaysRunInvestigation || isLikelyAnalysisRequired) {
		const searchToolInstructions = `*   **POWERFUL SEARCH**: You can use \`|\` (pipes) and \`grep\` / \`find\` to filter results.
    *   **Examples**:
        *   \`ls -R | grep "auth"\` (Find files with "auth" in name)
        *   \`find src -name "*.ts" -exec grep -l "interface User" {} +\` (Find files containing text)
        *   \`grep -r "class User" src\` (Search content recursively)`;

		investigationInstruction = `2.  **Investigate (REQUIRED)**: The file list is TRUNCATED or this is a complex request. You MUST run a \`run_terminal_command\` to find specific files. **Never rely solely on heuristically provided files for any request.**
    ${searchToolInstructions}
    *   **CHECK BEFORE READING**: Use \`wc -l file\` to check size.
    *   **EXIT STRATEGY**: Ensure you have found **ALL** relevant context (files, symbols, imports) required to satisfy the request before calling \`finish_selection\`. Thoroughness is prioritized over speed.`;
	} else {
		investigationInstruction =
			"2.  **Investigate (Highly Recommended)**: Use `run_terminal_command` with `ls`, `find`, or `grep -r` to verify file existence and content before selecting. Relying on memory or heuristics for file paths is error-prone.";
	}

	const selectionPrompt = `
You are an expert AI developer assistant. Your task is to select the most relevant files to help with a user's request.

-- Context --
${contextPrompt}${diagnosticsContext}
-- End Context --

${fileListString}

-- Instructions --
1.  **Analyze the Goal**: Understand the user's request and the provided context.${
		isLikelyAnalysisRequired
			? " This request requires deep analysis - NOT just heuristics!"
			: ""
	}
${investigationInstruction}
    *   **Loop Prevention**: Do not run the same command twice.
    *   **Search Before Reading (Targeted Inspection)**: NEVER scan a file linearly (e.g., 1-100, then 101-200). Instead, use \`grep\`, \`lookup_workspace_symbol\`, or \`get_symbol_definitions\` to find exact line numbers and then use \`read_file_range\` to jump there.
    *   **Precise Inspection (REQUIRED)**: Use \`read_file_range\` to inspect specific code blocks. Do NOT use \`cat\`, \`head\`, or \`tail\` via the terminal.
    *   **Semantic Teleportation**:
        - Use \`get_symbol_definitions\` to jump directly to a symbol's source code.
        - Use \`get_symbol_implementations\` to find concrete implementations of interfaces/classes.
    *   **Search**: Use \`search_codebase\` to find relevant code patterns.
    *   **Connections**: Use \`find_related_files\` to discover imports/usage of a specific file.
    *   **Mapping Structure**: Use \`get_file_outline\` to see classes and methods in a file without reading the whole thing.
    *   **Trace Usage**: Use \`find_symbol_references\` to see every file that uses a specific function or variable.
    *   **Diagnosis**: Use \`get_diagnostics\` to see current linter errors or warnings that might pinpoint the bug.
3.  **The Triangulation Principle**: A thorough investigation requires cross-referencing. Do not rely on a single tool result.
    *   **Find** a target (e.g., using \`get_symbol_definitions\` or \`lookup_workspace_symbol\`).
    *   **Verify** its relevance (e.g., using \`find_symbol_references\` or \`grep\` to see usage).
    *   **Explore** its context (e.g., using \`ls\` or checking related files).
4.  **Select (SURGICAL SELECTION REQUIRED)**: Call \`finish_selection\` with precise line ranges.
    *   **NO FULL FILES**: For files > 100 lines, you MUST provide a range (e.g., \`src/file.ts:20-80\`). Selecting an entire large file is a FAILURE of precision.
    *   **PRECISION TAX**: Every line you select that is NOT directly relevant to the request is a failure. Aim for the smallest possible window that proves your point or solves the goal.
    *   **LINE RANGES**: \`src/auth.ts:40-80\` (lines 40-80).
    *   **CRITICAL WARNING**: Line ranges (e.g. \`:10\`) are **ONLY** allowed inside \`finish_selection\`.
        *   ❌ **WRONG**: \`cat src/file.ts:10\`
        *   ✅ **CORRECT**: \`finish_selection(selectedFiles=["src/file.ts:10-50"])\`
5.  **Constraint**: Return ONLY the function call.
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
							"Execute a safe terminal command (ls, grep, find, git, wc, file, xargs) to investigate the codebase. Pipes (|) ARE ALLOWED. Note: Do NOT use this for reading files (use read_file_range instead).",
						parameters: {
							type: SchemaType.OBJECT,
							properties: {
								command: {
									type: SchemaType.STRING,
									description:
										"The terminal command to execute. Allowed: ls, grep, find, git, wc, file, xargs. Pipes (|) are supported. Example: `grep -r 'foo' src`.",
								},
							},
							required: ["command"],
						},
					},
					{
						name: "finish_selection",
						description:
							"Finish the investigation and return the final list of relevant files and line ranges. MANDATORY: For any file > 100 lines, you MUST provide a line range (e.g., 'src/file.ts:10-50') or a symbol ('src/file.ts#MyClass'). Selecting full large files is FORBIDDEN.",
						parameters: {
							type: SchemaType.OBJECT,
							properties: {
								selectedFiles: {
									type: SchemaType.ARRAY,
									description:
										"JSON Array of file paths with ranges. Examples: ['src/main.ts:10-50', 'src/utils.ts#myFunc', 'src/small_file.ts'].",
									items: {
										type: SchemaType.STRING,
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
					{
						name: "find_related_files",
						description:
							"Find files related to a specific file (e.g., imports, tests, definitions) using heuristic analysis. Useful when you have a file and want to know what it uses or what uses it.",
						parameters: {
							type: SchemaType.OBJECT,
							properties: {
								filePath: {
									type: SchemaType.STRING,
									description:
										"The relative path of the file to investigate (e.g., 'src/services/authService.ts').",
								},
							},
							required: ["filePath"],
						},
					},
					{
						name: "search_codebase",
						description:
							"Search the entire codebase for a string or pattern. Uses 'grep' under the hood. Case insensitive by default.",
						parameters: {
							type: SchemaType.OBJECT,
							properties: {
								query: {
									type: SchemaType.STRING,
									description: "The string or regex pattern to search for.",
								},
								caseSensitive: {
									type: SchemaType.BOOLEAN,
									description: "If true, search is case sensitive.",
								},
							},
							required: ["query"],
						},
					},
					{
						name: "read_file_range",
						description:
							"Read a specific line range from a file. Use this to inspect code blocks and verify relevance. Lines are 1-indexed and inclusive.",
						parameters: {
							type: SchemaType.OBJECT,
							properties: {
								filePath: {
									type: SchemaType.STRING,
									description:
										"The relative path of the file to read (e.g., 'src/main.ts').",
								},
								startLine: {
									type: SchemaType.NUMBER,
									description:
										"The starting line number (1-indexed, inclusive).",
								},
								endLine: {
									type: SchemaType.NUMBER,
									description: "The ending line number (1-indexed, inclusive).",
								},
							},
							required: ["filePath", "startLine", "endLine"],
						},
					},
					{
						name: "get_file_outline",
						description:
							"Retrieve a structured list of symbols (classes, methods, variables) in a specific file. Useful for mapping a file's structure quickly.",
						parameters: {
							type: SchemaType.OBJECT,
							properties: {
								filePath: {
									type: SchemaType.STRING,
									description:
										"The relative path of the file (e.g., 'src/services/planService.ts').",
								},
							},
							required: ["filePath"],
						},
					},
					{
						name: "find_symbol_references",
						description:
							"Find all references to a specific symbol across the workspace. Use this to trace usage and verify connections between files.",
						parameters: {
							type: SchemaType.OBJECT,
							properties: {
								symbolName: {
									type: SchemaType.STRING,
									description: "The name of the symbol to find references for.",
								},
							},
							required: ["symbolName"],
						},
					},
					{
						name: "get_diagnostics",
						description:
							"Pull current VS Code errors and warnings. Can be filtered by file path or scoped to the entire workspace.",
						parameters: {
							type: SchemaType.OBJECT,
							properties: {
								filePath: {
									type: SchemaType.STRING,
									description:
										"Optional: Filter diagnostics to a specific file path.",
								},
							},
							required: [],
						},
					},
					{
						name: "get_symbol_definitions",
						description:
							"Jump directly to where a symbol is defined. Use this to find the source code for a class, function, or variable name.",
						parameters: {
							type: SchemaType.OBJECT,
							properties: {
								symbolName: {
									type: SchemaType.STRING,
									description:
										"The name of the symbol to find the definition for.",
								},
							},
							required: ["symbolName"],
						},
					},
					{
						name: "get_symbol_implementations",
						description:
							"Find implementations of a class or interface symbol. Useful for tracing logic in polymorphic systems.",
						parameters: {
							type: SchemaType.OBJECT,
							properties: {
								symbolName: {
									type: SchemaType.STRING,
									description:
										"The name of the symbol to find implementations for.",
								},
							},
							required: ["symbolName"],
						},
					},
				],
			},
			{
				functionDeclarations: [
					{
						name: "think",
						description:
							"Use this tool to think about the problem, analyze context, and plan your next steps. This helps you make better decisions. The user will see your thoughts.",
						parameters: {
							type: SchemaType.OBJECT,
							properties: {
								thought: {
									type: SchemaType.STRING,
									description: "Your detailed thoughts and reasoning.",
								},
							},
							required: ["thought"],
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

			const MAX_TURNS = 30;

			// Create cache service for reduced token costs during the agentic loop
			// This caches the system instruction + tools so they're not re-sent every turn
			const contextAgentCacheService = new ContextAgentCacheService(() =>
				aiRequestService.getApiKey(),
			);

			let cachedContentName: string | null = null;
			try {
				// System instruction for the context agent
				const contextAgentSystemInstruction = `You are an expert AI developer assistant specialized in codebase analysis. Your task is to select the most relevant files to help with a user's request.
Use the provided tools to investigate the codebase and select files. Always call a tool - never respond with text.
Use the 'think' tool to PLAN your investigation steps. DO NOT use thinking to justify skipping tools.
**THE TRIANGULATION PRINCIPLE**: You must provide evidence from at least TWO different types of tool outputs (e.g., a symbol lookup + a grep search) for any file you select for complex requests.
**AVOID SEQUENTIAL SCANNING**: Do not read files in blocks (1-100, 101-200). Use search tools to make "semantic leaps" to relevant code.
Never assume a file belongs in the selection because it sounds important; VERIFY its content and connections first.`;

				cachedContentName = await contextAgentCacheService.getOrCreateCache(
					modelName,
					contextAgentSystemInstruction,
					tools,
				);

				if (cachedContentName) {
					console.log(
						`[SmartContextSelector] Using cached content: ${cachedContentName}`,
					);
				}
			} catch (cacheError) {
				console.warn(
					`[SmartContextSelector] Failed to create cache, proceeding without: ${(cacheError as Error).message}`,
				);
			}

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
						FunctionCallingMode.ANY,
						cancellationToken,
						"context_agent_turn",
						cachedContentName ?? undefined, // Pass cached content for reduced token costs
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

					// --- SURGICAL GATEKEEPER ---
					const surgicalViolations: string[] = [];
					if (Array.isArray(selectedPaths)) {
						selectedPaths.forEach((pathWithSelector: any) => {
							if (typeof pathWithSelector !== "string") return;
							const {
								path: filePath,
								startLine,
								symbolName,
							} = parseFileSelector(pathWithSelector);
							const summary = fileSummaries?.get(filePath);
							// If file is > 100 lines and no range/symbol is provided, it's a violation
							if (
								summary &&
								summary.lineCount &&
								summary.lineCount > 100 &&
								!startLine &&
								!symbolName
							) {
								surgicalViolations.push(
									`${filePath} (${summary.lineCount} lines)`,
								);
							}
						});
					}

					if (surgicalViolations.length > 0) {
						const errorMsg = `PRECISION ERROR: You attempted to select full files that are > 100 lines: ${surgicalViolations.join(", ")}. This is FORBIDDEN to prevent token inflation. You MUST use line ranges (e.g., 'path.ts:10-50') or symbols ('path.ts#MyClass') to be surgical. Re-evaluate your selection and call finish_selection again with precise ranges.`;
						const logText = `Surgical validation failed: Full selection of large files is restricted.`;

						if (postMessageToWebview) {
							postMessageToWebview({
								type: "contextAgentLog",
								value: { text: logText },
							});
						}
						if (addContextAgentLogToHistory) {
							addContextAgentLogToHistory(logText);
						}

						currentHistory.push({
							role: "model",
							parts: [{ functionCall: functionCall }],
						});
						currentHistory.push({
							role: "function",
							parts: [
								{
									functionResponse: {
										name: "finish_selection",
										response: { error: errorMsg },
									},
								},
							],
						});
						continue; // Force the AI to retry with surgical ranges
					}

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
					// Dispose cache before returning
					contextAgentCacheService.dispose().catch(() => {});
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
				} else if (functionCall.name === "find_related_files") {
					const args = functionCall.args as any;
					const filePathStr = args["filePath"] as string;

					// Log
					const logText = `Finding files related to \`${filePathStr}\`...`;
					if (postMessageToWebview) {
						postMessageToWebview({
							type: "contextAgentLog",
							value: { text: logText },
						});
					}
					if (addContextAgentLogToHistory) {
						addContextAgentLogToHistory(logText);
					}

					let output = "";
					try {
						// Resolve URI
						let targetUri = allScannedFiles.find(
							(u) =>
								path
									.relative(projectRoot.fsPath, u.fsPath)
									.replace(/\\/g, "/") === filePathStr,
						);
						if (!targetUri) {
							targetUri = vscode.Uri.joinPath(projectRoot, filePathStr);
						}

						// Use getHeuristicRelevantFiles with the target file as the "active" context
						const relatedUris = await getHeuristicRelevantFiles(
							allScannedFiles,
							projectRoot,
							{
								documentUri: targetUri,
								// Mock required properties of EditorContext
								fullText: "",
								selectedText: "",
								instruction: "",
								languageId: "typescript", // Default/Dummy
								filePath: targetUri.fsPath,
								selection: new vscode.Range(0, 0, 0, 0),
							},
							options.fileDependencies,
							options.reverseDependencies,
							undefined, // activeSymbolDetailedInfo
							undefined, // semanticGraph
							cancellationToken,
							{
								maxHeuristicFilesTotal: 20, // Limit results
							},
						);

						if (relatedUris.length > 0) {
							const paths = relatedUris
								.map((u) =>
									path
										.relative(projectRoot.fsPath, u.fsPath)
										.replace(/\\/g, "/"),
								)
								.slice(0, 15); // Show top 15
							output = `Found ${relatedUris.length} related files. Top results:\n- ${paths.join("\n- ")}`;
						} else {
							output = `No strongly related files found for ${filePathStr}.`;
						}
					} catch (e: any) {
						output = `Error finding related files: ${e.message}`;
					}

					// Log output / History
					const displayOutput =
						output.length > 500 ? output.substring(0, 500) + "..." : output;
					const outputLogText = `\`\`\`\n${displayOutput}\n\`\`\``;
					if (postMessageToWebview) {
						postMessageToWebview({
							type: "contextAgentLog",
							value: { text: outputLogText },
						});
					}
					if (addContextAgentLogToHistory) {
						addContextAgentLogToHistory(outputLogText);
					}

					currentHistory.push({
						role: "model",
						parts: [{ functionCall: functionCall }],
					});
					currentHistory.push({
						role: "function",
						parts: [
							{
								functionResponse: {
									name: "find_related_files",
									response: { result: output },
								},
							},
						],
					});
				} else if (functionCall.name === "search_codebase") {
					const args = functionCall.args as any;
					const query = args["query"] as string;
					const caseSensitive = args["caseSensitive"] === true;

					// Logic
					const logText = `Searching codebase for "${query}"...`;
					if (postMessageToWebview) {
						postMessageToWebview({
							type: "contextAgentLog",
							value: { text: logText },
						});
					}
					if (addContextAgentLogToHistory) {
						addContextAgentLogToHistory(logText);
					}

					let output = "";
					try {
						// Use grep via SafeCommandExecutor
						// Flags: -r (recursive), -n (line numbers), -I (ignore binary), -i (case insensitive if not set)
						const flags = caseSensitive ? "-rnI" : "-rnIi";
						// Limit output to avoid massive tokens
						const command = `grep ${flags} "${query.replace(/"/g, '\\"')}" . | head -n 50`;

						output = await SafeCommandExecutor.execute(
							command,
							projectRoot.fsPath,
						);
						if (!output.trim()) {
							output = "No matches found.";
						} else {
							// If truncated by head, mention it
							if (output.split("\n").length >= 50) {
								output += "\n...(matches truncated to first 50 lines)";
							}
						}
					} catch (e: any) {
						output = `Search Error: ${e.message}`;
					}

					// Log output / History
					const displayOutput =
						output.length > 500 ? output.substring(0, 500) + "..." : output;
					const outputLogText = `\`\`\`\n${displayOutput}\n\`\`\``;
					if (postMessageToWebview) {
						postMessageToWebview({
							type: "contextAgentLog",
							value: { text: outputLogText },
						});
					}
					if (addContextAgentLogToHistory) {
						addContextAgentLogToHistory(outputLogText);
					}

					currentHistory.push({
						role: "model",
						parts: [{ functionCall: functionCall }],
					});
					currentHistory.push({
						role: "function",
						parts: [
							{
								functionResponse: {
									name: "search_codebase",
									response: { result: output },
								},
							},
						],
					});
				} else if (functionCall.name === "read_file_range") {
					const args = functionCall.args as any;
					const filePathStr = args["filePath"] as string;
					const startLine = Math.max(
						1,
						Math.floor(args["startLine"] as number),
					);
					const endLine = Math.floor(args["endLine"] as number);

					// Log
					const logText = `Reading \`${filePathStr}:${startLine}-${endLine}\`...`;
					if (postMessageToWebview) {
						postMessageToWebview({
							type: "contextAgentLog",
							value: { text: logText },
						});
					}
					if (addContextAgentLogToHistory) {
						addContextAgentLogToHistory(logText);
					}

					let output = "";
					try {
						// Use sed via SafeCommandExecutor
						const command = `sed -n '${startLine},${endLine}p' "${filePathStr.replace(/"/g, '\\"')}"`;
						output = await SafeCommandExecutor.execute(
							command,
							projectRoot.fsPath,
						);

						if (!output.trim()) {
							output = "(File empty or range out of bounds)";
						}
					} catch (e: any) {
						output = `Read Error: ${e.message}`;
					}

					// Log output / History
					const displayOutput =
						output.length > 500 ? output.substring(0, 500) + "..." : output;
					const outputLogText = `\`\`\`\n${displayOutput}\n\`\`\``;
					if (postMessageToWebview) {
						postMessageToWebview({
							type: "contextAgentLog",
							value: { text: outputLogText },
						});
					}
					if (addContextAgentLogToHistory) {
						addContextAgentLogToHistory(outputLogText);
					}

					currentHistory.push({
						role: "function",
						parts: [
							{
								functionResponse: {
									name: "read_file_range",
									response: { result: output.substring(0, 10000) },
								},
							},
						],
					});
				} else if (functionCall.name === "get_file_outline") {
					const args = functionCall.args as any;
					const filePathStr = args["filePath"] as string;

					// Log
					const logText = `Fetching outline for \`${filePathStr}\`...`;
					if (postMessageToWebview) {
						postMessageToWebview({
							type: "contextAgentLog",
							value: { text: logText },
						});
					}
					if (addContextAgentLogToHistory) {
						addContextAgentLogToHistory(logText);
					}

					let output = "";
					try {
						// Resolve URI
						const targetUri = vscode.Uri.joinPath(projectRoot, filePathStr);
						const symbols: (
							| vscode.SymbolInformation
							| vscode.DocumentSymbol
						)[] = await vscode.commands.executeCommand(
							"vscode.executeDocumentSymbolProvider",
							targetUri,
						);

						if (symbols && symbols.length > 0) {
							// Flatten and format (naive flattening for DocumentSymbol)
							const formatSymbol = (s: any, indent: string = ""): string => {
								let result = `${indent}${s.name} (${vscode.SymbolKind[s.kind]})\n`;
								if (s.children) {
									s.children.forEach((c: any) => {
										result += formatSymbol(c, indent + "  ");
									});
								}
								return result;
							};

							const formatted = symbols.map((s) => formatSymbol(s)).join("");
							output = `File Outline for ${filePathStr}:\n${formatted}`;
						} else {
							output = `No symbols found in ${filePathStr}.`;
						}
					} catch (e: any) {
						output = `Outline Error: ${e.message}`;
					}

					// Log output / History
					const displayOutput =
						output.length > 500 ? output.substring(0, 500) + "..." : output;
					const outputLogText = `\`\`\`\n${displayOutput}\n\`\`\``;
					if (postMessageToWebview) {
						postMessageToWebview({
							type: "contextAgentLog",
							value: { text: outputLogText },
						});
					}
					if (addContextAgentLogToHistory) {
						addContextAgentLogToHistory(outputLogText);
					}

					currentHistory.push({
						role: "model",
						parts: [{ functionCall: functionCall }],
					});
					currentHistory.push({
						role: "function",
						parts: [
							{
								functionResponse: {
									name: "get_file_outline",
									response: { result: output.substring(0, 10000) },
								},
							},
						],
					});
				} else if (functionCall.name === "find_symbol_references") {
					const args = functionCall.args as any;
					const symbolName = args["symbolName"] as string;

					const logText = `Finding references for "${symbolName}"...`;
					if (postMessageToWebview) {
						postMessageToWebview({
							type: "contextAgentLog",
							value: { text: logText },
						});
					}
					if (addContextAgentLogToHistory) {
						addContextAgentLogToHistory(logText);
					}

					let output = "";
					try {
						// First find the symbol location to get its URI and position
						const symbols: vscode.SymbolInformation[] =
							await vscode.commands.executeCommand(
								"vscode.executeWorkspaceSymbolProvider",
								symbolName,
							);

						if (symbols && symbols.length > 0) {
							const primarySymbol = symbols[0];
							const references: vscode.Location[] =
								await vscode.commands.executeCommand(
									"vscode.executeReferenceProvider",
									primarySymbol.location.uri,
									primarySymbol.location.range.start,
								);

							if (references && references.length > 0) {
								const formatted = references
									.slice(0, 20)
									.map((loc) => {
										const relPath = path
											.relative(projectRoot.fsPath, loc.uri.fsPath)
											.replace(/\\/g, "/");
										return `${relPath}:${loc.range.start.line + 1}`;
									})
									.join("\n- ");
								output = `Found ${references.length} references for "${symbolName}". Top results:\n- ${formatted}`;
							} else {
								output = `No references found for "${symbolName}".`;
							}
						} else {
							output = `Symbol "${symbolName}" not found.`;
						}
					} catch (e: any) {
						output = `Reference Search Error: ${e.message}`;
					}

					// Log/History
					const outputLogText = `\`\`\`\n${output}\n\`\`\``;
					if (postMessageToWebview) {
						postMessageToWebview({
							type: "contextAgentLog",
							value: { text: outputLogText },
						});
					}
					if (addContextAgentLogToHistory) {
						addContextAgentLogToHistory(outputLogText);
					}

					currentHistory.push({
						role: "model",
						parts: [{ functionCall: functionCall }],
					});
					currentHistory.push({
						role: "function",
						parts: [
							{
								functionResponse: {
									name: "find_symbol_references",
									response: { result: output },
								},
							},
						],
					});
				} else if (functionCall.name === "get_diagnostics") {
					const args = functionCall.args as any;
					const filePathStr = args["filePath"] as string | undefined;

					const logText = filePathStr
						? `Getting diagnostics for \`${filePathStr}\`...`
						: "Getting workspace-wide diagnostics...";
					if (postMessageToWebview) {
						postMessageToWebview({
							type: "contextAgentLog",
							value: { text: logText },
						});
					}
					if (addContextAgentLogToHistory) {
						addContextAgentLogToHistory(logText);
					}

					let output = "";
					try {
						const allDiag = vscode.languages.getDiagnostics();
						let filtered = allDiag;

						if (filePathStr) {
							const targetUri = vscode.Uri.joinPath(projectRoot, filePathStr);
							filtered = allDiag.filter(
								([uri, _]) => uri.fsPath === targetUri.fsPath,
							);
						}

						if (filtered.length > 0) {
							const formatted = filtered
								.flatMap(([uri, diags]) => {
									const relPath = path
										.relative(projectRoot.fsPath, uri.fsPath)
										.replace(/\\/g, "/");
									return diags.map(
										(d) =>
											`[${vscode.DiagnosticSeverity[d.severity]}] ${relPath}:${
												d.range.start.line + 1
											}: ${d.message}`,
									);
								})
								.slice(0, 50)
								.join("\n- ");
							output = `Found ${filtered.reduce(
								(acc, [_, d]) => acc + d.length,
								0,
							)} diagnostics:\n- ${formatted}`;
						} else {
							output = "No diagnostics found.";
						}
					} catch (e: any) {
						output = `Diagnostics Error: ${e.message}`;
					}

					// Log/History
					const outputLogText = `\`\`\`\n${output.substring(0, 500)}\n\`\`\``;
					if (postMessageToWebview) {
						postMessageToWebview({
							type: "contextAgentLog",
							value: { text: outputLogText },
						});
					}
					if (addContextAgentLogToHistory) {
						addContextAgentLogToHistory(outputLogText);
					}

					currentHistory.push({
						role: "model",
						parts: [{ functionCall: functionCall }],
					});
					currentHistory.push({
						role: "function",
						parts: [
							{
								functionResponse: {
									name: "get_diagnostics",
									response: { result: output.substring(0, 10000) },
								},
							},
						],
					});
				} else if (functionCall.name === "get_symbol_definitions") {
					const args = functionCall.args as any;
					const symbolName = args["symbolName"] as string;

					const logText = `Jumping to definition of "${symbolName}"...`;
					if (postMessageToWebview) {
						postMessageToWebview({
							type: "contextAgentLog",
							value: { text: logText },
						});
					}
					if (addContextAgentLogToHistory) {
						addContextAgentLogToHistory(logText);
					}

					let output = "";
					try {
						// 1. Find symbol location
						const symbols: vscode.SymbolInformation[] =
							await vscode.commands.executeCommand(
								"vscode.executeWorkspaceSymbolProvider",
								symbolName,
							);

						if (symbols && symbols.length > 0) {
							// For definitions, we use the first high-confidence match
							const target = symbols[0];
							const definitions: vscode.Location[] =
								await vscode.commands.executeCommand(
									"vscode.executeDefinitionProvider",
									target.location.uri,
									target.location.range.start,
								);

							if (definitions && definitions.length > 0) {
								const formatted = definitions
									.map((loc) => {
										const relPath = path
											.relative(projectRoot.fsPath, loc.uri.fsPath)
											.replace(/\\/g, "/");
										return `${relPath}:${loc.range.start.line + 1}`;
									})
									.join("\n- ");
								output = `Found definition(s) for "${symbolName}":\n- ${formatted}`;
							} else {
								// Fallback to the workspace symbol location itself if definition provider is empty
								const relPath = path
									.relative(projectRoot.fsPath, target.location.uri.fsPath)
									.replace(/\\/g, "/");
								output = `Found symbol location for "${symbolName}" (Definition provider returned no secondary results):\n- ${relPath}:${target.location.range.start.line + 1}`;
							}
						} else {
							output = `Symbol "${symbolName}" not found in workspace.`;
						}
					} catch (e: any) {
						output = `Definition Error: ${e.message}`;
					}

					// Log/History
					const outputLogText = `\`\`\`\n${output}\n\`\`\``;
					if (postMessageToWebview) {
						postMessageToWebview({
							type: "contextAgentLog",
							value: { text: outputLogText },
						});
					}
					if (addContextAgentLogToHistory) {
						addContextAgentLogToHistory(outputLogText);
					}

					currentHistory.push({
						role: "model",
						parts: [{ functionCall: functionCall }],
					});
					currentHistory.push({
						role: "function",
						parts: [
							{
								functionResponse: {
									name: "get_symbol_definitions",
									response: { result: output },
								},
							},
						],
					});
				} else if (functionCall.name === "get_symbol_implementations") {
					const args = functionCall.args as any;
					const symbolName = args["symbolName"] as string;

					const logText = `Finding implementations for "${symbolName}"...`;
					if (postMessageToWebview) {
						postMessageToWebview({
							type: "contextAgentLog",
							value: { text: logText },
						});
					}
					if (addContextAgentLogToHistory) {
						addContextAgentLogToHistory(logText);
					}

					let output = "";
					try {
						const symbols: vscode.SymbolInformation[] =
							await vscode.commands.executeCommand(
								"vscode.executeWorkspaceSymbolProvider",
								symbolName,
							);

						if (symbols && symbols.length > 0) {
							const target = symbols[0];
							const implementations: vscode.Location[] =
								await vscode.commands.executeCommand(
									"vscode.executeImplementationProvider",
									target.location.uri,
									target.location.range.start,
								);

							if (implementations && implementations.length > 0) {
								const formatted = implementations
									.map((loc) => {
										const relPath = path
											.relative(projectRoot.fsPath, loc.uri.fsPath)
											.replace(/\\/g, "/");
										return `${relPath}:${loc.range.start.line + 1}`;
									})
									.join("\n- ");
								output = `Found implementation(s) for "${symbolName}":\n- ${formatted}`;
							} else {
								output = `No specific implementations found for "${symbolName}".`;
							}
						} else {
							output = `Symbol "${symbolName}" not found.`;
						}
					} catch (e: any) {
						output = `Implementation Error: ${e.message}`;
					}

					// Log/History
					const outputLogText = `\`\`\`\n${output}\n\`\`\``;
					if (postMessageToWebview) {
						postMessageToWebview({
							type: "contextAgentLog",
							value: { text: outputLogText },
						});
					}
					if (addContextAgentLogToHistory) {
						addContextAgentLogToHistory(outputLogText);
					}

					currentHistory.push({
						role: "model",
						parts: [{ functionCall: functionCall }],
					});
					currentHistory.push({
						role: "function",
						parts: [
							{
								functionResponse: {
									name: "get_symbol_implementations",
									response: { result: output },
								},
							},
						],
					});
				} else if (functionCall.name === "think") {
					const args = functionCall.args as any;
					const thought = args["thought"] as string;

					// Log thought to Chat
					const thoughtLogText = `Thinking: ${thought}`;
					if (postMessageToWebview) {
						postMessageToWebview({
							type: "contextAgentLog",
							value: {
								text: thoughtLogText,
							},
						});
					}
					if (addContextAgentLogToHistory) {
						addContextAgentLogToHistory(thoughtLogText);
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
									name: "think",
									response: { result: "Thought recorded." },
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
			// Dispose cache when loop completes without selection
			contextAgentCacheService.dispose().catch(() => {});
			console.log(
				`[SmartContextSelector] Agentic loop finished without selection, falling back.`,
			);
		}

		// --- Fallback / Legacy Logic ---
		let effectiveAiModelCall = aiModelCall;

		if (!effectiveAiModelCall && aiRequestService) {
			console.log(
				"[SmartContextSelector] aiModelCall missing, creating adapter for aiRequestService",
			);
			if (postMessageToWebview) {
				postMessageToWebview({
					type: "contextAgentLog",
					value: {
						text: `[Context Agent] Summarizing changes...`,
					},
				});
			}

			// Adapter for aiRequestService to match aiModelCall signature
			effectiveAiModelCall = async (
				prompt: string,
				model: string,
				history: HistoryEntry[] | undefined,
				requestType: string,
				config: GenerationConfig | undefined,
				streamCallbacks: any,
				token: vscode.CancellationToken | undefined,
			) => {
				return await aiRequestService.generateWithRetry(
					[{ text: prompt }],
					model,
					history,
					requestType, // Passes requestType as traceId/identifier
					config, // Passes generationConfig (including temperature)
					streamCallbacks,
					token,
					false, // isMergeOperation
					"You are an expert AI developer assistant. Select the most relevant files based on the context provided.", // systemInstruction
				);
			};
		}

		if (!effectiveAiModelCall) {
			const errorMsg =
				"CRITICAL ERROR: No AI model call mechanism established for file selection. Ensure either aiModelCall or aiRequestService is provided in options.";
			if (postMessageToWebview) {
				postMessageToWebview({
					type: "contextAgentLog",
					value: { text: `[Context Agent] ${errorMsg}` },
				});
			}
			throw new Error(errorMsg);
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

		const aiResponse = await effectiveAiModelCall(
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

	// If active file was NOT selected surgically, add it full as a fallback
	if (
		activeEditorContext?.documentUri &&
		!finalResultSelections.some(
			(s) => s.uri.fsPath === activeEditorContext.documentUri.fsPath,
		)
	) {
		finalResultSelections.push({
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
