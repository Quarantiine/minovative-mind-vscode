import * as vscode from "vscode";
import { GenerationConfig } from "@google/generative-ai";
import {
	SequentialFileProcessor,
	FileSummary,
} from "./sequentialFileProcessor";
import { AIRequestService } from "./aiRequestService";
import { scanWorkspace } from "../context/workspaceScanner";
import {
	buildDependencyGraph,
	DependencyRelation,
} from "../context/dependencyGraphBuilder";
import { intelligentlySummarizeFileContent } from "../context/fileContentProcessor";
import {
	getHeuristicRelevantFiles,
	HeuristicSelectionOptions,
} from "../context/heuristicContextSelector";
import {
	selectRelevantFilesAI,
	SelectRelevantFilesAIOptions,
} from "../context/smartContextSelector";
import { HistoryEntry, HistoryEntryPart } from "../sidebar/common/sidebarTypes";
import { SettingsManager } from "../sidebar/managers/settingsManager";
import {
	DEFAULT_FLASH_LITE_MODEL,
	DEFAULT_SIZE,
} from "../sidebar/common/sidebarConstants";

export interface SequentialContextOptions {
	enableSequentialProcessing?: boolean;
	maxFilesPerBatch?: number;
	summaryLength?: number;
	enableDetailedAnalysis?: boolean;
	includeDependencies?: boolean;
	complexityThreshold?: "low" | "medium" | "high";
	modelName?: string;
	onProgress?: (
		currentFile: string,
		totalFiles: number,
		progress: number
	) => void;
	onFileProcessed?: (summary: FileSummary) => void;
}

export interface SequentialContextResult {
	contextString: string;
	relevantFiles: vscode.Uri[];
	fileSummaries: FileSummary[];
	processingMetrics: {
		totalFiles: number;
		processedFiles: number;
		totalTime: number;
		averageTimePerFile: number;
	};
	sequentialProcessingEnabled: boolean;
}

export class SequentialContextService {
	private sequentialProcessor: SequentialFileProcessor;
	private aiRequestService: AIRequestService;
	private workspaceRoot: vscode.Uri;
	private postMessageToWebview: (message: any) => void;
	private settingsManager: SettingsManager;
	private fileDependencies: Map<string, DependencyRelation[]>;
	private reverseFileDependencies: Map<string, DependencyRelation[]>;

	constructor(
		aiRequestService: AIRequestService,
		workspaceRoot: vscode.Uri,
		postMessageToWebview: (message: any) => void,
		settingsManager: SettingsManager,
		fileDependencies: Map<string, DependencyRelation[]>,
		reverseFileDependencies: Map<string, DependencyRelation[]>
	) {
		this.aiRequestService = aiRequestService;
		this.workspaceRoot = workspaceRoot;
		this.postMessageToWebview = postMessageToWebview;
		this.settingsManager = settingsManager;
		this.fileDependencies = fileDependencies;
		this.reverseFileDependencies = reverseFileDependencies;
		this.sequentialProcessor = new SequentialFileProcessor(
			aiRequestService,
			workspaceRoot,
			postMessageToWebview,
			this.convertDependencyMapToStringMap(this.fileDependencies),
			this.convertDependencyMapToStringMap(this.reverseFileDependencies)
		);
	}

