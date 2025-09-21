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

const MAX_FILE_SUMMARY_LENGTH_FOR_AI_SELECTION = 10000;
export { MAX_FILE_SUMMARY_LENGTH_FOR_AI_SELECTION };

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
	aiModelCall: (
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
		chatHistory,
		allScannedFiles,
		projectRoot,
		activeEditorContext,
		fileDependencies,
		activeEditorSymbols,
		preSelectedHeuristicFiles,
		fileSummaries,
		activeSymbolDetailedInfo,
		aiModelCall,
		modelName,
		cancellationToken,
		selectionOptions,
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

	const fileListString =
		"--- Available Project Files ---\n" +
		relativeFilePaths
			.map((p) => {
				const summary = fileSummaries?.get(p);
				return `- "${p}"${
					summary
						? ` (Summary: ${summary.substring(0, 200).replace(/\s+/g, " ")}...)`
						: ""
				}`;
			})
			.join("\n");

	const selectionPrompt = `
You are an expert AI developer assistant. Your task is to select the most relevant files to help with a user's request.

-- Context --
${contextPrompt}
-- End Context --

${fileListString}

-- Instructions --
1.  **Analyze the Goal**: Understand the user's request and the provided context, especially the Active Symbol Information.
2.  **Prioritize Functional Relationships**: The 'Active Symbol Detailed Information' is the most critical input. Files containing definitions, implementations, callers (incoming calls), or callees (outgoing calls) of the active symbol are extremely important. These represent the functional skeleton of the task.
3.  **Use Summaries for Semantic Relevance**: Evaluate the file summaries. Select files whose purpose and abstractions are semantically related to the user's request, even if they aren't directly linked by symbols.
4.  **Critically Evaluate Heuristics**: The 'Heuristically Pre-selected Files' are just suggestions. Your job is to be more precise. **Aggressively discard any file that is not absolutely essential** for the task. Focus on quality over quantity.
5.  **Output Format**: Return a JSON array of strings, where each string is an exact relative file path from the "Available Project Files" list. Do not include files not in the list. Your entire response must be ONLY the JSON array.

JSON Array of selected file paths:
`;

	console.log(
		`[SmartContextSelector] Sending prompt to AI for file selection (${selectionPrompt.length} chars)`
	);

	try {
		const generationConfig: GenerationConfig = {
			temperature: TEMPERATURE,
			responseMimeType: "application/json",
		};

		const aiResponse = await aiModelCall(
			selectionPrompt,
			modelName,
			undefined,
			"file_selection",
			generationConfig,
			undefined,
			cancellationToken
		);

		console.log(
			"[SmartContextSelector] AI response for file selection:",
			aiResponse
		);

		const selectedPaths = JSON.parse(aiResponse.trim());
		if (
			!Array.isArray(selectedPaths) ||
			!selectedPaths.every((p) => typeof p === "string")
		) {
			throw new Error("AI did not return a valid JSON array of strings.");
		}

		const projectFileSet = new Set(
			relativeFilePaths.map((p) => p.toLowerCase())
		);
		const finalUris = new Set<vscode.Uri>();

		// Add AI selected files
		for (const selectedPath of selectedPaths as string[]) {
			const normalizedPath = selectedPath.replace(/\\/g, "/");
			if (projectFileSet.has(normalizedPath.toLowerCase())) {
				const originalUri = allScannedFiles.find(
					(uri) =>
						path
							.relative(projectRoot.fsPath, uri.fsPath)
							.replace(/\\/g, "/")
							.toLowerCase() === normalizedPath.toLowerCase()
				);
				if (originalUri) {
					finalUris.add(originalUri);
				}
			}
		}

		let finalResultFiles = Array.from(finalUris);

		// Always include the active file if it exists
		if (
			activeEditorContext?.documentUri &&
			!finalResultFiles.some(
				(uri) => uri.fsPath === activeEditorContext.documentUri.fsPath
			)
		) {
			finalResultFiles.unshift(activeEditorContext.documentUri);
		}

		if (useCache) {
			const cacheKey = generateAISelectionCacheKey(
				userRequest,
				allScannedFiles,
				activeEditorContext,
				preSelectedHeuristicFiles
			);
			aiSelectionCache.set(cacheKey, {
				timestamp: Date.now(),
				selectedFiles: finalResultFiles,
				userRequest,
				activeFile: activeEditorContext?.filePath,
				fileCount: allScannedFiles.length,
				heuristicFilesCount: preSelectedHeuristicFiles?.length || 0,
			});
		}

		return finalResultFiles;
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
