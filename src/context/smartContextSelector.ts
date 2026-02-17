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
import { SafeCommandExecutor, EXCLUDED_FILES } from "./safeCommandExecutor";
import { AIRequestService } from "../services/aiRequestService";
import {
	getSymbolsInDocument,
	serializeDocumentSymbolHierarchy,
	findReferences,
	getDefinition,
	getImplementations,
	getTypeDefinition,
	prepareCallHierarchy,
	resolveIncomingCalls,
	resolveOutgoingCalls,
} from "../services/symbolService";
import { getGitStagedDiff } from "../sidebar/services/gitService";
import { DiagnosticService } from "../utils/diagnosticUtils";
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
 * Used for targeted file reading to reduce context size.
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
	priorityFilesCount: number;
}

// Cache storage
const aiSelectionCache = new Map<string, AISelectionCache>();

// Configuration for AI selection
interface AISelectionOptions {
	useCache?: boolean;
	useAISelectionCache?: boolean; // New: Standardized name
	cacheTimeout?: number;
	maxPromptLength?: number;
	enableStreaming?: boolean;
	fallbackToHeuristics?: boolean;
	alwaysRunInvestigation?: boolean;
}

export interface SelectRelevantFilesAIOptions {
	userRequest: string;
	chatHistory: readonly HistoryEntry[];
	allScannedFiles: readonly vscode.Uri[];
	projectRoot: vscode.Uri;
	activeEditorContext?: PlanGenerationContext["editorContext"];
	priorityFiles?: vscode.Uri[]; // Files to show even in truncated view (e.g. active, modified, error)
	fileSummaries?: Map<string, string>;
	fileDependencies?: Map<string, string[]>;
	reverseDependencies?: Map<string, string[]>;
	fileLineCounts?: Map<string, number>; // New: Line counts for files
	diagnostics?: string;
	activeEditorSymbols?: any;
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
	aiRequestService?: AIRequestService; // Pass service for tool calls
	postMessageToWebview?: (message: any) => void; // For logging to chat
	addContextAgentLogToHistory?: (logText: string) => void; // For persisting logs to history
	modelName: string;
	cancellationToken?: vscode.CancellationToken;
	selectionOptions?: AISelectionOptions; // Selection options
	alwaysRunInvestigation?: boolean;
}

/**
 * Generate cache key for AI selection
 */