	/**
	 * Build context using sequential file processing
	 */
	public async buildSequentialContext(
		userRequest: string,
		options: SequentialContextOptions = {}
	): Promise<SequentialContextResult> {
		const {
			enableSequentialProcessing = true,
			maxFilesPerBatch = 20,
			summaryLength = 3000,
			enableDetailedAnalysis = true,
			includeDependencies = true,
			complexityThreshold = "high",
			modelName = DEFAULT_FLASH_LITE_MODEL,
			onProgress,
			onFileProcessed,
		} = options;

		if (!enableSequentialProcessing) {
			// Fallback to traditional context building
			return this.buildTraditionalContext(userRequest);
		}

		this.postMessageToWebview({
			type: "statusUpdate",
			value: "Starting sequential file analysis...",
		});

		// Scan workspace for all files
		const allFiles = await scanWorkspace({
			useCache: true,
			maxConcurrency: 10,
			maxFileSize: DEFAULT_SIZE,
		});

		if (allFiles.length === 0) {
			return {
				contextString: "[No relevant files found in workspace]",
				relevantFiles: [],
				fileSummaries: [],
				processingMetrics: {
					totalFiles: 0,
					processedFiles: 0,
					totalTime: 0,
					averageTimePerFile: 0,
				},
				sequentialProcessingEnabled: true,
			};
		}

		// Filter for relevant files based on user request
		const relevantFiles = await this.filterRelevantFiles(
			allFiles,
			userRequest,
			modelName
		);

		if (relevantFiles.length === 0) {
			return {
				contextString: "[No relevant files found for the given request]",
				relevantFiles: [],
				fileSummaries: [],
				processingMetrics: {
					totalFiles: allFiles.length,
					processedFiles: 0,
					totalTime: 0,
					averageTimePerFile: 0,
				},
				sequentialProcessingEnabled: true,
			};
		}

		this.postMessageToWebview({
			type: "statusUpdate",
			value: `Found ${relevantFiles.length} relevant files out of ${allFiles.length} total files.`,
		});

		// Process only relevant files sequentially
		const result = await this.sequentialProcessor.processFilesSequentially(
			relevantFiles,
			userRequest,
			{
				maxFilesPerBatch,
				summaryLength,
				enableDetailedAnalysis,
				includeDependencies,
				complexityThreshold,
				modelName,
				onProgress,
				onFileProcessed,
			}
		);

		// Build final context string
		const finalContext = this.buildFinalContext(result.summaries, userRequest);

		return {
			contextString: finalContext,
			relevantFiles: relevantFiles,
			fileSummaries: result.summaries,
			processingMetrics: result.processingMetrics,
			sequentialProcessingEnabled: true,
		};
	}

	/**
	 * Build context for a specific file with sequential processing context
	 */
	public async buildFileSpecificContext(
		targetFile: vscode.Uri,
		userRequest: string,
		previousSummaries: FileSummary[] = [],
		options: SequentialContextOptions = {}
	): Promise<SequentialContextResult> {
		const {
			enableSequentialProcessing = true,
			summaryLength = 3000,
			enableDetailedAnalysis = true,
			includeDependencies = true,
			complexityThreshold = "high",
			modelName = DEFAULT_FLASH_LITE_MODEL,
		} = options;

		if (!enableSequentialProcessing) {
			// Fallback to traditional context building
			return this.buildTraditionalContext(userRequest);
		}

		this.postMessageToWebview({
			type: "statusUpdate",
			value: `Analyzing specific file: ${vscode.workspace.asRelativePath(
				targetFile
			)}`,
		});

		// Get sequential context for the target file
		const sequentialContext =
			await this.sequentialProcessor.getFileContextForAI(
				targetFile,
				previousSummaries,
				userRequest
			);

		// Process the target file
		const processingContext = {
			processedFiles: previousSummaries,
			currentContext: sequentialContext,
			totalFiles: previousSummaries.length + 1,
			processedCount: previousSummaries.length,
			userRequest,
			workspaceRoot: this.workspaceRoot,
		};

		const fileSummary = await this.sequentialProcessor.processSingleFile(
			targetFile,
			processingContext,
			{
				summaryLength,
				enableDetailedAnalysis,
				includeDependencies,
				complexityThreshold,
				modelName,
			}
		);

		// Build context with the new file
		const allSummaries = [...previousSummaries, fileSummary];
		const finalContext = this.buildFinalContext(allSummaries, userRequest);

		return {
			contextString: finalContext,
			relevantFiles: [targetFile],
			fileSummaries: allSummaries,
			processingMetrics: {
				totalFiles: allSummaries.length,
				processedFiles: allSummaries.length,
				totalTime: 0, // Not tracked for single file
				averageTimePerFile: 0,
			},
			sequentialProcessingEnabled: true,
		};
	}

