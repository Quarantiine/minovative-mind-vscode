import * as vscode from "vscode";
import * as path from "path";
import BPromise from "bluebird";
import { GenerationConfig } from "@google/generative-ai";
import { SettingsManager } from "../sidebar/managers/settingsManager";
import { ChatHistoryManager } from "../sidebar/managers/chatHistoryManager";
import { ProjectChangeLogger } from "../workflow/ProjectChangeLogger";
import { AIRequestService } from "./aiRequestService";
import {
	PlanGenerationContext,
	HistoryEntryPart,
	HistoryEntry,
} from "../sidebar/common/sidebarTypes";
import { scanWorkspace, clearScanCache } from "../context/workspaceScanner";
import {
	buildDependencyGraph,
	buildReverseDependencyGraph,
} from "../context/dependencyGraphBuilder";
import {
	selectRelevantFilesAI,
	SelectRelevantFilesAIOptions,
	MAX_FILE_SUMMARY_LENGTH_FOR_AI_SELECTION, // Import for summary length
	clearAISelectionCache, // Import clearAISelectionCache for cache invalidation
} from "../context/smartContextSelector";
import {
	buildContextString,
	DEFAULT_CONTEXT_CONFIG,
} from "../context/contextBuilder";
import * as SymbolService from "./symbolService";
import {
	DiagnosticService,
	FormatDiagnosticsOptions,
} from "../utils/diagnosticUtils";
import { intelligentlySummarizeFileContent } from "../context/fileContentProcessor"; // Import for file content summarization
import { SequentialContextService } from "./sequentialContextService"; // Import sequential context service
import {
	detectProjectType,
	formatProjectProfileForPrompt,
} from "./projectTypeDetector"; // Import project type detection and formatting
import {
	DEFAULT_FLASH_LITE_MODEL,
	DEFAULT_SIZE,
} from "../sidebar/common/sidebarConstants";

// Constants for symbol processing
export const MAX_REFERENCED_TYPE_CONTENT_CHARS_CONSTANT = 20000;

// Performance monitoring constants
const PERFORMANCE_THRESHOLDS = {
	SCAN_TIME_WARNING: 15000, // 15 seconds
	DEPENDENCY_BUILD_TIME_WARNING: 10000, // 10 seconds
	CONTEXT_BUILD_TIME_WARNING: 15000, // 15 seconds
	MAX_FILES_FOR_DETAILED_PROCESSING: 2000,
	MAX_FILES_FOR_SYMBOL_PROCESSING: 500,
};

// Configuration interface for context building
interface ContextBuildOptions {
	useScanCache?: boolean;
	useDependencyCache?: boolean;
	useAISelectionCache?: boolean;
	maxConcurrency?: number;
	enablePerformanceMonitoring?: boolean;
	skipLargeFiles?: boolean;
	maxFileSize?: number;
	forceAISelectionRecalculation?: boolean;
	operationId?: string; // Add operationId to ContextBuildOptions
}

export interface ActiveSymbolDetailedInfo {
	name?: string;
	kind?: string;
	detail?: string;
	fullRange?: vscode.Range;
	filePath?: string;
	childrenHierarchy?: string;
	definition?: vscode.Location | vscode.Location[];
	implementations?: vscode.Location[];
	typeDefinition?: vscode.Location | vscode.Location[];
	referencedTypeDefinitions?: Map<string, string[]>;
	incomingCalls?: vscode.CallHierarchyIncomingCall[];
	outgoingCalls?: vscode.CallHierarchyOutgoingCall[];
}

export interface BuildProjectContextResult {
	contextString: string;
	relevantFiles: string[];
	performanceMetrics?: {
		scanTime: number;
		dependencyBuildTime: number;
		contextBuildTime: number;
		totalTime: number;
		fileCount: number;
		processedFileCount: number;
	};
	activeSymbolDetailedInfo?: ActiveSymbolDetailedInfo;
}

export class ContextService {
	private settingsManager: SettingsManager;
	private chatHistoryManager: ChatHistoryManager;
	private changeLogger: ProjectChangeLogger;
	private aiRequestService: AIRequestService;
	private postMessageToWebview: (message: any) => void;
	private sequentialContextService?: SequentialContextService;
	private disposables: vscode.Disposable[] = [];
	private fileDependencies?: Map<string, string[]>;
	private reverseFileDependencies?: Map<string, string[]>;
	private areDependenciesComputed: boolean = false;
	private lastProcessedOperationId: string | undefined; // Track the last operation ID

	constructor(
		settingsManager: SettingsManager,
		chatHistoryManager: ChatHistoryManager,
		changeLogger: ProjectChangeLogger,
		aiRequestService: AIRequestService,
		postMessageToWebview: (message: any) => void
	) {
		this.settingsManager = settingsManager;
		this.chatHistoryManager = chatHistoryManager;
		this.changeLogger = changeLogger;
		this.aiRequestService = aiRequestService;
		this.postMessageToWebview = postMessageToWebview;
		this._registerWorkspaceWatchers();
	}