function generateAISelectionCacheKey(
	userRequest: string,
	allScannedFiles: ReadonlyArray<vscode.Uri>,
	activeEditorContext?: PlanGenerationContext["editorContext"],
	priorityFiles?: vscode.Uri[],
): string {
	const activeFile = activeEditorContext?.filePath || "";
	const priorityFilePaths =
		priorityFiles
			?.map((f) => f.fsPath)
			.sort()
			.join("|") || "";
	const fileCount = allScannedFiles.length;

	// Create a hash-like key from the request and context
	const keyComponents = [
		userRequest.substring(0, 100), // First 100 chars of request
		activeFile,
		priorityFilePaths,
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
	priorityPathSet: Set<string>,
	fileDependencies: Map<string, string[]> | undefined,
	reverseDependencies: Map<string, string[]> | undefined,
	forceOptimization: boolean,
	fileLineCounts?: Map<string, number>,
): { fileListString: string; isTruncated: boolean } {
	const fileCount = relativeFilePaths.length;
	const FILE_LIST_THRESHOLD = 20; // Lowered to force discovery even for small projects

	if (forceOptimization || fileCount > FILE_LIST_THRESHOLD) {
		// Optimized Mode: Show top-level structure + priority/essential root files
		const topLevelDirs = new Set<string>();
		const importantFiles = new Set<string>();

		const essentialRootFiles = new Set([
			"package.json",
			"tsconfig.json",
			"README.md",
			".gitignore",
		]);

		relativeFilePaths.forEach((p) => {
			// Always include priority files (active, modified, errors)
			if (priorityPathSet.has(p)) {
				importantFiles.add(p);
				return;
			}

			// Include ONLY essential root-level configuration/readme files
			if (!p.includes("/")) {
				const lowercasePath = p.toLowerCase();
				if (
					essentialRootFiles.has(lowercasePath) &&
					!EXCLUDED_FILES.includes(p)
				) {
					importantFiles.add(p);
					return;
				}
			}

			// Group others into directories
			const firstSegment = p.split("/")[0];
			topLevelDirs.add(firstSegment + "/");
		});

		let output = "--- Project Structure (Optimized Discovery View) ---\n";
		output += `Total Files: ${fileCount}\n`;
		output +=
			"Note: This is a high-level DISCOVERY view. Most files are hidden to save context.\n";
		output +=
			"YOU MUST USE `run_terminal_command` (e.g. `ls -R`, `find src`), `lookup_workspace_symbol`, or `get_file_symbols` to explore and find specific files.\n\n";

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
					const lineCount = fileLineCounts?.get(p);
					let fileEntry = `- "${p}"`;
					if (lineCount !== undefined) {
						fileEntry += ` (${lineCount} lines)`;
					}
					if (summary) {
						fileEntry += ` (${summary
							.substring(0, 100)
							.replace(/\s+/g, " ")}...)`;
					}

					// Add relationships only for relevant files to reduce noise
					if (priorityPathSet.has(p)) {
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
					const lineCount = fileLineCounts?.get(p);
					let fileEntry = `- "${p}"`;

					if (lineCount !== undefined) {
						fileEntry += ` (${lineCount} lines)`;
					}

					// Add summary if available
					if (summary) {
						fileEntry += ` (${summary
							.substring(0, 150)
							.replace(/\s+/g, " ")}...)`;
					}

					// Add relationship info for priority files (most relevant)
					if (priorityPathSet.has(p)) {
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
		priorityFiles: preSelectedPriorityFiles,
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
	const useCache = selectionOptions?.useAISelectionCache !== false; // Enable cache by default
	const cacheTimeout = selectionOptions?.cacheTimeout ?? 10 * 60 * 1000; // 10 minutes default

	if (useCache) {
		const cacheKey = generateAISelectionCacheKey(
			userRequest,
			allScannedFiles,
			activeEditorContext,
			preSelectedPriorityFiles,
		);

		const cached = aiSelectionCache.get(cacheKey);
		if (cached && Date.now() - cached.timestamp < cacheTimeout) {
			console.log(
				`[SmartContextSelector] Using cached AI selection for: "${userRequest.substring(
					0,
					50,
				)}..."`,
			);
			if (postMessageToWebview) {
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
				text: `[User Request] Analysis started for: "${userRequest}"`,
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

	if (preSelectedPriorityFiles && preSelectedPriorityFiles.length > 0) {
		const priorityPaths = preSelectedPriorityFiles.map((uri) =>
			path.relative(projectRoot.fsPath, uri.fsPath).replace(/\\/g, "/"),
		);
		contextPrompt += `\nPriority Files (strong candidates, but critically evaluate them): ${priorityPaths.join(
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

	// Create a set of priority files for faster lookup
	const priorityPathSet = new Set(
		preSelectedPriorityFiles?.map((uri) =>
			path.relative(projectRoot.fsPath, uri.fsPath).replace(/\\/g, "/"),
		) || [],
	);

	const alwaysRunInvestigation =
		selectionOptions?.alwaysRunInvestigation ?? false;

	const { fileListString, isTruncated } = buildOptimizedProjectStructure(
		relativeFilePaths,
		fileSummaries,
		priorityPathSet,
		options.fileDependencies,
		options.reverseDependencies,
		alwaysRunInvestigation,
		options.fileLineCounts,
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
	let investigationInstruction = "";

	if (isTruncated || alwaysRunInvestigation || isLikelyErrorRequest) {
		const searchToolInstructions = `*   **POWERFUL SEARCH**: You can use \`|\` (pipes) and \`grep\` / \`find\` to filter results. Commands are automatically filtered to exclude node_modules, dist, build artifacts, and binary files.
    *   **Examples**:
        *   \`git ls-files | grep "auth"\` (Find files with "auth" in name — respects .gitignore)
        *   \`find src -name "*.ts" -exec grep -l "interface User" {} +\` (Find files containing text)
        *   \`grep -rn "class User" src\` (Search content recursively in source directory)
    *   **IMPORTANT**: Always prefer \`git ls-files\` over \`ls -R\` — it automatically respects .gitignore. Scope \`grep\` and \`find\` to source directories (e.g., \`src/\`, \`lib/\`) instead of \`.\` to avoid noise from generated code.`;

		investigationInstruction = `
4.  **Investigate (REQUIRED)**: The file list is TRUNCATED or this is a high-priority request. You MUST run a \`run_terminal_command\` to find specific files.
    ${searchToolInstructions}
    *   **CHECK BEFORE READING**: Use \`wc -l file\` to check size.
    *   **COMPLETION**: Call \`finish_selection\` when you are confident you have gathered all necessary context. You should continue investigating if you believe further files or symbols are required to provide a complete solution.`;
	} else {
		investigationInstruction = `
4.  **Investigate (OPTIONAL)**: After explaining your strategy, you **MAY** use \`run_terminal_command\`, \`git\` tools, or \`get_file_symbols\` to verify file existence and content.
    *   **Rule**: If you already have all the information you need, you can call \`finish_selection\` immediately.
    *   **Git Usage (POWERFUL)**: Use \`git\` (via terminal or \`get_git_diffs\`) to understand recent history and changes.`;
	}

	// Build individual prompt sections
	const activeFilePrompt = activeEditorContext
		? `\nActive File: ${path
				.relative(projectRoot.fsPath, activeEditorContext.filePath)
				.replace(/\\/g, "/")}\n`
		: "";

	const activeSymbolPrompt = activeSymbolDetailedInfo?.name
		? `Active Symbol: ${activeSymbolDetailedInfo.name} (${
				activeSymbolDetailedInfo.kind || "Unknown"
			})\n`
		: "";

	const priorityFilesPrompt =
		preSelectedPriorityFiles && preSelectedPriorityFiles.length > 0
			? preSelectedPriorityFiles
					.map((uri) =>
						path.relative(projectRoot.fsPath, uri.fsPath).replace(/\\/g, "/"),
					)
					.join("\n")
			: "None pre-selected.";

	const summariesPrompt =
		fileSummaries && fileSummaries.size > 0
			? Array.from(fileSummaries.entries())
					.map(([file, summary]) => `[${file}]\n${summary}`)
					.join("\n\n")
			: "No summaries available.";

	const systemPrompt =
		`You are a Context Selection Agent. Your goal is to identify the most relevant files for the user's request.
You are a **READ-ONLY** agent. You CANNOT perform any write operations, modify files, or create new files. Your only responsibility is to gather context and information to help the user.
You will iterate using tools until you have enough information to call \`finish_selection\`.

-- Intent Recognition & Adaptation --
*   **Non-Coding Tasks**: If the user's request is a greeting, a general question (e.g., "how are you?"), or something that doesn't require codebase context, you should proceed to \`finish_selection([])\` immediately with an empty array.
*   **General Inquiries**: If the user is asking a general question about the codebase that doesn't require specific file context (e.g., "what language is this?"), call \`finish_selection([])\` unless a specific file is needed to answer.
*   **Coding Tasks**: Only for requests involving code changes, debugging, or technical analysis should you proceed with the deep investigation described below.

-- Instructions --
1.  **Exhaustive Discovery (MANDATORY)**: Finding *something* relevant is just the beginning. You MUST continue looking until you are certain you have gathered ALL information that could impact the request.
    *   **NEVER SATISFIED**: Even if you have "enough" to start, check if there is *more* that could make the solution better, safer, or more complete.
    *   **Doc Traversal**: If a file is mentioned in another document as a key resource (e.g., in a README or Architecture file), you MUST investigate it unless it is clearly out of scope.
    *   **Multi-Source Verification**: Do not rely on a single file if other related files exist. Prematurely stopping is a high-cost failure.
2.  **Thinking Process (MANDATORY)**: You MUST call the \`report_thought\` tool to explain your search strategy before using other tools.
    *   **FORMATTING**: Use **Markdown** in your thoughts.
        *   Use **bold** for emphasis.
        *   Use \`code ticks\` for file paths, symbols, and commands.
        *   Use bullet lists (-) for multiple steps.
3.  **Relationship-First Strategy (PRIORITY)**: You MUST prioritize using structural relationship tools to explore the codebase. These provide "structural truth" which is more reliable than text matches.
    *   **Symbol Lookup (GLOBAL)**: Use \`lookup_workspace_symbol\` as your first step to find where a specific symbol is defined.
    *   **Graph Traversal (DEEP)**:
        *   Use \`go_to_definition\` to see where a symbol is *defined*.
        *   Use \`find_references\` to see the "blast radius" or all usages of a component.
        *   Use \`get_implementations\` to find concrete classes/methods implementing an interface or abstract class.
        *   Use \`get_type_definition\` to see the definition of a type for a symbol.
        *   Use \`get_call_hierarchy_incoming\`/\`get_call_hierarchy_outgoing\` to trace function calls through complex logic flows.
    *   **Primary Discovery**: These markers are your primary means of exploration. Only use generic searches (\`grep\`, \`find\`) as a fallback when the relationship graph is insufficient.
${investigationInstruction}
5.  **Symbol Exploration (PREFERRED)**: Use \`get_file_symbols\` to see a file's structure without reading its entire content. This is much faster and context-efficient than reading the whole file.
6.  **Search (FALLBACK)**: Use \`grep\` or \`find\` scoped to source directories ONLY if relationship tools do not provide enough context.
    *   \`grep -rn "pattern" src\`: Search for text in source files.
    *   \`git ls-files | grep "pattern"\`: Find files by name.
    *   **IMPORTANT**: Always scope searches to source directories instead of the root. Never search in \`node_modules\` or build directories.
7.  **Budget-Conscious Discovery**: Be **careful** to avoid reading unnecessary code lines. Targeted reading is key—use \`get_file_symbols\` FIRST to pinpoint specific areas.
8.  **Read Specific Lines (MANDATORY)**: Use the \`read_file\` tool for ALL file reading. You MUST use \`get_file_symbols\` FIRST to identify the EXACT line numbers you need.
9.  **Finalize & Chain of Truth (CODING TASKS ONLY)**: For actual coding tasks or complex technical analysis, do NOT call \`finish_selection\` until you have traced every relevant symbol to its definition and verified how it interacts with the rest of the system.
    *   If a file import or dependency is critical to the task, you MUST investigate it.
    *   You should be able to explain the "Chain of Truth"—the structural relationship between the files you have selected.
    *   Premature satisfaction is a failure. Be thorough.
10. **Finalize (NON-CODING TASKS)**: For greetings or non-technical requests, call \`finish_selection([])\` immediately.
11. **Iterative Refinement**: If you discover a new dependency while reading a file during a technical task, go back and investigate that dependency. Do not stop until the context is complete.

-- Project Context --
Project Path: ${projectRoot.fsPath}
${projectConfigPrompt}

-- Available Files (Ground Truth) --
${fileListString}

-- File Summaries (Reference only) --
${summariesPrompt}
`.trim();

	const userPrompt = `
-- Context --
${contextPrompt}
-- End Context --

-- Priority Files (Strong Candidates) --
${priorityFilesPrompt}
-- End Priority Files --

You MUST start by calling \`report_thought\`.
`.trim();

	console.log(
		`[SmartContextSelector] Sending prompt to AI for file selection (System: ${systemPrompt.length}, User: ${userPrompt.length} chars)`,
	);

	try {
		// --- AGENTIC LOOP ---
		// 1. Define Tools
		const tools: Tool[] = [
			{
				functionDeclarations: [
					{
						name: "report_thought",
						description:
							"Report your thinking process and search strategy to the user. This helps transparency. Use this BEFORE calling other tools. SUPPORTS MARKDOWN (bold, lists, code ticks).",
						parameters: {
							type: SchemaType.OBJECT,
							properties: {
								thought: {
									type: SchemaType.STRING,
									description:
										"The thinking process and strategy explanation. Use **Markdown** for clarity (e.g., **bold** for emphasis, `code` for paths/symbols, - lists for steps).",
								},
							},
							required: ["thought"],
						},
					},
					{
						name: "run_terminal_command",
						description:
							"Execute a safe terminal command (ls, grep, find, cat, git, sed, tail, wc, file, xargs, grep) to investigate the codebase. Pipes (|) ARE ALLOWED.",
						parameters: {
							type: SchemaType.OBJECT,
							properties: {
								command: {
									type: SchemaType.STRING,
									description:
										"The terminal command to execute. Allowed: ls, grep, find, cat, git, sed, tail, wc, file, xargs. PIPES (|) ARE SUPPORTED. Example: `grep -r 'foo' src`.",
								},
							},
							required: ["command"],
						},
					},
					{
						name: "finish_selection",
						description:
							"Call this when you have found what you need to answer acording to the user's needs. Supports optional line ranges OR symbol names. Returns the final list.",
						parameters: {
							type: SchemaType.OBJECT,
							properties: {
								selectedFiles: {
									type: SchemaType.ARRAY,
									description:
										"JSON Array of file paths. Supports line ranges: 'path/file.ts' (full), 'path/file.ts:10-50' (lines), OR symbols: 'path/file.ts#symbolName' (e.g. 'auth.ts#login'). If no files are needed to fulfill the request, provide an empty array [].",
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
							"Search the workspace for a symbol by name (class, interface, function, etc.). Returns an array of matching symbols with their file paths and locations. Use this FIRST when you need to find where a type or function is defined. This is your primary tool for global structural discovery.",
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
						name: "get_file_symbols",
						description:
							"Get all symbols (classes, functions, variables, etc.) defined in a specific file. Use this to understand a file's structure and identify target line ranges before reading content.",
						parameters: {
							type: SchemaType.OBJECT,
							properties: {
								path: {
									type: SchemaType.STRING,
									description:
										"The file path relative to the project root (e.g., 'src/auth.ts').",
								},
							},
							required: ["path"],
						},
					},
					{
						name: "find_references",
						description:
							"Find all usages of a symbol across the workspace. Use this to see who calls a function or uses a variable.",
						parameters: {
							type: SchemaType.OBJECT,
							properties: {
								path: {
									type: SchemaType.STRING,
									description:
										"The file path relative to the project root (e.g., 'src/auth.ts').",
								},
								line: {
									type: SchemaType.NUMBER,
									description:
										"The line number (1-based) where the symbol is located.",
								},
								symbol_name: {
									type: SchemaType.STRING,
									description:
										"The name of the symbol (optional, used to help locate the character position).",
								},
							},
							required: ["path", "line"],
						},
					},
					{
						name: "get_implementations",
						description:
							"Find all implementations of an interface or abstract class. Use this to see concrete code that satisfies a contract.",
						parameters: {
							type: SchemaType.OBJECT,
							properties: {
								path: {
									type: SchemaType.STRING,
									description: "The file path relative to the project root.",
								},
								line: {
									type: SchemaType.NUMBER,
									description:
										"The line number (1-based) where the symbol is located.",
								},
							},
							required: ["path", "line"],
						},
					},
					{
						name: "get_type_definition",
						description:
							"Find the definition of a type for a symbol. Use this to understand complex types or interface definitions.",
						parameters: {
							type: SchemaType.OBJECT,
							properties: {
								path: {
									type: SchemaType.STRING,
									description: "The file path relative to the project root.",
								},
								line: {
									type: SchemaType.NUMBER,
									description:
										"The line number (1-based) where the symbol is located.",
								},
							},
							required: ["path", "line"],
						},
					},
					{
						name: "get_call_hierarchy_incoming",
						description:
							"Find all functions that call a specific function. Use this to understand the impact of a change or how a feature is used.",
						parameters: {
							type: SchemaType.OBJECT,
							properties: {
								path: {
									type: SchemaType.STRING,
									description: "The file path relative to the project root.",
								},
								line: {
									type: SchemaType.NUMBER,
									description:
										"The line number (1-based) where the function is defined.",
								},
							},
							required: ["path", "line"],
						},
					},
					{
						name: "get_call_hierarchy_outgoing",
						description:
							"Find all functions called by a specific function. Use this to trace the logic flow into dependencies.",
						parameters: {
							type: SchemaType.OBJECT,
							properties: {
								path: {
									type: SchemaType.STRING,
									description: "The file path relative to the project root.",
								},
								line: {
									type: SchemaType.NUMBER,
									description:
										"The line number (1-based) where the function is defined.",
								},
							},
							required: ["path", "line"],
						},
					},
					{
						name: "get_file_diagnostics",
						description:
							"Get all compiler errors, warnings, and hints for a specific file. Use this to identify bugs or type issues.",
						parameters: {
							type: SchemaType.OBJECT,
							properties: {
								path: {
									type: SchemaType.STRING,
									description: "The file path relative to the project root.",
								},
							},
							required: ["path"],
						},
					},
					{
						name: "get_git_diffs",
						description:
							"Get the current staged changes or diffs against HEAD. Use this to understand what you're working on and prioritize relevant files.",
						parameters: {
							type: SchemaType.OBJECT,
							properties: {
								type: {
									type: SchemaType.STRING,
									description: "Type of diff to get: 'staged' or 'head'.",
									format: "enum",
									enum: ["staged", "head"],
								},
							},
							required: ["type"],
						},
					},
					{
						name: "go_to_definition",
						description:
							"Find where a symbol used at a specific location is defined. Use this to understand the implementation of a dependency.",
						parameters: {
							type: SchemaType.OBJECT,
							properties: {
								path: {
									type: SchemaType.STRING,
									description:
										"The file path relative to the project root (e.g., 'src/auth.ts').",
								},
								line: {
									type: SchemaType.NUMBER,
									description:
										"The line number (1-based) where the symbol usage is located.",
								},
								symbol_name: {
									type: SchemaType.STRING,
									description:
										"The name of the symbol (optional, used to help locate the character position).",
								},
							},
							required: ["path", "line"],
						},
					},
					{
						name: "read_file",
						description:
							"Read a specific range of lines from a file. Use this AFTER identifying relevant lines with get_file_symbols. BE CAREFUL to avoid reading unnecessary code lines to save context budget.",
						parameters: {
							type: SchemaType.OBJECT,
							properties: {
								path: {
									type: SchemaType.STRING,
									description:
										"The file path relative to the project root (e.g., 'src/auth.ts').",
								},
								startLine: {
									type: SchemaType.NUMBER,
									description: "The starting line number (1-based, inclusive).",
								},
								endLine: {
									type: SchemaType.NUMBER,
									description: "The ending line number (1-based, inclusive).",
								},
							},
							required: ["path", "startLine", "endLine"],
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
					parts: [{ text: userPrompt }],
				},
			];

			const MAX_TURNS = 50;
			let consecutiveTextOnlyCount = 0;

			for (let turn = 0; turn < MAX_TURNS; turn++) {
				if (cancellationToken?.isCancellationRequested) {
					break;
				}

				// Generate
				let functionCall: FunctionCall | null = null;
				let thought: string | undefined;

				try {
					const result = await aiRequestService.generateManagedFunctionCall(
						modelName,
						currentHistory,
						tools,
						FunctionCallingMode.ANY,
						cancellationToken,
						"context_agent_turn",
						systemPrompt, // Pass static context as system instruction
					);
					functionCall = result.functionCall;
					thought = result.thought;
				} catch (e) {
					console.warn(
						`[SmartContextSelector] Agentic loop error: ${(e as Error).message}`,
					);
					break;
				}

				// Log Text-based Thinking if available (fallback)
				if (thought) {
					const thoughtLogText = `<span class="thinking-prefix">[Thinking]</span> ${thought}`;
					console.log(
						`[SmartContextSelector] Agent thought (text): ${thought}`,
					);

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
				}

				if (!functionCall) {
					consecutiveTextOnlyCount++;
					console.log(
						`[SmartContextSelector] No function call, consecutive count: ${consecutiveTextOnlyCount}`,
					);

					// Still push to history if there was a thought
					if (thought) {
						currentHistory.push({
							role: "model",
							parts: [{ text: thought }],
						});
					}

					if (consecutiveTextOnlyCount >= 2) {
						console.log(
							`[SmartContextSelector] Breaking agent loop due to consecutive text-only responses.`,
						);
						break;
					}

					currentHistory.push({
						role: "user",
						parts: [
							{
								text: "Note: You provided thoughts but did NOT call a tool. To finish, you MUST call `finish_selection` with an array of file paths. If no files are needed, you must call `finish_selection(selectedFiles=[])`.",
							},
						],
					});
					continue;
				}

				// Reset counter on successful tool call
				consecutiveTextOnlyCount = 0;

				// Handle
				if (functionCall.name === "report_thought") {
					const args = functionCall.args as any;
					const thoughtContent = args["thought"] as string;

					// Log to Chat with [Thinking] prefix
					const thoughtLogText = `<span class="thinking-prefix">[Thinking]</span> ${thoughtContent}`;
					console.log(
						`[SmartContextSelector] Agent thought (tool): ${thoughtContent}`,
					);

					if (postMessageToWebview) {
						// Only log to webview, no need to add to history log as it is separate
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
					const modelParts: any[] = [];
					if (thought) {
						modelParts.push({ text: thought });
					}
					modelParts.push({ functionCall: functionCall });

					currentHistory.push({
						role: "model",
						parts: modelParts,
					});
					currentHistory.push({
						role: "function",
						parts: [
							{
								functionResponse: {
									name: "report_thought",
									response: {
										result: "Thinking recorded. Proceed with next tool.",
									},
								},
							},
						],
					});
				} else if (functionCall.name === "finish_selection") {
					console.log(
						`[SmartContextSelector] Agent finished selection used tool.`,
					);
					const args = functionCall.args as any;
					let selectedPaths = args["selectedFiles"];

					// Safety check: ensure selectedPaths defaults to an empty array if missing or invalid
					if (!Array.isArray(selectedPaths)) {
						console.warn(
							`[SmartContextSelector] finish_selection called with invalid selectedFiles argument:`,
							selectedPaths,
						);
						selectedPaths = [];
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
							preSelectedPriorityFiles,
						);
						aiSelectionCache.set(cacheKey, {
							timestamp: Date.now(),
							selectedFiles: result,
							userRequest,
							activeFile: activeEditorContext?.filePath,
							fileCount: allScannedFiles.length,
							priorityFilesCount: preSelectedPriorityFiles?.length || 0,
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
						output.length > 10000 ? output.substring(0, 10000) + "..." : output;
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
					const modelParts: any[] = [];
					if (thought) {
						modelParts.push({ text: thought });
					}
					modelParts.push({ functionCall: functionCall });

					currentHistory.push({
						role: "model",
						parts: modelParts,
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
						output.length > 10000 ? output.substring(0, 10000) + "..." : output;
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
					const modelParts: any[] = [];
					if (thought) {
						modelParts.push({ text: thought });
					}
					modelParts.push({ functionCall: functionCall });

					currentHistory.push({
						role: "model",
						parts: modelParts,
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
				} else if (functionCall.name === "get_file_symbols") {
					const args = functionCall.args as any;
					const filePath = args["path"] as string;

					// Log to Chat
					const symbolLogText = `Getting symbols for \`${filePath}\`...`;
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

					// Execute
					let output = "";
					try {
						const fullPath = path.join(projectRoot.fsPath, filePath);
						const symbols = await getSymbolsInDocument(
							vscode.Uri.file(fullPath),
							cancellationToken,
						);
						if (symbols && symbols.length > 0) {
							// Serialize all top-level symbols and their children
							output = symbols
								.map((s) => serializeDocumentSymbolHierarchy(s, filePath))
								.join("\n");
						} else {
							output = `No symbols found in "${filePath}".`;
						}
					} catch (e: any) {
						output = `Error getting symbols: ${e.message}`;
					}

					// Log output to chat
					const displayOutput =
						output.length > 10000 ? output.substring(0, 10000) + "..." : output;
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
					const modelParts: any[] = [];
					if (thought) {
						modelParts.push({ text: thought });
					}
					modelParts.push({ functionCall: functionCall });

					currentHistory.push({
						role: "model",
						parts: modelParts,
					});
					currentHistory.push({
						role: "function",
						parts: [
							{
								functionResponse: {
									name: "get_file_symbols",
									response: { result: output },
								},
							},
						],
					});
				} else if (functionCall.name === "find_references") {
					const args = functionCall.args as any;
					const filePath = args["path"] as string;
					const line = args["line"] as number;
					// const symbolName = args["symbol_name"] as string; // TODO: Use for precise char location

					// Log to Chat
					const logText = `Finding references for symbol at \`${filePath}:${line}\`...`;
					if (postMessageToWebview) {
						postMessageToWebview({
							type: "contextAgentLog",
							value: { text: logText },
						});
					}
					if (addContextAgentLogToHistory) {
						addContextAgentLogToHistory(logText);
					}

					// Execute
					let output = "";
					try {
						const fullPath = path.join(projectRoot.fsPath, filePath);
						// Simple heuristic: assume symbol is at the beginning or middle of line.
						// A robust implementation would scan the line for the symbol name if provided.
						// For now, we default to character 0 or basic estimation.
						const position = new vscode.Position(line - 1, 0);

						const locations = await findReferences(
							vscode.Uri.file(fullPath),
							position,
							cancellationToken,
						);

						if (locations && locations.length > 0) {
							const results = locations.slice(0, 20).map((l) => {
								const relativePath = path
									.relative(projectRoot.fsPath, l.uri.fsPath)
									.replace(/\\/g, "/");
								return `- ${relativePath}:${l.range.start.line + 1}`;
							});
							output = `Found ${locations.length} reference(s):\n${results.join(
								"\n",
							)}`;
							if (locations.length > 20) {
								output += `\n...and ${locations.length - 20} more.`;
							}
						} else {
							output = `No references found for symbol at ${filePath}:${line}.`;
						}
					} catch (e: any) {
						output = `Error finding references: ${e.message}`;
					}

					// Log output to chat
					const displayOutput =
						output.length > 10000 ? output.substring(0, 10000) + "..." : output;
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

					// Update History
					const modelParts: any[] = [];
					if (thought) {
						modelParts.push({ text: thought });
					}
					modelParts.push({ functionCall: functionCall });

					currentHistory.push({
						role: "model",
						parts: modelParts,
					});
					currentHistory.push({
						role: "function",
						parts: [
							{
								functionResponse: {
									name: "find_references",
									response: { result: output },
								},
							},
						],
					});
				} else if (functionCall.name === "go_to_definition") {
					const args = functionCall.args as any;
					const filePath = args["path"] as string;
					const line = args["line"] as number;

					// Log to Chat
					const logText = `Going to definition for symbol at \`${filePath}:${line}\`...`;
					if (postMessageToWebview) {
						postMessageToWebview({
							type: "contextAgentLog",
							value: { text: logText },
						});
					}
					if (addContextAgentLogToHistory) {
						addContextAgentLogToHistory(logText);
					}

					// Execute
					let output = "";
					try {
						const fullPath = path.join(projectRoot.fsPath, filePath);
						const position = new vscode.Position(line - 1, 0);

						const locationOrArr = await getDefinition(
							vscode.Uri.file(fullPath),
							position,
							cancellationToken,
						);
						const locations = Array.isArray(locationOrArr)
							? locationOrArr
							: locationOrArr
								? [locationOrArr]
								: [];

						if (locations && locations.length > 0) {
							const results = locations.map((l) => {
								const relativePath = path
									.relative(projectRoot.fsPath, l.uri.fsPath)
									.replace(/\\/g, "/");
								return `- ${relativePath}:${l.range.start.line + 1}`;
							});
							output = `Found definition(s) at:\n${results.join("\n")}`;
						} else {
							output = `No definition found for symbol at ${filePath}:${line}.`;
						}
					} catch (e: any) {
						output = `Error finding definition: ${e.message}`;
					}

					// Log output to chat
					const displayOutput =
						output.length > 10000 ? output.substring(0, 10000) + "..." : output;
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

					// Update History
					const modelParts: any[] = [];
					if (thought) {
						modelParts.push({ text: thought });
					}
					modelParts.push({ functionCall: functionCall });

					currentHistory.push({
						role: "model",
						parts: modelParts,
					});

					currentHistory.push({
						role: "function",
						parts: [
							{
								functionResponse: {
									name: "go_to_definition",
									response: { result: output },
								},
							},
						],
					});
				} else if (functionCall.name === "get_implementations") {
					const args = functionCall.args as any;
					const filePath = args["path"] as string;
					const line = args["line"] as number;

					// Log to Chat
					const logText = `Finding implementations for symbol at \`${filePath}:${line}\`...`;
					if (postMessageToWebview) {
						postMessageToWebview({
							type: "contextAgentLog",
							value: { text: logText },
						});
					}
					if (addContextAgentLogToHistory) {
						addContextAgentLogToHistory(logText);
					}

					// Execute
					let output = "";
					try {
						const fullPath = path.join(projectRoot.fsPath, filePath);
						const position = new vscode.Position(line - 1, 0);

						const locations = await getImplementations(
							vscode.Uri.file(fullPath),
							position,
							cancellationToken,
						);

						if (locations && locations.length > 0) {
							const results = locations.map((l) => {
								const relativePath = path
									.relative(projectRoot.fsPath, l.uri.fsPath)
									.replace(/\\/g, "/");
								return `- ${relativePath}:${l.range.start.line + 1}`;
							});
							output = `Found implementation(s) at:\n${results.join("\n")}`;
						} else {
							output = `No implementations found for symbol at ${filePath}:${line}.`;
						}
					} catch (e: any) {
						output = `Error finding implementation: ${e.message}`;
					}

					// Log output to chat
					const displayOutput =
						output.length > 10000 ? output.substring(0, 10000) + "..." : output;
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
									name: "get_implementations",
									response: { result: output },
								},
							},
						],
					});
				} else if (functionCall.name === "get_type_definition") {
					const args = functionCall.args as any;
					const filePath = args["path"] as string;
					const line = args["line"] as number;

					// Log to Chat
					const logText = `Finding type definition for symbol at \`${filePath}:${line}\`...`;
					if (postMessageToWebview) {
						postMessageToWebview({
							type: "contextAgentLog",
							value: { text: logText },
						});
					}
					if (addContextAgentLogToHistory) {
						addContextAgentLogToHistory(logText);
					}

					// Execute
					let output = "";
					try {
						const fullPath = path.join(projectRoot.fsPath, filePath);
						const position = new vscode.Position(line - 1, 0);

						const locationOrArr = await getTypeDefinition(
							vscode.Uri.file(fullPath),
							position,
							cancellationToken,
						);
						const locations = Array.isArray(locationOrArr)
							? locationOrArr
							: locationOrArr
								? [locationOrArr]
								: [];

						if (locations && locations.length > 0) {
							const results = locations.map((l) => {
								const relativePath = path
									.relative(projectRoot.fsPath, l.uri.fsPath)
									.replace(/\\/g, "/");
								return `- ${relativePath}:${l.range.start.line + 1}`;
							});
							output = `Found type definition(s) at:\n${results.join("\n")}`;
						} else {
							output = `No type definition found for symbol at ${filePath}:${line}.`;
						}
					} catch (e: any) {
						output = `Error finding type definition: ${e.message}`;
					}

					// Log output to chat
					const displayOutput =
						output.length > 10000 ? output.substring(0, 10000) + "..." : output;
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
									name: "get_type_definition",
									response: { result: output },
								},
							},
						],
					});
				} else if (functionCall.name === "get_call_hierarchy_incoming") {
					const args = functionCall.args as any;
					const filePath = args["path"] as string;
					const line = args["line"] as number;

					// Log to Chat
					const logText = `Finding incoming calls for function at \`${filePath}:${line}\`...`;
					if (postMessageToWebview) {
						postMessageToWebview({
							type: "contextAgentLog",
							value: { text: logText },
						});
					}
					if (addContextAgentLogToHistory) {
						addContextAgentLogToHistory(logText);
					}

					// Execute
					let output = "";
					try {
						const fullPath = path.join(projectRoot.fsPath, filePath);
						const position = new vscode.Position(line - 1, 0);

						const items = await prepareCallHierarchy(
							vscode.Uri.file(fullPath),
							position,
							cancellationToken,
						);

						if (items && items.length > 0) {
							const incomingCalls = await resolveIncomingCalls(
								items[0],
								cancellationToken,
							);
							if (incomingCalls && incomingCalls.length > 0) {
								const results = incomingCalls.map((c: any) => {
									const relativePath = path
										.relative(projectRoot.fsPath, c.from.uri.fsPath)
										.replace(/\\/g, "/");
									return `- ${c.from.name} (${relativePath}:${c.from.range.start.line + 1})`;
								});
								output = `Found ${incomingCalls.length} incoming call(s):\n${results.join("\n")}`;
							} else {
								output = `No incoming calls found for function "${items[0].name}".`;
							}
						} else {
							output = `No call hierarchy item found at ${filePath}:${line}.`;
						}
					} catch (e: any) {
						output = `Error finding incoming calls: ${e.message}`;
					}

					// Log output to chat
					const displayOutput =
						output.length > 10000 ? output.substring(0, 10000) + "..." : output;
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
									name: "get_call_hierarchy_incoming",
									response: { result: output },
								},
							},
						],
					});
				} else if (functionCall.name === "get_call_hierarchy_outgoing") {
					const args = functionCall.args as any;
					const filePath = args["path"] as string;
					const line = args["line"] as number;

					// Log to Chat
					const logText = `Finding outgoing calls for function at \`${filePath}:${line}\`...`;
					if (postMessageToWebview) {
						postMessageToWebview({
							type: "contextAgentLog",
							value: { text: logText },
						});
					}
					if (addContextAgentLogToHistory) {
						addContextAgentLogToHistory(logText);
					}

					// Execute
					let output = "";
					try {
						const fullPath = path.join(projectRoot.fsPath, filePath);
						const position = new vscode.Position(line - 1, 0);

						const items = await prepareCallHierarchy(
							vscode.Uri.file(fullPath),
							position,
							cancellationToken,
						);

						if (items && items.length > 0) {
							const outgoingCalls = await resolveOutgoingCalls(
								items[0],
								cancellationToken,
							);
							if (outgoingCalls && outgoingCalls.length > 0) {
								const results = outgoingCalls.map((c: any) => {
									const relativePath = path
										.relative(projectRoot.fsPath, c.to.uri.fsPath)
										.replace(/\\/g, "/");
									return `- Calls ${c.to.name} (${relativePath}:${c.to.range.start.line + 1})`;
								});
								output = `Found ${outgoingCalls.length} outgoing call(s):\n${results.join("\n")}`;
							} else {
								output = `No outgoing calls found for function "${items[0].name}".`;
							}
						} else {
							output = `No call hierarchy item found at ${filePath}:${line}.`;
						}
					} catch (e: any) {
						output = `Error finding outgoing calls: ${e.message}`;
					}

					// Log output to chat
					const displayOutput =
						output.length > 10000 ? output.substring(0, 10000) + "..." : output;
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
									name: "get_call_hierarchy_outgoing",
									response: { result: output },
								},
							},
						],
					});
				} else if (functionCall.name === "get_file_diagnostics") {
					const args = functionCall.args as any;
					const filePath = args["path"] as string;

					// Log to Chat
					const logText = `Checking diagnostics for \`${filePath}\`...`;
					if (postMessageToWebview) {
						postMessageToWebview({
							type: "contextAgentLog",
							value: { text: logText },
						});
					}
					if (addContextAgentLogToHistory) {
						addContextAgentLogToHistory(logText);
					}

					// Execute
					let output = "";
					try {
						const fullPath = path.join(projectRoot.fsPath, filePath);
						const diagnostics = DiagnosticService.getDiagnosticsForUri(
							vscode.Uri.file(fullPath),
						);

						if (diagnostics && diagnostics.length > 0) {
							const results = diagnostics.map((d) => {
								const severity = vscode.DiagnosticSeverity[d.severity];
								return `[${severity}] Line ${d.range.start.line + 1}: ${d.message}`;
							});
							output = `Found ${diagnostics.length} diagnostic(s):\n${results.join("\n")}`;
						} else {
							output = `No diagnostics found for "${filePath}".`;
						}
					} catch (e: any) {
						output = `Error getting diagnostics: ${e.message}`;
					}

					// Log output to chat
					const displayOutput =
						output.length > 10000 ? output.substring(0, 10000) + "..." : output;
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
									name: "get_file_diagnostics",
									response: { result: output },
								},
							},
						],
					});
				} else if (functionCall.name === "get_git_diffs") {
					const args = functionCall.args as any;
					const diffType = args["type"] as "staged" | "head";

					// Log to Chat
					const logText = `Getting git ${diffType} diffs...`;
					if (postMessageToWebview) {
						postMessageToWebview({
							type: "contextAgentLog",
							value: { text: logText },
						});
					}
					if (addContextAgentLogToHistory) {
						addContextAgentLogToHistory(logText);
					}

					// Execute
					let output = "";
					try {
						if (diffType === "staged") {
							output = await getGitStagedDiff(projectRoot.fsPath);
						} else {
							// For 'head', we might need another function or execute shell command
							// For now, let's just use staged as a primary example or fallback to command
							output = await SafeCommandExecutor.execute(
								"git diff HEAD",
								projectRoot.fsPath,
							);
						}

						if (!output || output.trim() === "") {
							output = `No ${diffType} changes found.`;
						}
					} catch (e: any) {
						output = `Error getting git diffs: ${e.message}`;
					}

					// Log output to chat
					const displayOutput =
						output.length > 10000 ? output.substring(0, 10000) + "..." : output;
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
									name: "get_git_diffs",
									response: { result: output },
								},
							},
						],
					});
				} else if (functionCall.name === "read_file") {
					const args = functionCall.args as any;
					const filePath = args["path"] as string;
					const startLine = args["startLine"] as number;
					const endLine = args["endLine"] as number;

					// Log to Chat
					const logText = `Reading \`${filePath}\` (lines ${startLine}-${endLine})...`;
					if (postMessageToWebview) {
						postMessageToWebview({
							type: "contextAgentLog",
							value: { text: logText },
						});
					}
					if (addContextAgentLogToHistory) {
						addContextAgentLogToHistory(logText);
					}

					// Execute using internal sed command via safe executor
					let output = "";
					try {
						// Format: sed -n 'start,endp' file
						const sedCommand = `sed -n '${startLine},${endLine}p' ${filePath}`;
						output = await SafeCommandExecutor.execute(
							sedCommand,
							projectRoot.fsPath,
						);
						if (!output.trim()) {
							output = "(No content found in this range or file is empty)";
						}
					} catch (e: any) {
						output = `Error reading file: ${e.message}`;
					}

					// Log output to chat
					const displayOutput =
						output.length > 5000
							? output.substring(0, 5000) + "\n... (truncated)"
							: output;
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

					// Update History
					const modelParts: any[] = [];
					if (thought) {
						modelParts.push({ text: thought });
					}
					modelParts.push({ functionCall: functionCall });

					currentHistory.push({
						role: "model",
						parts: modelParts,
					});
					currentHistory.push({
						role: "function",
						parts: [
							{
								functionResponse: {
									name: "read_file",
									response: { result: output },
								},
							},
						],
					});
				} else {
					const unknownToolName = functionCall.name;
					console.warn(
						`[SmartContextSelector] Unknown tool: ${unknownToolName}`,
					);

					// Provide feedback to the model instead of crashing/terminating the loop
					const allowedTools = (tools[0] as any).functionDeclarations
						.map((f: any) => f.name)
						.join(", ");
					const feedback = `Error: The tool "${unknownToolName}" is not available. Please use one of the allowed tools: ${allowedTools}.`;

					const modelParts: any[] = [];
					if (thought) {
						modelParts.push({ text: thought });
					}
					modelParts.push({ functionCall: functionCall });

					currentHistory.push({
						role: "model",
						parts: modelParts,
					});
					currentHistory.push({
						role: "function",
						parts: [
							{
								functionResponse: {
									name: unknownToolName,
									response: { error: feedback },
								},
							},
						],
					});

					if (postMessageToWebview) {
						postMessageToWebview({
							type: "contextAgentLog",
							value: {
								text: `<span style="color: var(--vscode-errorForeground);">[Error]</span> Attempted to use unknown tool "${unknownToolName}". Providing feedback to agent.`,
							},
						});
					}
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
				preSelectedPriorityFiles,
			);
			aiSelectionCache.set(cacheKey, {
				timestamp: Date.now(),
				selectedFiles: result,
				userRequest,
				activeFile: activeEditorContext?.filePath,
				fileCount: allScannedFiles.length,
				priorityFilesCount: preSelectedPriorityFiles?.length || 0,
			});
		}

		return result;
	} catch (error) {
		console.error(
			"[SmartContextSelector] Error during AI file selection:",
			error,
		);
		// Fallback to priority + active file on any error
		// Map Set<vscode.Uri> to FileSelection[]
		return [];
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
		if (!selectedPath || selectedPath.trim() === "") {
			continue;
		}

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

	return finalResultSelections;
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
		priorityCount: number;
	}>;
} {
	const entries = Array.from(aiSelectionCache.entries()).map(
		([key, cache]) => ({
			request: cache.userRequest.substring(0, 50) + "...",
			age: Date.now() - cache.timestamp,
			fileCount: cache.fileCount,
			selectedCount: cache.selectedFiles.length,
			priorityCount: cache.priorityFilesCount,
		}),
	);

	return {
		size: aiSelectionCache.size,
		entries,
	};
}