	/**
	 * Build incremental context as files are processed
	 */
	public async buildIncrementalContext(
		currentSummaries: FileSummary[],
		userRequest: string,
		options: SequentialContextOptions = {}
	): Promise<string> {
		const { enableSequentialProcessing = true, maxFilesPerBatch = 10 } =
			options;

		if (!enableSequentialProcessing || currentSummaries.length === 0) {
			return "No files processed yet.";
		}

		let context = `Incremental Context Analysis:\n`;
		context += `Files processed: ${currentSummaries.length}\n`;
		context += `User request: ${userRequest}\n\n`;

		// Group files by purpose and complexity
		const byPurpose = new Map<string, FileSummary[]>();
		const byComplexity = {
			high: currentSummaries.filter((f) => f.estimatedComplexity === "high"),
			medium: currentSummaries.filter(
				(f) => f.estimatedComplexity === "medium"
			),
			low: currentSummaries.filter((f) => f.estimatedComplexity === "low"),
		};

		currentSummaries.forEach((file) => {
			const purpose = file.mainPurpose;
			if (!byPurpose.has(purpose)) {
				byPurpose.set(purpose, []);
			}
			byPurpose.get(purpose)!.push(file);
		});

		// Add summary statistics
		context += `File Statistics:\n`;
		context += `- High complexity: ${byComplexity.high.length} files\n`;
		context += `- Medium complexity: ${byComplexity.medium.length} files\n`;
		context += `- Low complexity: ${byComplexity.low.length} files\n\n`;

		context += `Purpose Distribution:\n`;
		for (const [purpose, files] of byPurpose) {
			context += `- ${purpose}: ${files.length} files\
`;
		}
		context += `\n`;

		// Add recent file details (last 3 files)
		const recentFiles = currentSummaries.slice(-3);
		context += `Recently Processed Files:\n`;
		for (const file of recentFiles) {
			context += `\n--- ${file.relativePath} ---\n`;
			context += `Purpose: ${file.mainPurpose}\n`;
			context += `Complexity: ${file.estimatedComplexity}\n`;
			if (file.keyInsights.length > 0) {
				context += `Key Insights: ${file.keyInsights.join(", ")}\n`;
			}
			context += `Summary: ${file.summary.substring(0, 200)}${
				file.summary.length > 200 ? "..." : ""
			}\n`;
		}

		return context;
	}

