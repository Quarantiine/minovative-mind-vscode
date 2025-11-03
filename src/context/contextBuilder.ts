import * as ContextSectionBuilder from "./contextSectionBuilder";
import * as vscode from "vscode";
import * as path from "path";
import { FileChangeEntry } from "../types/workflow";
import { ActiveSymbolDetailedInfo } from "../services/contextService";
import { intelligentlySummarizeFileContent } from "./fileContentProcessor";
import { DEFAULT_SIZE } from "../sidebar/common/sidebarConstants";

// Configuration for context building - Adjusted for large context windows
interface ContextConfig {
	maxFileLength: number; // Maximum characters per file content
	maxTotalLength: number; // Approximate total character limit for the context string
	maxSymbolEntriesPerFile: number; // Maximum symbol entries to include per file
	maxTotalSymbolChars: number; // Approximate total character limit for the symbol info block
	maxActiveSymbolDetailChars: number;
}

// Default configuration - Adjusted for ~1M token models
export const DEFAULT_CONTEXT_CONFIG: ContextConfig = {
	maxFileLength: DEFAULT_SIZE, // Approx 1MB in characters
	maxTotalLength: DEFAULT_SIZE, // Approx 1MB in characters
	maxSymbolEntriesPerFile: 40, // # symbols per file
	maxTotalSymbolChars: 100000, // Default to 100KB for the entire symbols section
	maxActiveSymbolDetailChars: 100000, // Default to 100KB
};

/**
 * Interface for files considered during prioritization, including a relevance score.
 */
interface PrioritizedFile {
	uri: vscode.Uri;
	score: number;
}

/**
 * Initializes the build context string with workspace name and file count header.
 * @param workspaceRoot The root URI of the workspace.
 * @param relevantFiles An array of vscode.Uri objects for relevant files.
 * @returns An object containing the initial context string and its length.
 */
function _initializeBuildContext(
	workspaceRoot: vscode.Uri,
	relevantFiles: vscode.Uri[]
): { context: string; currentTotalLength: number } {
	let context = `Project Context (Workspace: ${path.basename(
		workspaceRoot.fsPath
	)}):\n`;
	context += `Relevant files identified: ${relevantFiles.length}\n\n`;
	const currentTotalLength = context.length;
	console.log(
		`Context initialized. Current size: ${currentTotalLength} chars.`
	);
	return { context, currentTotalLength };
}

/**
 * Encapsulates the entire dynamic file prioritization logic (scoring and sorting `relevantFiles`).
 * Uses `dependencyGraph`, `reverseDependencyGraph`, `activeSymbolDetailedInfo`, `documentSymbols`, and `config`.
 * @param relevantFiles An array of vscode.Uri objects for relevant files.
 * @param workspaceRoot The root URI of the workspace.
 * @param dependencyGraph Optional map representing file import/dependency relations.
 * @param reverseDependencyGraph Optional map representing reverse file import/dependency relations.
 * @param activeSymbolDetailedInfo Optional detailed information about the active symbol.
 * @param documentSymbols Optional map containing document symbols for relevant files.
 * @param config Configuration for context building.
 * @returns A sorted array of `vscode.Uri[]` representing the prioritized files.
 */