	/**
	 * Initialize sequential context service if not already initialized
	 */
	private async initializeSequentialContextService(): Promise<SequentialContextService> {
		if (!this.sequentialContextService) {
			await this._computeWorkspaceDependencies();
			const workspaceFolders = vscode.workspace.workspaceFolders;
			if (!workspaceFolders || workspaceFolders.length === 0) {
				throw new Error("No workspace folder open");
			}
			const workspaceRoot = workspaceFolders[0].uri;
			this.sequentialContextService = new SequentialContextService(
				this.aiRequestService,
				workspaceRoot,
				this.postMessageToWebview,
				this.settingsManager,
				this.fileDependencies ?? new Map<string, string[]>(),
				this.reverseFileDependencies ?? new Map<string, string[]>()
			);
		}
		return this.sequentialContextService;
	}

	private async _registerWorkspaceWatchers(): Promise<void> {
		const registerDisposable = (disposable: vscode.Disposable) => {
			this.disposables.push(disposable);
		};

		const clearCacheForFileUri = (uri: vscode.Uri) => {
			const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
			if (workspaceFolder) {
				const workspacePath = workspaceFolder.uri.fsPath;
				console.log(
					`[ContextService] Clearing scan cache for workspace: ${workspacePath} due to file change.`
				);
				clearScanCache(workspacePath); // Ensure clearScanCache is imported
				this.areDependenciesComputed = false; // Invalidate computed dependencies
				// --- New addition: Clear AI selection cache ---
				console.log(
					`[ContextService] Clearing AI selection cache for workspace: ${workspacePath} due to file change.`
				);
				// Ensure clearAISelectionCache is available in this scope via import
				clearAISelectionCache(workspacePath);
				// --- End of new addition ---
			} else {
				console.warn(
					`[ContextService] File change detected outside of any known workspace folder for URI: ${uri.toString()}`
				);
			}
		};

		// Subscribe to file creation events
		registerDisposable(
			vscode.workspace.onDidCreateFiles((event) => {
				console.debug(`[ContextService] onDidCreateFiles event detected.`);
				event.files.forEach((fileUri: vscode.Uri) =>
					clearCacheForFileUri(fileUri)
				);
			})
		);

		// Subscribe to file deletion events
		registerDisposable(
			vscode.workspace.onDidDeleteFiles((event) => {
				console.debug(`[ContextService] onDidDeleteFiles event detected.`);
				event.files.forEach((fileUri: vscode.Uri) =>
					clearCacheForFileUri(fileUri)
				);
			})
		);

		// Subscribe to file rename events
		registerDisposable(
			vscode.workspace.onDidRenameFiles((event) => {
				console.debug(`[ContextService] onDidRenameFiles event detected.`);
				event.files.forEach((fileRename) => {
					clearCacheForFileUri(fileRename.newUri);
				});
			})
		);

		console.log("[ContextService] Workspace file system watchers registered.");
	}

	private async _computeWorkspaceDependencies(): Promise<void> {
		if (this.areDependenciesComputed) {
			return;
		}

		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders || workspaceFolders.length === 0) {
			console.warn(
				"[ContextService] Cannot compute workspace dependencies: No workspace folder open."
			);
			return;
		}
		const workspaceRoot = workspaceFolders[0].uri;