	/**
	 * Filter files for relevance based on user request
	 */
	private async filterRelevantFiles(
		allFiles: vscode.Uri[],
		userRequest: string,
		modelName: string
	): Promise<vscode.Uri[]> {
		this.postMessageToWebview({
			type: "statusUpdate",
			value: "Identifying relevant files",
		});

		// Retrieve optimization settings
		const optimizationSettings =
			this.settingsManager.getOptimizationSettings() as any;

		// Create a heuristicOptions object
		const heuristicOptions: HeuristicSelectionOptions = {
			maxHeuristicFilesTotal: optimizationSettings.maxHeuristicFilesTotal,
			maxSameDirectoryFiles: optimizationSettings.maxSameDirectoryFiles,
			maxDirectDependencies: optimizationSettings.maxDirectDependencies,
			maxReverseDependencies: optimizationSettings.maxReverseDependencies,
			maxCallHierarchyFiles: optimizationSettings.maxCallHierarchyFiles,
			sameDirectoryWeight: optimizationSettings.sameDirectoryWeight,
			runtimeDependencyWeight: optimizationSettings.runtimeDependencyWeight,
			typeDependencyWeight: optimizationSettings.typeDependencyWeight,
			conceptualProximityWeight: optimizationSettings.conceptualProximityWeight,
			reverseDependencyWeight: optimizationSettings.reverseDependencyWeight,
			callHierarchyWeight: optimizationSettings.callHierarchyWeight,
			definitionWeight: optimizationSettings.definitionWeight,
			implementationWeight: optimizationSettings.implementationWeight,
			typeDefinitionWeight: optimizationSettings.typeDefinitionWeight,
			referencedTypeDefinitionWeight:
				optimizationSettings.referencedTypeDefinitionWeight,
			generalSymbolRelatedBoost: optimizationSettings.generalSymbolRelatedBoost,
			dependencyWeight: optimizationSettings.dependencyWeight,
			directoryWeight: optimizationSettings.directoryWeight,
			neighborDirectoryWeight: optimizationSettings.neighborDirectoryWeight,
			sharedAncestorWeight: optimizationSettings.sharedAncestorWeight,
		};

		// First, use heuristic selection to get initial relevant files
		const heuristicFiles = await getHeuristicRelevantFiles(
			allFiles,
			this.workspaceRoot,
			undefined, // No active editor context for filtering
			this.fileDependencies, // Pass structured dependency map
			this.convertDependencyMapToStringMap(this.reverseFileDependencies), // Pass structured reverse dependency map
			undefined, // No active symbol info for filtering
			undefined, // No semantic graph
			undefined, // No cancellation token
			heuristicOptions // Pass heuristicOptions as options parameter
		);

		// If we have a reasonable number of files, use AI to refine the selection
		if (heuristicFiles.length > 0 && heuristicFiles.length <= 100) {
			try {
				this.postMessageToWebview({
					type: "statusUpdate",
					value: "Using AI to refine file selection...",
				});

				// Generate quick summaries for AI selection
				const fileSummaries = new Map<string, string>();
				const summaryPromises = heuristicFiles
					.slice(0, 30)
					.map(async (fileUri) => {
						try {
							const contentBytes = await vscode.workspace.fs.readFile(fileUri);
							const fileContent = Buffer.from(contentBytes).toString("utf-8");
							const relativePath = vscode.workspace.asRelativePath(fileUri);

							// Generate a quick summary
							const summary = intelligentlySummarizeFileContent(
								fileContent,
								undefined, // No symbols for quick filtering
								undefined,
								500 // Shorter summary for filtering
							);

							fileSummaries.set(relativePath, summary);
						} catch (error) {
							console.warn(`Failed to read file ${fileUri.fsPath}:`, error);
						}
					});

				await Promise.all(summaryPromises);

				// Use AI to select the most relevant files
				const aiSelectionOptions: SelectRelevantFilesAIOptions = {
					userRequest,
					chatHistory: [], // No chat history for filtering
					allScannedFiles: heuristicFiles,
					projectRoot: this.workspaceRoot,
					activeEditorContext: undefined,
					diagnostics: undefined,
					// The aiModelCall in SelectRelevantFilesAIOptions expects (prompt: HistoryEntryPart[], options: AIGenerateOptions) => Promise<string>
					// If this.aiRequestService.generateWithRetry still takes a string, an adapter is needed.
					// This resolves TS2322 at line 404 by conforming to the expected type.
					aiModelCall: async (
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
					) => {
						const userContentParts: HistoryEntryPart[] = [{ text: prompt }];
						return await this.aiRequestService.generateWithRetry(
							userContentParts,
							modelName,
							history,
							requestType,
							generationConfig,
							streamCallbacks,
							token
						);
					},
					modelName,
					cancellationToken: undefined,
					fileDependencies: this.convertDependencyMapToStringMap(
						this.fileDependencies
					), // Pass file dependencies for AI filtering
					preSelectedHeuristicFiles: heuristicFiles,
					fileSummaries,
					selectionOptions: {
						useCache: true,
						cacheTimeout: 5 * 60 * 1000,
						maxPromptLength: 30000,
						enableStreaming: false,
						fallbackToHeuristics: true,
					},
				};

				const aiSelectedFiles = await selectRelevantFilesAI(aiSelectionOptions);

				if (aiSelectedFiles.length > 0) {
					this.postMessageToWebview({
						type: "statusUpdate",
						value: `AI selected ${aiSelectedFiles.length} most relevant files.`,
					});
					return aiSelectedFiles;
				}
			} catch (error) {
				console.warn(
					"AI file selection failed, falling back to heuristic selection:",
					error
				);
			}
		}

		// Fallback to heuristic selection
		this.postMessageToWebview({
			type: "statusUpdate",
			value: `Using heuristic selection: ${heuristicFiles.length} relevant files found.`,
		});
		return heuristicFiles;
	}