function _prioritizeFilesForContext(
	relevantFiles: vscode.Uri[],
	workspaceRoot: vscode.Uri,
	dependencyGraph: Map<string, string[]> | undefined,
	reverseDependencyGraph: Map<string, string[]> | undefined,
	activeSymbolDetailedInfo: ActiveSymbolDetailedInfo | undefined,
	documentSymbols: Map<string, vscode.DocumentSymbol[] | undefined> | undefined,
	config: ContextConfig,
	historicallyRelevantFiles?: vscode.Uri[]
): vscode.Uri[] {
	let prioritizedFiles: PrioritizedFile[] = relevantFiles.map((uri) => ({
		uri,
		score: 0,
	}));

	// Assign scores based on relevance
	for (const pf of prioritizedFiles) {
		const relativePath = path
			.relative(workspaceRoot.fsPath, pf.uri.fsPath)
			.replace(/\\/g, "/");

		// Highest priority: Active file
		if (activeSymbolDetailedInfo?.filePath === relativePath) {
			pf.score += 1000;
			// Even higher if its definition is the active symbol's full range
			if (
				activeSymbolDetailedInfo.fullRange &&
				activeSymbolDetailedInfo.filePath === relativePath
			) {
				pf.score += 200;
			}
		}

		// High priority: Files related to active symbol (definitions, implementations, references, call hierarchy)
		const activeSymbolRelatedPaths: Set<string> = new Set();
		if (activeSymbolDetailedInfo) {
			if (activeSymbolDetailedInfo.definition) {
				const definitionLoc = Array.isArray(activeSymbolDetailedInfo.definition)
					? activeSymbolDetailedInfo.definition[0]
					: activeSymbolDetailedInfo.definition;
				if (definitionLoc?.uri) {
					activeSymbolRelatedPaths.add(
						path
							.relative(workspaceRoot.fsPath, definitionLoc.uri.fsPath)
							.replace(/\\/g, "/")
					);
				}
			}
			if (activeSymbolDetailedInfo.typeDefinition) {
				const typeDefLoc = Array.isArray(
					activeSymbolDetailedInfo.typeDefinition
				)
					? activeSymbolDetailedInfo.typeDefinition[0]
					: activeSymbolDetailedInfo.typeDefinition;
				if (typeDefLoc?.uri) {
					activeSymbolRelatedPaths.add(
						path
							.relative(workspaceRoot.fsPath, typeDefLoc.uri.fsPath)
							.replace(/\\/g, "/")
					);
				}
			}
			activeSymbolDetailedInfo.implementations?.forEach((loc) =>
				activeSymbolRelatedPaths.add(
					path
						.relative(workspaceRoot.fsPath, loc.uri.fsPath)
						.replace(/\\/g, "/")
				)
			);
			activeSymbolDetailedInfo.referencedTypeDefinitions?.forEach((_, fp) =>
				activeSymbolRelatedPaths.add(fp)
			);
			activeSymbolDetailedInfo.incomingCalls?.forEach((call) =>
				activeSymbolRelatedPaths.add(
					path
						.relative(workspaceRoot.fsPath, call.from.uri.fsPath)
						.replace(/\\/g, "/")
				)
			);
			activeSymbolDetailedInfo.outgoingCalls?.forEach((call) =>
				activeSymbolRelatedPaths.add(
					path
						.relative(workspaceRoot.fsPath, call.to.uri.fsPath)
						.replace(/\\/g, "/")
				)
			);
		}
		if (activeSymbolRelatedPaths.has(relativePath)) {
			pf.score += 500;
		}

		// Medium-high priority: Direct dependencies of other highly-scored files or the active file
		const directDependencies = dependencyGraph?.get(relativePath);
		if (directDependencies && directDependencies.length > 0) {
			pf.score += 100; // Bonus for files that import others
		}

		// Medium priority: Files that import the active file (reverse dependencies) or are imported by other relevant files
		const reverseDependencies = reverseDependencyGraph?.get(relativePath);
		if (reverseDependencies && reverseDependencies.length > 0) {
			pf.score += 80; // Bonus for files that are imported by others
		}

		// Low-medium priority: Files with significant symbols, even if not directly related to active symbol
		if (
			documentSymbols?.get(relativePath)?.length &&
			documentSymbols.get(relativePath)!.length >
				config.maxSymbolEntriesPerFile / 2
		) {
			pf.score += 50;
		}
	}

	if (historicallyRelevantFiles && historicallyRelevantFiles.length > 0) {
		const historicalPaths = new Set(
			historicallyRelevantFiles.map((uri) => uri.fsPath)
		);
		for (const pf of prioritizedFiles) {
			if (historicalPaths.has(pf.uri.fsPath)) {
				pf.score += 2000;
			}
		}
	}

	// Sort files: active file first, then by score (descending), then by path for tie-breaking
	prioritizedFiles.sort((a, b) => {
		// Keep active file absolutely first if it's present and highly scored
		const aIsActiveFile =
			activeSymbolDetailedInfo?.filePath &&
			path.relative(workspaceRoot.fsPath, a.uri.fsPath).replace(/\\/g, "/") ===
				activeSymbolDetailedInfo.filePath;
		const bIsActiveFile =
			activeSymbolDetailedInfo?.filePath &&
			path.relative(workspaceRoot.fsPath, b.uri.fsPath).replace(/\\/g, "/") ===
				activeSymbolDetailedInfo.filePath;

		if (aIsActiveFile && !bIsActiveFile) {
			return -1;
		}
		if (!aIsActiveFile && bIsActiveFile) {
			return 1;
		}

		if (b.score !== a.score) {
			return b.score - a.score; // Higher score comes first
		}
		return a.uri.fsPath.localeCompare(b.uri.fsPath); // Alphabetical for tie-breaking
	});

	return prioritizedFiles.map((pf) => pf.uri);
}