		try {
			console.log("[ContextService] Computing workspace dependencies...");
			// scanWorkspace and buildDependencyGraph are already imported
			const allScannedFiles = await scanWorkspace({
				/* default options */
			});

			if (allScannedFiles.length === 0) {
				console.warn(
					"[ContextService] No files found to compute dependencies."
				);
				this.areDependenciesComputed = true;
				return;
			}

			const fileDependencies = await buildDependencyGraph(
				allScannedFiles,
				workspaceRoot,
				{
					/* default options */
				}
			);
			this.fileDependencies = fileDependencies;

			this.reverseFileDependencies = buildReverseDependencyGraph(
				fileDependencies,
				workspaceRoot
			);

			console.log(
				`[ContextService] Workspace dependencies computed (${fileDependencies.size} files processed).`
			);
			this.areDependenciesComputed = true;
		} catch (error: any) {
			console.error(
				`[ContextService] Error computing workspace dependencies: ${error.message}`
			);
		}
	}

	private _deduplicateUris(uris: vscode.Uri[]): vscode.Uri[] {
		const uniquePaths = new Set<string>();
		const uniqueUris: vscode.Uri[] = [];
		for (const uri of uris) {
			if (!uniquePaths.has(uri.fsPath)) {
				uniquePaths.add(uri.fsPath);
				uniqueUris.push(uri);
			}
		}
		return uniqueUris;
	}

	private async _extractAndValidateUserProvidedFilePaths(
		userRequest: string,
		workspaceRootUri: vscode.Uri,
		allScannedFiles: vscode.Uri[],
		cancellationToken: vscode.CancellationToken | undefined
	): Promise<vscode.Uri[]> {
		const foundUris: vscode.Uri[] = [];
		// This regex aims to capture strings that look like file paths.
		// It's a balance: broad enough to catch common formats but relies heavily on subsequent validation.
		// It tries to catch:
		// 1. Paths with slashes and an optional extension (e.g., 'folder/file', 'folder/file.ts')
		// 2. Simple filenames with an extension (e.g., 'package.json', 'README.md')

		// The optional `(?:[/\][a-zA-Z0-9_.-]+)*` handles multiple directory levels.
		const filePathRegex =
			/(?:(?:[a-zA-Z]:|~|\.{1,2})?[\/\\])?(?:[a-zA-Z0-9_.-]+(?:[\/\\][a-zA-Z0-9_.-]+)*)?(?:[a-zA-Z0-9_.-]+(?:\.[a-zA-Z0-9]{1,6})?)?/g;

		const matches = userRequest.match(filePathRegex);

		if (!matches) {
			return [];
		}

		const workspaceRootPath = workspaceRootUri.fsPath;
		// Convert scanned files to a Set for efficient O(1) lookups
		const allScannedFilePaths = new Set(
			allScannedFiles.map((uri) => uri.fsPath)
		);

		await BPromise.map(
			matches,
			async (match: string) => {
				if (cancellationToken?.isCancellationRequested) {
					return;
				}

				// Clean the matched path: remove leading/trailing quotes, backticks,
				// or other markdown formatting that might be part of the match.
				// Also remove trailing dots which might be from punctuation.
				let cleanedMatch = match.replace(/^[`"'\\]+|[`"']+$|\.$/, "").trim();

				if (!cleanedMatch) {
					return; // Skip empty strings after cleaning
				}

				let potentialUri: vscode.Uri | undefined;
				try {
					// Try resolving as a relative path from workspace root
					let resolvedUri = vscode.Uri.joinPath(workspaceRootUri, cleanedMatch);

					// Check if the resolved path actually starts with the workspace root path.
					// This prevents cases where joinPath resolves to an external path if cleanedMatch is absolute.
					if (resolvedUri.fsPath.startsWith(workspaceRootPath)) {
						potentialUri = resolvedUri;
					} else {
						// If it's an absolute path mentioned directly (less common but possible, e.g., /Users/user/project/file.ts)
						// Or if the initial joinPath resulted in a path outside the workspace (e.g., if cleanedMatch was '../file.ts')
						try {
							const absUri = vscode.Uri.file(cleanedMatch);
							if (absUri.fsPath.startsWith(workspaceRootPath)) {
								potentialUri = absUri;
							}
						} catch (e) {
							// Not a valid absolute path URI string
						}
					}

					if (potentialUri) {
						// Prioritize checking against the already scanned files for speed
						if (allScannedFilePaths.has(potentialUri.fsPath)) {
							foundUris.push(potentialUri);
						} else {
							// If not in scanned list, perform a direct file system stat check as a fallback.
							// This catches files not in the initial scan (e.g., very recent changes, or filtered by scan options).
							try {
								const stat = await vscode.workspace.fs.stat(potentialUri);
								if (stat.type === vscode.FileType.File) {
									// Ensure it's a file, not a directory
									foundUris.push(potentialUri);
								}
							} catch (statError: any) {
								// File does not exist or cannot be accessed, or it's a directory
								// console.debug(`[ContextService] User-provided path "${cleanedMatch}" does not exist or is not a file: ${statError.message}`);
							}
						}
					}
				} catch (e: any) {
					console.debug(
						`[ContextService] Failed to process user-provided path "${cleanedMatch}": ${e.message}`
					);
				}
			},
			{ concurrency: 10 } // Limit concurrent file system checks to avoid overwhelming FS
		);

		return foundUris; // Deduplication will happen in the main method
	}

	public async buildProjectContext(
		cancellationToken: vscode.CancellationToken | undefined,
		userRequest?: string,
		editorContext?: PlanGenerationContext["editorContext"],
		initialDiagnosticsString?: string,
		options?: ContextBuildOptions,
		includePersona: boolean = true,
		includeVerboseHeaders: boolean = true
	): Promise<BuildProjectContextResult> {
		const startTime = Date.now();
		const enablePerformanceMonitoring =
			options?.enablePerformanceMonitoring ?? true;

		try {
			// Get workspace root with better error handling
			const workspaceFolders = vscode.workspace.workspaceFolders;
			if (!workspaceFolders || workspaceFolders.length === 0) {
				return {
					contextString: "[No workspace folder open]",
					relevantFiles: [],
				};
			}
			const rootFolder = workspaceFolders[0];

			// Optimized workspace scanning with performance monitoring
			const scanStartTime = Date.now();
			this.postMessageToWebview({
				type: "statusUpdate",
				value: "Scanning workspace for relevant files",
				showLoadingDots: true, // ADDED
			});

			const allScannedFiles = await scanWorkspace({
				useCache: options?.useScanCache ?? true,
				maxConcurrentReads: options?.maxConcurrency ?? 15,
				maxFileSize: options?.maxFileSize ?? DEFAULT_SIZE,
				cacheTimeout: 5 * 60 * 1000, // 5 minutes
			});

			// Detect project type after scanning
			const detectedProjectProfile = await detectProjectType(
				rootFolder.uri,
				allScannedFiles,
				{ useCache: options?.useScanCache ?? true }
			);

			const scanTime = Date.now() - scanStartTime;
			if (
				enablePerformanceMonitoring &&
				scanTime > PERFORMANCE_THRESHOLDS.SCAN_TIME_WARNING
			) {
				console.warn(
					`[ContextService] Workspace scan took ${scanTime}ms (threshold: ${PERFORMANCE_THRESHOLDS.SCAN_TIME_WARNING}ms)`
				);
			}

			this.postMessageToWebview({
				type: "statusUpdate",
				value: `Found ${allScannedFiles.length} relevant files in ${scanTime}ms.`,
			});

			if (allScannedFiles.length === 0) {
				return {
					contextString: "[No relevant files found in workspace]",
					relevantFiles: [],
					performanceMetrics: {
						scanTime,
						dependencyBuildTime: 0,
						contextBuildTime: 0,
						totalTime: Date.now() - startTime,
						fileCount: 0,
						processedFileCount: 0,
					},
				};
			}

			// Optimized dependency graph building
			const dependencyStartTime = Date.now();
			this.postMessageToWebview({
				type: "statusUpdate",
				value: "Analyzing file dependencies",
				showLoadingDots: true, // ADDED
			});

			const fileDependencies = await buildDependencyGraph(
				allScannedFiles,
				rootFolder.uri,
				{
					useCache: options?.useDependencyCache ?? true,
					maxConcurrency: options?.maxConcurrency ?? 15,
					skipLargeFiles: options?.skipLargeFiles ?? true,
					maxFileSizeForParsing: options?.maxFileSize ?? DEFAULT_SIZE,
					retryFailedFiles: true,
					maxRetries: 3,
				}
			);

			const dependencyBuildTime = Date.now() - dependencyStartTime;
			if (
				enablePerformanceMonitoring &&
				dependencyBuildTime >
					PERFORMANCE_THRESHOLDS.DEPENDENCY_BUILD_TIME_WARNING
			) {
				console.warn(
					`[ContextService] Dependency graph build took ${dependencyBuildTime}ms (threshold: ${PERFORMANCE_THRESHOLDS.DEPENDENCY_BUILD_TIME_WARNING}ms)`
				);
			}

			const reverseFileDependencies = buildReverseDependencyGraph(
				fileDependencies,
				rootFolder.uri
			);

			this.postMessageToWebview({
				type: "statusUpdate",
				value: `Analyzed ${fileDependencies.size} file dependencies in ${dependencyBuildTime}ms.`,
			});

			// Optimized symbol processing with limits
			const documentSymbolsMap = new Map<string, vscode.DocumentSymbol[]>();
			const maxFilesForSymbolProcessing = Math.min(
				allScannedFiles.length,
				PERFORMANCE_THRESHOLDS.MAX_FILES_FOR_SYMBOL_PROCESSING
			);

			// Process symbols only for files that are likely to be relevant
			const filesForSymbolProcessing = allScannedFiles.slice(
				0,
				maxFilesForSymbolProcessing
			);

			await BPromise.map(
				filesForSymbolProcessing,
				async (fileUri: vscode.Uri) => {
					if (cancellationToken?.isCancellationRequested) {
						return;
					}
					try {
						const symbols = await SymbolService.getSymbolsInDocument(
							fileUri,
							cancellationToken
						);
						const relativePath = path
							.relative(rootFolder.uri.fsPath, fileUri.fsPath)
							.replace(/\\/g, "/");
						documentSymbolsMap.set(relativePath, symbols || []);
					} catch (symbolError: any) {
						console.warn(
							`[ContextService] Failed to get symbols for ${fileUri.fsPath}: ${symbolError.message}`
						);
					}
				},
				{ concurrency: options?.maxConcurrency ?? 5 }
			);

			// --- Determine effective diagnostics string ---
			let effectiveDiagnosticsString: string | undefined =
				initialDiagnosticsString;

			if (editorContext?.documentUri) {
				// If there's an active editor, always fetch and filter live diagnostics
				const fileContentBytes = await vscode.workspace.fs.readFile(
					editorContext.documentUri
				);
				const fileContent = Buffer.from(fileContentBytes).toString("utf8");

				// Construct the FormatDiagnosticsOptions object.
				// The 'token' property is optional in FormatDiagnosticsOptions, so directly using 'cancellationToken' is correct.
				const formatOptions: FormatDiagnosticsOptions = {
					fileContent: fileContent,
					enableEnhancedDiagnosticContext:
						this.settingsManager.getOptimizationSettings()
							.enableEnhancedDiagnosticContext,
					includeSeverities: [
						vscode.DiagnosticSeverity.Error,
						vscode.DiagnosticSeverity.Warning,
						vscode.DiagnosticSeverity.Information,
						vscode.DiagnosticSeverity.Hint,
					],
					requestType: "full",
					token: cancellationToken, // Directly use cancellationToken as it's optional
					selection: editorContext.selection,
					maxTotalChars: undefined,
					maxPerSeverity: undefined,
					snippetContextLines: undefined,
				};

				// Update the call to use the constructed formatOptions object.
				const diagnosticsForActiveFile =
					await DiagnosticService.formatContextualDiagnostics(
						editorContext.documentUri,
						rootFolder.uri,
						formatOptions
					);
				if (diagnosticsForActiveFile) {
					effectiveDiagnosticsString = diagnosticsForActiveFile;
					this.postMessageToWebview({
						type: "statusUpdate",
						value: "Minovative Mind applied diagnostic filtering.",
					});
				} else if (initialDiagnosticsString) {
					// If no relevant live diagnostics but an initial string was provided, use it
					effectiveDiagnosticsString = initialDiagnosticsString;
				} else {
					effectiveDiagnosticsString = undefined;
				}
			}
			// --- End Determine effective diagnostics string ---

			// 2b. Add new conditional block for activeSymbolDetailedInfo
			// This block is added after fileDependencies is built.
			let activeSymbolDetailedInfo: ActiveSymbolDetailedInfo | undefined;
			if (editorContext?.documentUri && editorContext?.selection) {
				const activeFileUri = editorContext.documentUri;
				try {
					// 2b.iii. Call SymbolService.getSymbolsInDocument
					const activeDocumentSymbols =
						await SymbolService.getSymbolsInDocument(
							activeFileUri,
							cancellationToken
						);

					if (activeDocumentSymbols && activeDocumentSymbols.length > 0) {
						// 2b.iv. Iterate through DocumentSymbols to find symbolAtCursor
						const symbolAtCursor = activeDocumentSymbols.find((s) =>
							s.range.contains(editorContext.selection!.start)
						);

						if (symbolAtCursor) {
							// 2b.v. Initialize activeSymbolDetailedInfo
							activeSymbolDetailedInfo = {
								name: symbolAtCursor.name,
								kind: vscode.SymbolKind[symbolAtCursor.kind],
								detail: symbolAtCursor.detail,
								fullRange: symbolAtCursor.range,
								filePath: activeFileUri.fsPath,
								referencedTypeDefinitions: new Map<string, string[]>(),
							};

							// 2b.vi. Asynchronously call SymbolService functions, wrapping each in a try-catch
							await Promise.allSettled([
								(async () => {
									try {
										activeSymbolDetailedInfo!.definition =
											await SymbolService.getDefinition(
												activeFileUri,
												symbolAtCursor.selectionRange.start,
												cancellationToken
											);
									} catch (e: any) {
										console.warn(
											`[ContextService] Failed to get definition for ${symbolAtCursor.name}: ${e.message}`
										);
									}
								})(),
								(async () => {
									try {
										activeSymbolDetailedInfo!.implementations =
											await SymbolService.getImplementations(
												activeFileUri,
												symbolAtCursor.selectionRange.start,
												cancellationToken
											);
									} catch (e: any) {
										console.warn(
											`[ContextService] Failed to get implementations for ${symbolAtCursor.name}: ${e.message}`
										);
									}
								})(),
								(async () => {
									try {
										activeSymbolDetailedInfo!.typeDefinition =
											await SymbolService.getTypeDefinition(
												activeFileUri,
												symbolAtCursor.selectionRange.start,
												cancellationToken
											);
									} catch (e: any) {
										console.warn(
											`[ContextService] Failed to get type definition for ${symbolAtCursor.name}: ${e.message}`
										);
									}
								})(),
								(async () => {
									try {
										// Get referenced type definitions
										const referencedTypeContents = new Map<string, string[]>();
										const referencedTypeDefinitions =
											await SymbolService.getTypeDefinition(
												activeFileUri,
												symbolAtCursor.selectionRange.start,
												cancellationToken
											);

										if (referencedTypeDefinitions) {
											const typeDefs = Array.isArray(referencedTypeDefinitions)
												? referencedTypeDefinitions
												: [referencedTypeDefinitions];

											await BPromise.map(
												typeDefs,
												async (typeDef) => {
													try {
														const content =
															await SymbolService.getDocumentContentAtLocation(
																typeDef,
																cancellationToken
															);
														if (content) {
															const relativePath = path
																.relative(
																	rootFolder.uri.fsPath,
																	typeDef.uri.fsPath
																)
																.replace(/\\/g, "/");
															referencedTypeContents.set(relativePath, [
																content.substring(
																	0,
																	MAX_REFERENCED_TYPE_CONTENT_CHARS_CONSTANT
																),
															]);
														}
													} catch (e: any) {
														console.warn(
															`[ContextService] Failed to get content for referenced type definition: ${e.message}`
														);
													}
												},
												{ concurrency: 5 } // Limit concurrent file reads
											);
											activeSymbolDetailedInfo!.referencedTypeDefinitions =
												referencedTypeContents;
										}
									} catch (e: any) {
										console.warn(
											`[ContextService] Failed to get referenced type definitions for ${symbolAtCursor.name}: ${e.message}`
										);
									}
								})(),
								(async () => {
									try {
										const callHierarchyItems =
											await SymbolService.prepareCallHierarchy(
												activeFileUri,
												symbolAtCursor.selectionRange.start,
												cancellationToken
											);
										if (callHierarchyItems && callHierarchyItems.length > 0) {
											// Select a primary item (e.g., matching name or the first)
											const primaryCallHierarchyItem =
												callHierarchyItems.find(
													(item) => item.name === symbolAtCursor.name
												) || callHierarchyItems[0];

											if (primaryCallHierarchyItem) {
												activeSymbolDetailedInfo!.incomingCalls =
													await SymbolService.resolveIncomingCalls(
														primaryCallHierarchyItem,
														cancellationToken
													);
												activeSymbolDetailedInfo!.outgoingCalls =
													await SymbolService.resolveOutgoingCalls(
														primaryCallHierarchyItem,
														cancellationToken
													);
											}
										}
									} catch (e: any) {
										console.warn(
											`[ContextService] Failed to get call hierarchy for ${symbolAtCursor.name}: ${e.message}`
										);
									}
								})(),
							]);
						}
					}
				} catch (e: any) {
					console.error(
						`[ContextService] Error getting detailed symbol info: ${e.message}`
					);
				}
			}

			let filesForContextBuilding = allScannedFiles;
			let heuristicSelectedFiles: vscode.Uri[] = []; // Declare heuristicSelectedFiles

			// Populate heuristicSelectedFiles by awaiting a call to getHeuristicRelevantFiles
			try {
				if (heuristicSelectedFiles.length > 0) {
					this.postMessageToWebview({
						type: "statusUpdate",
						value: `Identified ${heuristicSelectedFiles.length} heuristically relevant file(s).`,
					});
				}
			} catch (heuristicError: any) {
				console.error(
					`[ContextService] Error during heuristic file selection: ${heuristicError.message}`
				);
				this.postMessageToWebview({
					type: "statusUpdate",
					value: `Warning: Heuristic file selection failed. Reason: ${heuristicError.message}`,
					isError: true,
				});
				// Continue without heuristic files if an error occurs
				heuristicSelectedFiles = [];
			}

			// Summary generation logic with optimization
			const MAX_FILES_TO_SUMMARIZE_ALL_FOR_SELECTION_PROMPT = 100; // User-defined threshold

			let filesToSummarizeForSelectionPrompt: vscode.Uri[];
			if (
				allScannedFiles.length <=
				MAX_FILES_TO_SUMMARIZE_ALL_FOR_SELECTION_PROMPT
			) {
				this.postMessageToWebview({
					type: "statusUpdate",
					value: `Summarizing all ${allScannedFiles.length} files for AI selection prompt...`,
				});
				filesToSummarizeForSelectionPrompt = Array.from(allScannedFiles);
			} else {
				this.postMessageToWebview({
					type: "statusUpdate",
					value: `Summarizing ${heuristicSelectedFiles.length} heuristically relevant files for AI selection prompt...`,
				});
				filesToSummarizeForSelectionPrompt = Array.from(heuristicSelectedFiles);
			}

			const fileSummariesForAI = new Map<string, string>();
			const summaryGenerationPromises = filesToSummarizeForSelectionPrompt.map(
				async (fileUri: vscode.Uri) => {
					if (cancellationToken?.isCancellationRequested) {
						return;
					}
					const relativePath = path
						.relative(rootFolder.uri.fsPath, fileUri.fsPath)
						.replace(/\\/g, "/");
					try {
						const contentBytes = await vscode.workspace.fs.readFile(fileUri);
						const fileContentRaw = Buffer.from(contentBytes).toString("utf-8");
						const symbolsForFile = documentSymbolsMap.get(relativePath);

						const summary = intelligentlySummarizeFileContent(
							fileContentRaw,
							symbolsForFile,
							undefined,
							MAX_FILE_SUMMARY_LENGTH_FOR_AI_SELECTION
						);
						fileSummariesForAI.set(relativePath, summary);
					} catch (error: any) {
						console.warn(
							`[ContextService] Could not generate summary for ${relativePath}: ${error.message}`
						);
					}
				}
			);
			await BPromise.allSettled(summaryGenerationPromises);

			const currentQueryForSelection =
				userRequest || editorContext?.instruction;
			const smartContextEnabled = this.settingsManager.getSetting<boolean>(
				"smartContext.enabled",
				true
			);

			// Get the current operation ID from options
			const currentOperationId = options?.operationId;

			// Determine if AI selection cache should be used for this specific call
			let shouldUseAISelectionCache = options?.useAISelectionCache ?? true;

			// If a new distinct operation ID is provided, or forceAISelectionRecalculation is true,
			// force the AI selection to re-evaluate by disabling cache.
			if (
				currentOperationId &&
				currentOperationId !== this.lastProcessedOperationId
			) {
				console.log(
					`[ContextService] Detected new operation ID (${currentOperationId} vs ${this.lastProcessedOperationId}). Forcing AI selection recalculation.`
				);
				shouldUseAISelectionCache = false;
				// Explicitly clear the workspace-wide AI selection cache.
				clearAISelectionCache(rootFolder.uri.fsPath);
			} else if (options?.forceAISelectionRecalculation === true) {
				console.log(
					`[ContextService] Forcing AI selection recalculation: clearing cache for workspace: ${rootFolder.uri.fsPath}`
				);
				shouldUseAISelectionCache = false;
				clearAISelectionCache(rootFolder.uri.fsPath);
			}

			// Update the last processed operation ID
			if (currentOperationId) {
				this.lastProcessedOperationId = currentOperationId;
			}

			if (
				currentQueryForSelection &&
				smartContextEnabled &&
				!currentQueryForSelection.startsWith("/commit")
			) {
				this.postMessageToWebview({
					type: "statusUpdate",
					value: "Identifying relevant files",
					showLoadingDots: true,
				});

				try {
					const selectionOptions: SelectRelevantFilesAIOptions = {
						userRequest: currentQueryForSelection,
						chatHistory: this.chatHistoryManager.getChatHistory(),
						allScannedFiles,
						projectRoot: rootFolder.uri,
						activeEditorContext: editorContext,
						diagnostics: effectiveDiagnosticsString,
						activeEditorSymbols: editorContext?.documentUri
							? documentSymbolsMap.get(
									path
										.relative(
											rootFolder.uri.fsPath,
											editorContext.documentUri.fsPath
										)
										.replace(/\\/g, "/")
							  )
							: undefined,
						// Modified to adapt prompt from string to HistoryEntryPart[]
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
							const messages: HistoryEntryPart[] = [{ text: prompt }];
							return this.aiRequestService.generateWithRetry(
								messages,
								modelName,
								history,
								requestType,
								generationConfig,
								streamCallbacks,
								token
							);
						},
						modelName: DEFAULT_FLASH_LITE_MODEL, // Use the default model for selection
						cancellationToken,
						fileDependencies,
						preSelectedHeuristicFiles: [], // Pass heuristicSelectedFiles
						fileSummaries: fileSummariesForAI, // Pass the generated file summaries
						selectionOptions: {
							useCache: shouldUseAISelectionCache, // Use the dynamically determined cache option
							cacheTimeout: 5 * 60 * 1000, // 5 minutes
							maxPromptLength: 50000,
							enableStreaming: false,
							fallbackToHeuristics: true,
						},
					};
					const selectedFiles = await selectRelevantFilesAI(selectionOptions);

					if (selectedFiles.length > 0) {
						filesForContextBuilding = selectedFiles;
						this.postMessageToWebview({
							type: "statusUpdate",
							value: `Found relevant file(s) for context`, // Updated message
						});
					} else {
						// AI returned no relevant files or an empty selection.
						let fallbackFiles: vscode.Uri[] = [];
						if (editorContext?.documentUri) {
							// Priority 1: Active file
							fallbackFiles = [editorContext.documentUri];
							this.postMessageToWebview({
								type: "statusUpdate",
								value: `AI selection yielded no relevant files. Falling back to the active file.`,
							});
						} else if (allScannedFiles.length > 0) {
							fallbackFiles = allScannedFiles.slice(
								0,
								Math.min(allScannedFiles.length, 0)
							);
							this.postMessageToWebview({
								type: "statusUpdate",
								value: `AI selection yielded no relevant files.`,
							});
						} else {
							// No files available at all
							fallbackFiles = [];
							this.postMessageToWebview({
								type: "statusUpdate",
								value: `AI selection yielded no relevant files and no files were scanned.`,
							});
						}
						filesForContextBuilding = fallbackFiles; // Assign fallback files
					}
				} catch (error: any) {
					console.error(
						`[ContextService] Error during smart file selection: ${error.message}`
					);
					this.postMessageToWebview({
						type: "statusUpdate",
						value: `Smart context selection failed due to an error. Falling back to limited context.`,
						isError: true,
					});

					let fallbackFiles: vscode.Uri[] = [];
					if (editorContext?.documentUri) {
						// Priority 1: Active file
						fallbackFiles = [editorContext.documentUri];
						this.postMessageToWebview({
							type: "statusUpdate",
							value: `Falling back to the active file.`,
						});
					} else if (allScannedFiles.length > 0) {
						// Priority 2: Small subset of scanned files (e.g., first 10)
						fallbackFiles = allScannedFiles.slice(
							0,
							Math.min(allScannedFiles.length, 10)
						);
						this.postMessageToWebview({
							type: "statusUpdate",
							value: `Falling back to a subset of scanned files (${fallbackFiles.length}).`,
						});
					} else {
						// No files available at all
						fallbackFiles = [];
						this.postMessageToWebview({
							type: "statusUpdate",
							value: `No files available for fallback.`,
						});
					}
					filesForContextBuilding = fallbackFiles; // Assign fallback files
				}
			} else if (currentQueryForSelection?.startsWith("/commit")) {
				return {
					contextString:
						"[Project context not applicable for git commit message generation]",
					relevantFiles: [],
				};
			}

			if (filesForContextBuilding.length === 0) {
				return {
					contextString: "[No relevant files selected for context.]",
					relevantFiles: [],
				};
			}

			let finalFilesForContextBuilding: vscode.Uri[] = Array.from(
				filesForContextBuilding
			);

			if (userRequest && rootFolder) {
				const userProvidedUris =
					await this._extractAndValidateUserProvidedFilePaths(
						userRequest,
						rootFolder.uri,
						allScannedFiles,
						cancellationToken
					);

				if (userProvidedUris.length > 0) {
					// Combine existing files with user-provided files
					const combinedUris =
						finalFilesForContextBuilding.concat(userProvidedUris);
					// Deduplicate the combined list
					finalFilesForContextBuilding = this._deduplicateUris(combinedUris);
				}
			}
			filesForContextBuilding = finalFilesForContextBuilding; // Update the original array

			// Convert filesForContextBuilding (vscode.Uri[]) to relative string paths
			const relativeFilesForContextBuilding: string[] =
				filesForContextBuilding.map((uri: vscode.Uri) =>
					path.relative(rootFolder.uri.fsPath, uri.fsPath).replace(/\\/g, "/")
				);

			// Context building with performance monitoring
			const contextBuildStartTime = Date.now();

			// Define verboseHeaderMarker before preamble logic
			let verboseHeaderMarker = "";
			if (includeVerboseHeaders) {
				verboseHeaderMarker = "/* VERBOSE_HEADERS_ENABLED */";
			}

			// 3. Update the final call to buildContextString to pass activeSymbolDetailedInfo
			const rawContextString = await buildContextString(
				filesForContextBuilding, // Still pass URIs to buildContextString for content reading
				rootFolder.uri,
				DEFAULT_CONTEXT_CONFIG,
				this.changeLogger.getChangeLog(),
				fileDependencies,
				documentSymbolsMap,
				activeSymbolDetailedInfo, // Pass the new argument
				activeSymbolDetailedInfo?.referencedTypeDefinitions ?? undefined // Corrected argument
			);

			// --- New logic to prepend project type preamble ---
			let preamble = "";
			try {
				if (detectedProjectProfile) {
					preamble = formatProjectProfileForPrompt(detectedProjectProfile);
				} else {
					console.log("[ContextService] No specific project type detected.");
				}
			} catch (preambleError: any) {
				console.warn(
					`[ContextService] Error generating project type preamble: ${preambleError.message}`
				);
				this.postMessageToWebview({
					type: "statusUpdate",
					value: `Warning: Could not generate project type info. Reason: ${preambleError.message}`,
					isError: true,
				});
			}

			let finalContextString = rawContextString; // Initialize with the originally built context string
			// Prepend verboseHeaderMarker if present
			if (verboseHeaderMarker) {
				finalContextString = `${verboseHeaderMarker}\n${rawContextString}`;
			}

			// Wrap the persona/preamble logic within the includePersona condition
			if (includePersona && preamble) {
				// Prepend the detected project type information
				finalContextString = `${preamble}\n\nProject Context:\n${finalContextString}`;
			}
			// --- End new logic ---

			const contextBuildTime = Date.now() - contextBuildStartTime;
			const totalTime = Date.now() - startTime;

			if (
				enablePerformanceMonitoring &&
				contextBuildTime > PERFORMANCE_THRESHOLDS.CONTEXT_BUILD_TIME_WARNING
			) {
				console.warn(
					`[ContextService] Context building took ${contextBuildTime}ms (threshold: ${PERFORMANCE_THRESHOLDS.CONTEXT_BUILD_TIME_WARNING}ms)`
				);
			}

			// Return the new object structure with performance metrics
			return {
				contextString: finalContextString, // Use the potentially modified context string
				relevantFiles: relativeFilesForContextBuilding,
				performanceMetrics: {
					scanTime,
					dependencyBuildTime,
					contextBuildTime,
					totalTime,
					fileCount: allScannedFiles.length,
					processedFileCount: filesForContextBuilding.length,
				},
				activeSymbolDetailedInfo: activeSymbolDetailedInfo,
			};
		} catch (error: any) {
			console.error(`[ContextService] Error building project context:`, error);
			this.postMessageToWebview({
				type: "statusUpdate",
				value: `Error building project context: ${error.message}`,
				isError: true,
			});
			return {
				contextString: `[Error building project context: ${error.message}]`,
				relevantFiles: [],
			};
		}
	}

	/**
	 * Build context using sequential file processing
	 */
	public async buildSequentialProjectContext(
		userRequest: string,
		options?: {
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
			onFileProcessed?: (summary: any) => void;
		}
	): Promise<BuildProjectContextResult> {
		try {
			const sequentialService = await this.initializeSequentialContextService();

			const result = await sequentialService.buildSequentialContext(
				userRequest,
				{
					enableSequentialProcessing:
						options?.enableSequentialProcessing ?? true,
					maxFilesPerBatch: options?.maxFilesPerBatch ?? 10,
					summaryLength: options?.summaryLength ?? 2000,
					enableDetailedAnalysis: options?.enableDetailedAnalysis ?? true,
					includeDependencies: options?.includeDependencies ?? true,
					complexityThreshold: options?.complexityThreshold ?? "medium",
					modelName: DEFAULT_FLASH_LITE_MODEL, // Use the default model for sequential processing
					onProgress: options?.onProgress,
					onFileProcessed: options?.onFileProcessed,
				}
			);

			return {
				contextString: result.contextString,
				relevantFiles: result.relevantFiles.map((uri) =>
					vscode.workspace.asRelativePath(uri)
				),
				performanceMetrics: {
					scanTime: result.processingMetrics.totalTime,
					dependencyBuildTime: 0, // Not applicable for sequential processing
					contextBuildTime: result.processingMetrics.totalTime,
					totalTime: result.processingMetrics.totalTime,
					fileCount: result.processingMetrics.totalFiles,
					processedFileCount: result.processingMetrics.processedFiles,
				},
			};
		} catch (error) {
			console.error("Error in sequential context building:", error);
			// Fallback to traditional context building
			return this.buildProjectContext(
				undefined,
				userRequest,
				undefined,
				undefined,
				{
					enablePerformanceMonitoring: false,
				}
			);
		}
	}

	public dispose(): void {
		console.log("[ContextService] Disposing workspace file system watchers...");
		this.disposables.forEach((disposable) => {
			try {
				disposable.dispose();
			} catch (error) {
				console.error("[ContextService] Error disposing watcher:", error);
			}
		});
		this.disposables = [];
		console.log("[ContextService] Workspace file system watchers disposed.");
	}
}