	/**
	 * Convert structured DependencyRelation map to a simple string array map.
	 * This is necessary for components (like SequentialFileProcessor) expecting legacy format.
	 */
	private convertDependencyMapToStringMap(
		dependencyMap: Map<string, DependencyRelation[]>
	): Map<string, string[]> {
		const stringMap = new Map<string, string[]>();
		for (const [key, relations] of dependencyMap.entries()) {
			stringMap.set(
				key,
				relations.map((rel) => rel.path)
			);
		}
		return stringMap;
	}

	/**
	 * Build final comprehensive context from all file summaries
	 */
	private buildFinalContext(
		summaries: FileSummary[],
		userRequest: string
	): string {
		if (summaries.length === 0) {
			return "No files were processed.";
		}

		let context = `Sequential File Analysis Complete\n`;
		context += `Total files analyzed: ${summaries.length}\n`;
		context += `User request: ${userRequest}\n\n`;

		// Group files by purpose
		const byPurpose = new Map<string, FileSummary[]>();
		summaries.forEach((file) => {
			const purpose = file.mainPurpose;
			if (!byPurpose.has(purpose)) {
				byPurpose.set(purpose, []);
			}
			byPurpose.get(purpose)!.push(file);
		});

		// Add purpose-based summaries
		context += `Project Structure by Purpose:\n`;
		for (const [purpose, files] of byPurpose) {
			context += `\n=== ${purpose} (${files.length} files) ===\n`;

			// Group by complexity within each purpose
			const byComplexity = {
				high: files.filter((f) => f.estimatedComplexity === "high"),
				medium: files.filter((f) => f.estimatedComplexity === "medium"),
				low: files.filter((f) => f.estimatedComplexity === "low"),
			};

			if (byComplexity.high.length > 0) {
				context += `High Complexity Files:\n`;
				for (const file of byComplexity.high.slice(0, 3)) {
					// Limit to 3 files
					context += `- ${file.relativePath}: ${file.keyInsights.join(", ")}\n`;
				}
				if (byComplexity.high.length > 3) {
					context += `... and ${
						byComplexity.high.length - 3
					} more high complexity files\n`;
				}
			}

			if (byComplexity.medium.length > 0) {
				context += `Medium Complexity Files:\n`;
				for (const file of byComplexity.medium.slice(0, 3)) {
					context += `- ${file.relativePath}: ${file.keyInsights.join(", ")}\n`;
				}
				if (byComplexity.medium.length > 3) {
					context += `... and ${
						byComplexity.medium.length - 3
					} more medium complexity files\n`;
				}
			}

			if (byComplexity.low.length > 0) {
				context += `Low Complexity Files:\n`;
				for (const file of byComplexity.low.slice(0, 3)) {
					context += `- ${file.relativePath}: ${file.keyInsights.join(", ")}\n`;
				}
				if (byComplexity.low.length > 3) {
					context += `... and ${
						byComplexity.low.length - 3
					} more low complexity files\n`;
				}
			}
		}

		// Add dependency analysis
		const allDependencies = new Set<string>();
		summaries.forEach((file) => {
			if (file.dependencies) {
				file.dependencies.forEach((dep) => allDependencies.add(dep));
			}
		});

		if (allDependencies.size > 0) {
			context += `\n=== Dependencies Analysis ===\n`;
			context += `Total unique dependencies: ${allDependencies.size}\n`;
			context += `Key dependencies: ${Array.from(allDependencies)
				.slice(0, 10)
				.join(", ")}\n`;
		}

		// Add detailed summaries for high-complexity files
		const highComplexityFiles = summaries.filter(
			(f) => f.estimatedComplexity === "high"
		);
		if (highComplexityFiles.length > 0) {
			context += `\n=== High Complexity File Details ===\n`;
			for (const file of highComplexityFiles.slice(0, 5)) {
				// Limit to 5 files
				context += `\n--- ${file.relativePath} ---\n`;
				context += `Purpose: ${file.mainPurpose}\n`;
				context += `Key Insights: ${file.keyInsights.join(", ")}\n`;
				context += `Dependencies: ${file.dependencies?.join(", ") || "None"}\n`;
				context += `Summary: ${file.summary.substring(0, 500)}${
					file.summary.length > 500 ? "..." : ""
				}\n`;
			}
		}

		return context;
	}