/**
 * Iterates through prioritized files, reads their content, intelligently summarizes it,
 * constructs the content block (including imports), applies strict length checks,
 * and handles truncation for each file. It tracks skipped files due to limits.
 * @param sortedRelevantFiles A sorted array of vscode.Uri objects for files.
 * @param workspaceRoot The root URI of the workspace.
 * @param config Configuration for context building.
 * @param currentContext The current context string.
 * @param currentTotalLength The current total length of the context string.
 * @param filesSkippedForTotalSize The number of files skipped so far due to total size limits.
 * @param dependencyGraph Optional map representing file import/dependency relations.
 * @param documentSymbols Optional map containing document symbols for relevant files.
 * @param activeSymbolDetailedInfo Optional detailed information about the active symbol.
 * @returns A promise that resolves to an object containing the updated context string, its length, and the updated skipped file count.
 */
async function _processFileContentsForContext(
	sortedRelevantFiles: vscode.Uri[],
	workspaceRoot: vscode.Uri,
	config: ContextConfig,
	currentContext: string,
	currentTotalLength: number,
	filesSkippedForTotalSize: number,
	dependencyGraph?: Map<string, string[]>,
	documentSymbols?: Map<string, vscode.DocumentSymbol[] | undefined>,
	activeSymbolDetailedInfo?: ActiveSymbolDetailedInfo
): Promise<{
	context: string;
	currentTotalLength: number;
	filesSkippedForTotalSize: number;
}> {
	let context = currentContext;
	let length = currentTotalLength;
	let skippedCount = filesSkippedForTotalSize;
	let contentAdded = false; // Track if any content was added

	const contentHeader = "File Contents (partial):\n";
	context += contentHeader;
	length += contentHeader.length;

	for (const fileUri of sortedRelevantFiles) {
		// Check if we have *any* space left for content
		if (length >= config.maxTotalLength) {
			skippedCount =
				sortedRelevantFiles.length - sortedRelevantFiles.indexOf(fileUri);
			console.log(
				`Skipping remaining ${skippedCount} file contents as total limit reached.`
			);
			break; // Stop processing file contents immediately
		}

		const relativePath = path
			.relative(workspaceRoot.fsPath, fileUri.fsPath)
			.replace(/\\/g, "/");
		const fileHeader = `--- File: ${relativePath} ---\n`;

		let importRelationsDisplay = "";
		if (dependencyGraph) {
			const imports = dependencyGraph.get(relativePath);
			if (imports && imports.length > 0) {
				const maxImportsToDisplay = 10;
				const displayedImports = imports
					.slice(0, maxImportsToDisplay)
					.map((imp) => `'${imp}'`)
					.join(", ");
				const remainingImportsCount = imports.length - maxImportsToDisplay;
				const suffix =
					remainingImportsCount > 0
						? ` (and ${remainingImportsCount} more)`
						: "";
				importRelationsDisplay = `imports: ${displayedImports}${suffix}\n`;
			} else {
				importRelationsDisplay = `imports: No Imports\n`;
			}
		} else {
			importRelationsDisplay = `imports: No Imports (Dependency graph not provided)\n`;
		}

		let fileContentRaw = "";
		let fileContentForContext = "";
		let truncatedForSmartSummary = false;

		try {
			const contentBytes = await vscode.workspace.fs.readFile(fileUri);
			fileContentRaw = Buffer.from(contentBytes).toString("utf-8");

			const symbolsForFile = documentSymbols?.get(relativePath);

			const isActiveFile = activeSymbolDetailedInfo?.filePath === relativePath;
			let activeSymbolInfoForCurrentFile: ActiveSymbolDetailedInfo | undefined =
				undefined;
			if (isActiveFile) {
				activeSymbolInfoForCurrentFile = activeSymbolDetailedInfo;
			}

			fileContentForContext = intelligentlySummarizeFileContent(
				fileContentRaw,
				symbolsForFile,
				activeSymbolInfoForCurrentFile,
				config.maxFileLength
			);

			if (fileContentForContext.length < fileContentRaw.length) {
				truncatedForSmartSummary = true;
			}
		} catch (error) {
			console.warn(
				`Could not read or intelligently summarize file content for ${relativePath}:`,
				error
			);
			fileContentForContext = `[Error reading/summarizing file: ${
				error instanceof Error ? error.message : String(error)
			}]`;
			truncatedForSmartSummary = true; // Mark as truncated/incomplete due to error
		}

		const summaryTruncationMessage = "\n[...content intelligently summarized]";
		const closingNewlines = "\n\n";

		const baseContentLength =
			fileHeader.length +
			importRelationsDisplay.length +
			closingNewlines.length;

		let contentToAdd = "";
		let estimatedLengthIncrease = 0;

		// Calculate how much space is remaining in the total context
		const availableTotalContextSpace = config.maxTotalLength - length;

		// Determine the actual length of the summarized content we can try to add
		// This must respect individual file max length AND total context max length.
		const maxSummarizedContentLength = Math.min(
			config.maxFileLength, // Max per file
			availableTotalContextSpace -
				baseContentLength -
				summaryTruncationMessage.length // Space left in total, considering header/footer/truncation message
		);

		if (maxSummarizedContentLength <= 0) {
			// Cannot even fit the header and truncation message for this file, skip.
			skippedCount =
				sortedRelevantFiles.length - sortedRelevantFiles.indexOf(fileUri);
			console.log(
				`Skipping remaining ${skippedCount} file contents as total limit reached before adding ${relativePath}.`
			);
			break;
		}

		// Truncate fileContentForContext if it exceeds the calculated maxSummarizedContentLength
		let actualFileContentToAdd = fileContentForContext;
		let currentFileTruncatedForTotalSize = false;

		if (fileContentForContext.length > maxSummarizedContentLength) {
			actualFileContentToAdd = fileContentForContext.substring(
				0,
				maxSummarizedContentLength
			);
			truncatedForSmartSummary = true; // Mark as truncated, even if originally wasn't (now it is for total size)
			currentFileTruncatedForTotalSize = true;
		}

		contentToAdd =
			fileHeader +
			importRelationsDisplay +
			actualFileContentToAdd +
			(truncatedForSmartSummary ? summaryTruncationMessage : "") +
			closingNewlines;

		estimatedLengthIncrease = contentToAdd.length;

		// If after all calculations, it's still too large for the remaining total context,
		// or if we truncated it to something too small, log and skip/further truncate.
		if (length + estimatedLengthIncrease > config.maxTotalLength) {
			// This scenario means maxSummarizedContentLength was still too optimistic or a small message overflowed.
			// It should ideally not be hit if `maxSummarizedContentLength` is calculated correctly,
			// but as a failsafe, we truncate to exactly what fits + a minimal message.
			const finalAvailableSpace = config.maxTotalLength - length;
			if (
				finalAvailableSpace >
				(fileHeader + summaryTruncationMessage + closingNewlines).length
			) {
				const truncateContentTo =
					finalAvailableSpace -
					(
						fileHeader +
						importRelationsDisplay +
						summaryTruncationMessage +
						closingNewlines
					).length;
				contentToAdd =
					fileHeader +
					importRelationsDisplay +
					actualFileContentToAdd.substring(0, Math.max(0, truncateContentTo)) +
					summaryTruncationMessage +
					closingNewlines;
				length += contentToAdd.length;
				context += contentToAdd;
				console.log(
					`Added heavily truncated content for ${relativePath} to fit total limit.`
				);
				contentAdded = true;
			} else {
				console.warn(
					`Could not fit even a minimal entry for ${relativePath} into total context.`
				);
			}
			skippedCount =
				sortedRelevantFiles.length - sortedRelevantFiles.indexOf(fileUri);
			console.log(
				`Skipping remaining ${skippedCount} file contents as total limit reached.`
			);
			break; // Stop processing further files
		}

		context += contentToAdd;
		length += estimatedLengthIncrease;
		contentAdded = true;
		console.log(
			`Added content for ${relativePath}. Current total size: ${length} chars.`
		);
	}

	// Add final skipped message if needed
	if (!contentAdded && length < config.maxTotalLength) {
		context += "\n(No file content included due to size limits or errors)";
	} else if (skippedCount > 0) {
		context += `\n... (Content from ${skippedCount} more files omitted due to total size limit)`;
	}

	return {
		context,
		currentTotalLength: length,
		filesSkippedForTotalSize: skippedCount,
	};
}

/**
 * Builds a textual context string from a list of file URIs.
 * Reads file content, formats it, and applies limits.
 * Now tailored for larger context window models.
 * @param relevantFiles An array of vscode.Uri objects for relevant files.
 * @param workspaceRoot The root URI of the workspace for relative paths.
 * @param config Optional configuration for context building.
 * @param recentChanges Optional array of recent file changes to include.
 * @param dependencyGraph Optional map representing file import/dependency relations.
 * @param documentSymbols Optional map containing document symbols for relevant files.
 * @param activeSymbolDetailedInfo Optional detailed information about the active symbol.
 * @param reverseDependencyGraph Optional map representing reverse file import/dependency relations.
 * @returns A promise that resolves to the generated context string.
 */
export async function buildContextString(
	relevantFiles: vscode.Uri[],
	workspaceRoot: vscode.Uri,
	config: ContextConfig = DEFAULT_CONTEXT_CONFIG,
	recentChanges?: FileChangeEntry[],
	dependencyGraph?: Map<string, string[]>,
	documentSymbols?: Map<string, vscode.DocumentSymbol[] | undefined>,
	activeSymbolDetailedInfo?: ActiveSymbolDetailedInfo,
	reverseDependencyGraph?: Map<string, string[]>,
	historicallyRelevantFiles?: vscode.Uri[]
): Promise<string> {
	let { context, currentTotalLength } = _initializeBuildContext(
		workspaceRoot,
		relevantFiles
	);
	let filesSkippedForTotalSize = 0; // For file *content* skipping

	// 1. Add File Structure
	({ context, currentTotalLength } =
		ContextSectionBuilder.addFileStructureToContext(
			relevantFiles,
			workspaceRoot,
			context,
			currentTotalLength,
			config
		));

	// If maxed out after adding structure, stop
	if (currentTotalLength >= config.maxTotalLength) {
		console.warn("Total context limit reached after file structure.");
		return context.trim();
	}

	// 2. Add Recent Project Changes
	({ context, currentTotalLength } =
		ContextSectionBuilder.addRecentChangesToContext(
			recentChanges,
			context,
			currentTotalLength,
			config
		));

	if (currentTotalLength >= config.maxTotalLength) {
		console.warn("Total context limit reached after recent changes.");
		return context.trim();
	}

	// 3. Add Existing File Paths Section
	({ context, currentTotalLength } =
		ContextSectionBuilder.addExistingFilePathsSection(
			relevantFiles,
			workspaceRoot,
			context,
			currentTotalLength,
			config
		));

	if (currentTotalLength >= config.maxTotalLength) {
		console.warn("Total context limit reached after existing file paths.");
		return context.trim();
	}

	// 4. Add Modified/Created File Paths Section
	({ context, currentTotalLength } =
		ContextSectionBuilder.addModifiedCreatedPathsSection(
			recentChanges,
			workspaceRoot,
			context,
			currentTotalLength,
			config
		));

	if (currentTotalLength >= config.maxTotalLength) {
		console.warn("Total context limit reached after modified/created paths.");
		return context.trim();
	}

	// 5. Add Symbol Information
	({ context, currentTotalLength } = ContextSectionBuilder.addSymbolInfoSection(
		documentSymbols,
		relevantFiles,
		workspaceRoot,
		context,
		currentTotalLength,
		config
	));

	if (currentTotalLength >= config.maxTotalLength) {
		console.warn("Total context limit reached after symbol information.");
		return context.trim();
	}

	// 6. Add Active Symbol Detailed Information
	({ context, currentTotalLength } =
		ContextSectionBuilder.addActiveSymbolDetailSection(
			activeSymbolDetailedInfo,
			workspaceRoot,
			context,
			currentTotalLength,
			config
		));

	if (currentTotalLength >= config.maxTotalLength) {
		console.warn("Total context limit reached after active symbol detail.");
		return context.trim();
	}

	// 7. Prioritize Files for Content Inclusion
	const sortedRelevantFiles = _prioritizeFilesForContext(
		relevantFiles,
		workspaceRoot,
		dependencyGraph,
		reverseDependencyGraph,
		activeSymbolDetailedInfo,
		documentSymbols,
		config,
		historicallyRelevantFiles
	);

	// 8. Process File Contents
	({ context, currentTotalLength, filesSkippedForTotalSize } =
		await _processFileContentsForContext(
			sortedRelevantFiles,
			workspaceRoot,
			config,
			context,
			currentTotalLength,
			filesSkippedForTotalSize,
			dependencyGraph,
			documentSymbols,
			activeSymbolDetailedInfo
		));

	// Diagnostic log for final size
	console.log(`Final context size: ${currentTotalLength} characters.`);
	return context.trim(); // Remove any trailing whitespace
}