	/**
	 * Fallback to traditional context building
	 */
	private async buildTraditionalContext(
		userRequest: string
	): Promise<SequentialContextResult> {
		this.postMessageToWebview({
			type: "statusUpdate",
			value: "Using traditional context building...",
		});

		// Scan workspace
		const allFiles = await scanWorkspace({
			useCache: true,
			maxConcurrency: 10,
			maxFileSize: DEFAULT_SIZE,
		});

		// Build dependency graph
		const dependencyGraph = await buildDependencyGraph(
			allFiles,
			this.workspaceRoot,
			{
				useCache: true,
				maxConcurrency: 10,
			}
		);

		// Build basic context string
		let contextString = `Traditional Context Analysis:\n`;
		contextString += `Total files: ${allFiles.length}\n`;
		contextString += `User request: ${userRequest}\n\n`;

		// Add file structure
		contextString += `File Structure:\n`;
		for (const file of allFiles.slice(0, 20)) {
			// Limit to 20 files
			const relativePath = vscode.workspace.asRelativePath(file);
			contextString += `- ${relativePath}\n`;
		}
		if (allFiles.length > 20) {
			contextString += `... and ${allFiles.length - 20} more files\n`;
		}

		return {
			contextString,
			relevantFiles: allFiles,
			fileSummaries: [],
			processingMetrics: {
				totalFiles: allFiles.length,
				processedFiles: 0,
				totalTime: 0,
				averageTimePerFile: 0,
			},
			sequentialProcessingEnabled: false,
		};
	}

	/**
	 * Get processing statistics
	 */
	public getProcessingStats(summaries: FileSummary[]): {
		totalFiles: number;
		byComplexity: { high: number; medium: number; low: number };
		byPurpose: Map<string, number>;
		averageInsightsPerFile: number;
	} {
		const byComplexity = {
			high: summaries.filter((f) => f.estimatedComplexity === "high").length,
			medium: summaries.filter((f) => f.estimatedComplexity === "medium")
				.length,
			low: summaries.filter((f) => f.estimatedComplexity === "low").length,
		};

		const byPurpose = new Map<string, number>();
		summaries.forEach((file) => {
			const purpose = file.mainPurpose;
			byPurpose.set(purpose, (byPurpose.get(purpose) || 0) + 1);
		});

		const totalInsights = summaries.reduce(
			(sum, file) => sum + file.keyInsights.length,
			0
		);
		const averageInsightsPerFile =
			summaries.length > 0 ? totalInsights / summaries.length : 0;

		return {
			totalFiles: summaries.length,
			byComplexity,
			byPurpose,
			averageInsightsPerFile,
		};
	}
}
