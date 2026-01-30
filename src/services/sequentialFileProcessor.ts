import * as vscode from "vscode";
import { AIRequestService } from "./aiRequestService";
import { intelligentlySummarizeFileContent } from "../context/fileContentProcessor";
import {
	DEFAULT_FLASH_LITE_MODEL,
	TEMPERATURE,
} from "../sidebar/common/sidebarConstants";
import { SUPPORTED_CODE_EXTENSIONS } from "../utils/languageUtils";
export interface FileSummary {
	filePath: string;
	relativePath: string;
	summary: string;
	keyInsights: string[];
	fileType: string;
	estimatedComplexity: "low" | "medium" | "high";
	mainPurpose: string;
	dependencies?: string[];
	lastModified?: Date;
}

export interface SequentialProcessingOptions {
	maxFilesPerBatch?: number;
	summaryLength?: number;
	enableDetailedAnalysis?: boolean;
	includeDependencies?: boolean;
	complexityThreshold?: "low" | "medium" | "high";
	modelName?: string;
	onProgress?: (
		currentFile: string,
		totalFiles: number,
		progress: number,
	) => void;
	onFileProcessed?: (summary: FileSummary) => void;
}

export interface ProcessingContext {
	processedFiles: FileSummary[];
	currentContext: string;
	totalFiles: number;
	processedCount: number;
	userRequest?: string;
	workspaceRoot: vscode.Uri;
}

export class SequentialFileProcessor {
	private aiRequestService: AIRequestService;
	private workspaceRoot: vscode.Uri;
	private postMessageToWebview: (message: any) => void;
	private fileCache: Map<string, FileSummary> = new Map();
	private fileDependencies: Map<string, string[]>;
	private reverseFileDependencies: Map<string, string[]>;

	constructor(
		aiRequestService: AIRequestService,
		workspaceRoot: vscode.Uri,
		postMessageToWebview: (message: any) => void,
		fileDependencies: Map<string, string[]>,
		reverseFileDependencies: Map<string, string[]>,
	) {
		this.aiRequestService = aiRequestService;
		this.workspaceRoot = workspaceRoot;
		this.postMessageToWebview = postMessageToWebview;
		this.fileDependencies = fileDependencies;
		this.reverseFileDependencies = reverseFileDependencies;
	}

	/**
	 * Process files sequentially, building context incrementally
	 */
	public async processFilesSequentially(
		files: vscode.Uri[],
		userRequest: string,
		options: SequentialProcessingOptions = {},
	): Promise<{
		summaries: FileSummary[];
		finalContext: string;
		processingMetrics: {
			totalFiles: number;
			processedFiles: number;
			totalTime: number;
			averageTimePerFile: number;
		};
	}> {
		const startTime = Date.now();
		const {
			maxFilesPerBatch = 20,
			summaryLength = 10000,
			enableDetailedAnalysis = true,
			includeDependencies = true,
			complexityThreshold = "high",
			modelName = DEFAULT_FLASH_LITE_MODEL, // Use the default model for sequential processing
			onProgress,
			onFileProcessed,
		} = options;

		const processingContext: ProcessingContext = {
			processedFiles: [],
			currentContext: "",
			totalFiles: files.length,
			processedCount: 0,
			userRequest,
			workspaceRoot: this.workspaceRoot,
		};

		this.postMessageToWebview({
			type: "statusUpdate",
			value: `Starting sequential file processing for ${files.length} files...`,
		});

		// Process files in batches to maintain manageable context
		for (let i = 0; i < files.length; i += maxFilesPerBatch) {
			const batch = files.slice(i, i + maxFilesPerBatch);
			const batchStartTime = Date.now();

			this.postMessageToWebview({
				type: "statusUpdate",
				value: `Processing batch ${
					Math.floor(i / maxFilesPerBatch) + 1
				}/${Math.ceil(files.length / maxFilesPerBatch)} (${
					batch.length
				} files)...`,
			});

			// Process each file in the current batch
			for (const fileUri of batch) {
				const fileStartTime = Date.now();
				const relativePath = vscode.workspace.asRelativePath(fileUri);

				this.postMessageToWebview({
					type: "statusUpdate",
					value: `Analyzing: ${relativePath}`,
				});

				try {
					const summary = await this.processSingleFile(
						fileUri,
						processingContext,
						{
							summaryLength,
							enableDetailedAnalysis,
							includeDependencies,
							complexityThreshold,
							modelName,
						},
					);

					processingContext.processedFiles.push(summary);
					processingContext.processedCount++;

					// Update progress
					const progress =
						(processingContext.processedCount / processingContext.totalFiles) *
						100;
					onProgress?.(relativePath, processingContext.totalFiles, progress);

					// Call file processed callback
					onFileProcessed?.(summary);

					const fileTime = Date.now() - fileStartTime;
					console.log(`Processed ${relativePath} in ${fileTime}ms`);
				} catch (error) {
					console.error(`Error processing file ${relativePath}:`, error);
					// Continue with next file instead of failing completely
				}
			}

			// Update context after each batch
			processingContext.currentContext =
				this.buildIncrementalContext(processingContext);

			const batchTime = Date.now() - batchStartTime;
			console.log(`Batch processed in ${batchTime}ms`);
		}

		const totalTime = Date.now() - startTime;
		const averageTimePerFile = totalTime / processingContext.processedCount;

		this.postMessageToWebview({
			type: "statusUpdate",
			value: `Sequential processing complete. Processed ${processingContext.processedCount} files in ${totalTime}ms`,
		});

		return {
			summaries: processingContext.processedFiles,
			finalContext: processingContext.currentContext,
			processingMetrics: {
				totalFiles: files.length,
				processedFiles: processingContext.processedCount,
				totalTime,
				averageTimePerFile,
			},
		};
	}

	/**
	 * Process a single file and generate a comprehensive summary
	 *
	 * @param fileUri The URI of the file to process.
	 * @param context The current processing context, including previously processed files.
	 * @param options Processing options such as summary length, detailed analysis, and dependencies.
	 * @returns A promise that resolves to a FileSummary object for the processed file.
	 */
	public async processSingleFile(
		fileUri: vscode.Uri,
		context: ProcessingContext,
		options: {
			summaryLength: number;
			enableDetailedAnalysis: boolean;
			includeDependencies: boolean;
			complexityThreshold: "low" | "medium" | "high";
			modelName: string;
		},
	): Promise<FileSummary> {
		const relativePath = vscode.workspace.asRelativePath(fileUri);
		const fileExtension = this._getFileExtension(relativePath);

		// Get file stats for caching
		const fileStat = await vscode.workspace.fs.stat(fileUri);
		const cacheKey = `${relativePath}#${fileStat.mtime}`;

		// Check cache
		if (this.fileCache.has(cacheKey)) {
			return this.fileCache.get(cacheKey)!; // Return cached summary
		}

		// Read file content
		const contentBytes = await vscode.workspace.fs.readFile(fileUri);
		const fileContent = Buffer.from(contentBytes).toString("utf-8");

		const lastModified = new Date(fileStat.mtime); // Ensure lastModified is still available

		// Get document symbols for better analysis
		const document = await vscode.workspace.openTextDocument(fileUri);
		const symbols = await vscode.commands.executeCommand<
			vscode.DocumentSymbol[]
		>("vscode.executeDocumentSymbolProvider", fileUri);

		// Generate initial summary using existing intelligent summarization
		const initialSummary = intelligentlySummarizeFileContent(
			fileContent,
			symbols,
			undefined, // No active symbol info for batch processing
			options.summaryLength,
		);

		// Generate AI-powered detailed analysis if enabled
		let detailedAnalysis = "";
		let keyInsights: string[] = [];
		let estimatedComplexity: "low" | "medium" | "high" = "medium";
		let mainPurpose = "Unknown";

		if (options.enableDetailedAnalysis) {
			const analysisPrompt = this.createFileAnalysisPrompt(
				relativePath,
				fileContent,
				initialSummary,
				context,
				options,
			);

			try {
				detailedAnalysis = await this.aiRequestService.generateWithRetry(
					[{ text: analysisPrompt }],
					options.modelName,
					undefined,
					`file-analysis-${relativePath}`,
					{
						temperature: TEMPERATURE,
						maxOutputTokens: 65000, // Allow large responses for detailed analysis
					},
				);

				// Parse the AI response to extract structured information
				const parsedAnalysis = this.parseFileAnalysis(detailedAnalysis);
				keyInsights = parsedAnalysis.keyInsights;
				estimatedComplexity = parsedAnalysis.complexity;
				mainPurpose = parsedAnalysis.mainPurpose;
			} catch (error) {
				console.warn(
					`[SequentialFileProcessor] Failed to get detailed analysis for ${relativePath}:`,
					error,
				);
				// Fallback to basic analysis
				keyInsights = this.generateBasicInsights(fileContent, fileExtension);
				estimatedComplexity = this.estimateComplexity(fileContent, symbols);
				mainPurpose = this.determineMainPurpose(fileExtension, relativePath);
			}
		} else {
			// Use basic analysis
			keyInsights = this.generateBasicInsights(fileContent, fileExtension);
			estimatedComplexity = this.estimateComplexity(fileContent, symbols);
			mainPurpose = this.determineMainPurpose(fileExtension, relativePath);
		}

		// Extract dependencies if enabled
		let dependencies: string[] = [];
		if (options.includeDependencies) {
			// Try AI-based extraction
			try {
				const aiDependencies = await this.extractDependenciesAI(
					fileContent,
					fileExtension,
					options.modelName,
				);

				dependencies = aiDependencies;
			} catch (error) {
				console.warn(
					`[SequentialFileProcessor] AI dependency extraction failed for ${relativePath}. Falling back to regex.`,
					error,
				);

				// Fallback to regex
				const resolvedDependencies =
					this.fileDependencies.get(relativePath) ||
					this.extractDependencies(fileContent, fileExtension);
				dependencies = resolvedDependencies;
			}
		}

		const summary: FileSummary = {
			filePath: fileUri.fsPath,
			relativePath,
			summary: initialSummary,
			keyInsights,
			fileType: fileExtension,
			estimatedComplexity,
			mainPurpose,
			dependencies,
			lastModified,
		};

		// Store in cache before returning
		const finalCacheKey = `${relativePath}#${fileStat.mtime}`; // Use fileStat.mtime directly for consistency
		this.fileCache.set(finalCacheKey, summary);

		return summary;
	}

	/**
	 * Creates a prompt string for AI-powered file analysis.
	 * The prompt includes file details, an initial summary, and contextual information from previously processed files.
	 * It explicitly requests a JSON output format with examples and constraints.
	 *
	 * @param relativePath The relative path of the file being analyzed.
	 * @param fileContent The full content of the file.
	 * @param initialSummary An initial summary of the file generated by intelligent summarization.
	 * @param context The current processing context, including previously processed file summaries.
	 * @param options Additional processing options (not directly used in prompt generation, but included for completeness).
	 * @returns A formatted string prompt for the AI.
	 */
	private createFileAnalysisPrompt(
		relativePath: string,
		fileContent: string,
		initialSummary: string,
		context: ProcessingContext,
		options: any,
	): string {
		let contextInfo = "";
		// Condense contextInfo to include mainPurpose and keyInsights of a few critical, highly relevant previously processed files.
		// Select the most recent 2-3 files for brevity to avoid excessive token usage.
		const relevantPreviousFiles = context.processedFiles.slice(-3);
		if (relevantPreviousFiles.length > 0) {
			contextInfo +=
				"\nContext from recently processed files (max 3 most recent):";
			relevantPreviousFiles.forEach((file) => {
				contextInfo += `\n- Path: ${file.relativePath}`;
				contextInfo += `\n  Purpose: ${file.mainPurpose}`;
				if (file.keyInsights.length > 0) {
					// Limit insights for brevity within the context
					contextInfo += `\n  Key Insights: ${file.keyInsights
						.slice(0, 2)
						.join(", ")}${file.keyInsights.length > 2 ? "..." : ""}`;
				}
			});
		} else {
			contextInfo +=
				"\nThis is the first file being processed, or no relevant previous files were found.";
		}

		return `Analyze this file and provide structured insights strictly in JSON format. Do not include any other text or commentary outside the JSON.

File: ${relativePath}
File Type: ${this._getFileExtension(relativePath)}
Content Length: ${fileContent.length} characters
${contextInfo}

Initial Summary of this file's content:
${initialSummary}

Your analysis should provide:
1.  Key insights about the file's primary purpose, core functionality, and significant characteristics. Keep insights brief and to the point.
2.  An estimated complexity of the file.
3.  The main purpose of the file.
4.  Any important patterns, architectural decisions, or notable code characteristics.

Respond STRICTLY in the following JSON format. Ensure all keys are present and values strictly adhere to the specified types.
Key insights should be an array of strings (max 5 items).
Complexity must be one of 'low', 'medium', or 'high'.
Main purpose should be a concise string description.
\`\`\`json
{
  "keyInsights": [
    "Example: Implements user authentication logic and session management.",
    "Example: Utility functions for date formatting and validation.",
    "Example: Defines the data model and API endpoints for products."
  ],
  "complexity": "low" | "medium" | "high",
  "mainPurpose": "Example: Manages the lifecycle of user authentication tokens."
}
\`\`\`
`;
	}

	/**
	 * Parses the AI analysis response string to extract structured information.
	 * Includes robust error handling, specific regex for JSON extraction,
	 * checks for expected keys, and validates the 'complexity' field.
	 *
	 * @param analysis The raw string response from the AI.
	 * @returns An object containing key insights, complexity, and main purpose, with default values on error.
	 */
	private parseFileAnalysis(analysis: string): {
		keyInsights: string[];
		complexity: "low" | "medium" | "high";
		mainPurpose: string;
	} {
		try {
			// Use a more specific regex for JSON block extraction to handle surrounding text/whitespace.
			// The `*?` makes the match non-greedy.
			const jsonMatch = analysis.match(/\s*(\{[\s\S]*?\})\s*/);
			if (jsonMatch && jsonMatch[1]) {
				const parsed = JSON.parse(jsonMatch[1]);

				// 2. Add checks for the presence of expected keys
				const keyInsights = Array.isArray(parsed.keyInsights)
					? parsed.keyInsights.filter((item: any) => typeof item === "string")
					: [];
				if (keyInsights.length === 0) {
					console.warn(
						`[SequentialFileProcessor] 'keyInsights' field is missing, empty, or not an array of strings in AI analysis.`,
					);
				}

				let complexity: "low" | "medium" | "high" = "medium";
				if (typeof parsed.complexity === "string") {
					const lowerComplexity = parsed.complexity.toLowerCase();
					// 4. Validating that the `complexity` field strictly adheres to 'low', 'medium', or 'high'
					if (["low", "medium", "high"].includes(lowerComplexity)) {
						complexity = lowerComplexity as "low" | "medium" | "high";
					} else {
						console.warn(
							`[SequentialFileProcessor] Invalid 'complexity' value received: "${parsed.complexity}". Defaulting to "medium".`,
						);
					}
				} else {
					console.warn(
						`[SequentialFileProcessor] Missing or invalid 'complexity' field in AI analysis. Defaulting to "medium".`,
					);
				}

				const mainPurpose =
					typeof parsed.mainPurpose === "string" &&
					parsed.mainPurpose.trim().length > 0
						? parsed.mainPurpose.trim()
						: "Unknown";
				if (mainPurpose === "Unknown") {
					console.warn(
						`[SequentialFileProcessor] Missing or empty 'mainPurpose' field in AI analysis.`,
					);
				}

				return {
					keyInsights,
					complexity,
					mainPurpose,
				};
			} else {
				console.warn(
					"[SequentialFileProcessor] No valid JSON block found in AI analysis response. Falling back to default values.",
				);
			}
		} catch (error) {
			// 3. Implementing default values and logging for parsing errors
			console.warn(
				"[SequentialFileProcessor] Failed to parse AI analysis response as JSON:",
				error,
			);
			console.warn(
				"[SequentialFileProcessor] Raw AI analysis response (for debugging):",
				analysis.substring(0, 500) + (analysis.length > 500 ? "..." : ""),
			);
		}

		// Fallback parsing / default values
		return {
			keyInsights: [],
			complexity: "medium",
			mainPurpose: "Unknown",
		};
	}

	/**
	 * Generates a list of basic insights about a file without requiring AI analysis.
	 * This serves as a fallback when detailed AI analysis is disabled or fails.
	 *
	 * @param fileContent The full content of the file.
	 * @param fileExtension The extension of the file.
	 * @returns An array of string insights.
	 */
	private generateBasicInsights(
		fileContent: string,
		fileExtension: string,
	): string[] {
		const insights: string[] = [];

		// Basic analysis based on file content
		if (fileContent.includes("import") || fileContent.includes("require")) {
			insights.push("Contains imports/dependencies");
		}

		if (fileContent.includes("class") || fileContent.includes("function")) {
			insights.push("Contains classes or functions");
		}

		if (fileContent.includes("export")) {
			insights.push("Exports functionality");
		}

		if (fileContent.includes("interface") || fileContent.includes("type")) {
			insights.push("Contains type definitions");
		}

		return insights.length > 0 ? insights : ["Standard code file"];
	}

	/**
	 * Recursively calculates the maximum nesting depth of symbols.
	 * This is used as a metric for estimating file complexity.
	 *
	 * @param symbols The array of document symbols.
	 * @param currentDepth The current depth in the recursion (internal use).
	 * @returns The maximum nesting depth found among the provided symbols and their children.
	 */
	private _calculateMaxNestingDepth(
		symbols: vscode.DocumentSymbol[],
		currentDepth: number = 0,
	): number {
		let maxDepth = currentDepth;
		for (const symbol of symbols) {
			if (symbol.children && symbol.children.length > 0) {
				maxDepth = Math.max(
					maxDepth,
					this._calculateMaxNestingDepth(symbol.children, currentDepth + 1),
				);
			}
		}
		return maxDepth;
	}

	/**
	 * Estimates the complexity of a file based on various metrics.
	 * Metrics include line count, total symbol count, number of functions/methods,
	 * number of classes/interfaces, and the maximum nesting depth of symbols.
	 *
	 * @param fileContent The full content of the file.
	 * @param symbols An optional array of `vscode.DocumentSymbol` objects for the file.
	 * @returns A string indicating the estimated complexity: 'low', 'medium', or 'high'.
	 */
	private estimateComplexity(
		fileContent: string,
		symbols?: vscode.DocumentSymbol[],
	): "low" | "medium" | "high" {
		const lines = fileContent.split("\n").length;
		const symbolCount = symbols?.length || 0;

		let functionMethodCount = 0;
		let classInterfaceCount = 0;
		let maxNestingDepth = 0;

		if (symbols) {
			functionMethodCount = symbols.filter(
				(s) =>
					s.kind === vscode.SymbolKind.Function ||
					s.kind === vscode.SymbolKind.Method,
			).length;
			classInterfaceCount = symbols.filter(
				(s) =>
					s.kind === vscode.SymbolKind.Class ||
					s.kind === vscode.SymbolKind.Interface,
			).length;
			maxNestingDepth = this._calculateMaxNestingDepth(symbols);
		}

		let complexityScore = 0;

		// Line count contribution
		if (lines > 700) {
			complexityScore += 3;
		} else if (lines > 300) {
			complexityScore += 2;
		} else if (lines > 100) {
			complexityScore += 1;
		}

		// Symbol count contribution
		if (symbolCount > 30) {
			complexityScore += 3;
		} else if (symbolCount > 15) {
			complexityScore += 2;
		} else if (symbolCount > 5) {
			complexityScore += 1;
		}

		// Function/method count contribution
		if (functionMethodCount > 10) {
			complexityScore += 2;
		} else if (functionMethodCount > 5) {
			complexityScore += 1;
		}

		// Class/interface count contribution
		if (classInterfaceCount > 3) {
			complexityScore += 2;
		} else if (classInterfaceCount > 1) {
			complexityScore += 1;
		}

		// Nesting depth contribution (e.g., deeply nested logic can indicate higher complexity)
		if (maxNestingDepth > 5) {
			complexityScore += 2;
		} else if (maxNestingDepth > 2) {
			complexityScore += 1;
		}

		// Adjust thresholds for 'high', 'medium', 'low' based on desired distribution
		if (complexityScore >= 6) {
			return "high";
		}
		if (complexityScore >= 3) {
			return "medium";
		}
		return "low";
	}

	/**
	 * Determines the main purpose of a file based on its extension and relative path segments.
	 * Provides a comprehensive set of case-insensitive rules and a sensible fallback logic for unknown types.
	 *
	 * @param fileExtension The lowercase extension of the file (e.g., 'ts', 'js', 'json').
	 * @param relativePath The relative path of the file within the workspace.
	 * @returns A string describing the main purpose of the file.
	 */
	private determineMainPurpose(
		fileExtension: string,
		relativePath: string,
	): string {
		const pathLower = relativePath.toLowerCase();

		// Prioritize path-based heuristics for common project structures
		if (
			pathLower.includes("test") ||
			pathLower.includes("spec") ||
			pathLower.endsWith(".test.ts") ||
			pathLower.endsWith(".spec.ts")
		) {
			return "Testing";
		}
		if (
			pathLower.includes("config") ||
			pathLower.includes("setup") ||
			pathLower.includes("env")
		) {
			return "Configuration";
		}
		if (
			pathLower.includes("util") ||
			pathLower.includes("helper") ||
			pathLower.includes("utils")
		) {
			return "Utility";
		}
		if (
			pathLower.includes("service") ||
			pathLower.includes("api") ||
			pathLower.includes("controller")
		) {
			return "Service/API";
		}
		if (
			pathLower.includes("component") ||
			pathLower.includes("ui") ||
			pathLower.includes("view") ||
			pathLower.includes("page")
		) {
			return "UI Component";
		}
		if (
			pathLower.includes("model") ||
			pathLower.includes("type") ||
			pathLower.includes("schema") ||
			pathLower.includes("entity")
		) {
			return "Data Model";
		}
		if (pathLower.includes("route") || pathLower.includes("router")) {
			return "Routing";
		}
		if (
			pathLower.includes("store") ||
			pathLower.includes("redux") ||
			pathLower.includes("vuex") ||
			pathLower.includes("state")
		) {
			return "State Management";
		}
		if (pathLower.includes("middleware")) {
			return "Middleware";
		}
		if (
			pathLower.includes("db") ||
			pathLower.includes("database") ||
			pathLower.includes("migrations")
		) {
			return "Database Schema/Access";
		}
		if (pathLower.includes("hook") || pathLower.includes("hooks")) {
			return "Custom Hook";
		}
		if (pathLower.includes("provider") || pathLower.includes("context")) {
			return "Context/Provider";
		}
		if (pathLower.includes("constants")) {
			return "Constants Definition";
		}
		if (
			pathLower.includes("asset") ||
			pathLower.includes("public") ||
			pathLower.includes("static")
		) {
			return "Static Asset";
		}
		if (
			pathLower.includes("index") ||
			pathLower.endsWith("main.ts") ||
			pathLower.endsWith("app.ts") ||
			pathLower.endsWith("server.ts")
		) {
			return "Entry Point/Main Application";
		}
		if (pathLower.includes("docs") || pathLower.includes("documentation")) {
			return "Documentation";
		}

		// Fallback to extension-based heuristics
		switch (fileExtension) {
			case "json":
			case "yaml":
			case "yml":
			case "ini":
			case "xml":
				return "Configuration/Data";
			case "md":
			case "markdown":
			case "txt":
				return "Documentation/Text";
			case "ts":
			case "js":
			case "jsx":
			case "tsx":
			case "vue":
			case "svelte":
			case "py":
			case "java":
			case "cs":
			case "go":
			case "rb":
			case "php":
			case "cpp":
			case "c":
			case "rs": // Rust
			case "kt": // Kotlin
			case "swift": // Swift
			case "dart": // Dart
				return "Source Code";
			case "css":
			case "scss":
			case "sass":
			case "less":
				return "Styling";
			case "html":
			case "htm":
				return "Markup";
			case "sql":
				return "SQL Script";
			case "sh":
			case "bash":
			case "ps1": // PowerShell
				return "Shell Script";
			case "lock": // package-lock.json, yarn.lock etc.
			case "snap": // Jest snapshots
				return "Package Lock/Snapshot";
			case "log":
				return "Log File";
			default:
				// If it's a commonly recognized code extension but didn't match a specific purpose, default to Source Code.
				if (
					[
						"ts",
						"js",
						"jsx",
						"tsx",
						"vue",
						"svelte",
						"py",
						"java",
						"cs",
						"go",
						"rb",
						"php",
						"cpp",
						"c",
						"rs",
						"kt",
						"swift",
						"dart",
					].includes(fileExtension)
				) {
					return "Source Code";
				}
				return "Unknown File Type"; // Explicit fallback for truly unknown types
		}
	}

	/**
	 * Extracts module dependencies from file content based on common import/require patterns.
	 * This function reviews and enhances current regex patterns for various import/require syntaxes,
	 * ensuring precise matching of module specifiers and minimizing false positives.
	 * It covers ES Module `import` (static and dynamic), CommonJS `require`, and `export from` syntax,
	 * including string literals using single quotes, double quotes, and backticks.
	 *
	 * @param fileContent The full content of the file.
	 * @param fileExtension The extension of the file (e.g., 'ts', 'js', 'jsx', 'tsx').
	 * @returns An array of unique module specifiers (e.g., 'react', './utils/helper', 'lodash').
	 */
	private extractDependencies(
		fileContent: string,
		fileExtension: string,
	): string[] {
		const dependencies: string[] = [];

		if (["ts", "js", "jsx", "tsx"].includes(fileExtension)) {
			// Regex for ES Module static imports: `import ... from 'module'` or `import 'module'`
			// Captures the module path inside single, double, or backtick quotes.
			const esModuleStaticImportRegex =
				/(?:import(?:["'\s]*(?:[\w*{}\n\r\t, ]+)from\s*)?|export\s+(?:.*?from\s*)?)["'`]([^"'`]+)["'`]/g;
			let match;
			while ((match = esModuleStaticImportRegex.exec(fileContent)) !== null) {
				if (match[1]) {
					dependencies.push(match[1].trim());
				}
			}

			// Regex for dynamic imports: `import('module')`
			const dynamicImportRegex = /import\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
			while ((match = dynamicImportRegex.exec(fileContent)) !== null) {
				if (match[1]) {
					dependencies.push(match[1].trim());
				}
			}

			// Regex for CommonJS requires: `require('module')`
			const commonJsRequireRegex = /require\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
			while ((match = commonJsRequireRegex.exec(fileContent)) !== null) {
				if (match[1]) {
					dependencies.push(match[1].trim());
				}
			}
		}

		// Remove duplicates to avoid redundant entries
		return Array.from(new Set(dependencies));
	}

	/**
	 * Builds an incremental context string from the currently processed files.
	 * This context provides an overview of the files analyzed so far,
	 * including complexity breakdown, purpose distribution, and summaries of recent files.
	 *
	 * @param context The current processing context.
	 * @returns A string representing the incremental context.
	 */
	private buildIncrementalContext(context: ProcessingContext): string {
		if (context.processedFiles.length === 0) {
			return "No files processed yet.";
		}

		let contextString = `Sequential File Analysis Summary:\n`;
		contextString += `Total files processed: ${context.processedCount}/${context.totalFiles}\n\n`;

		// Group files by complexity and purpose
		const byComplexity = {
			high: context.processedFiles.filter(
				(f) => f.estimatedComplexity === "high",
			),
			medium: context.processedFiles.filter(
				(f) => f.estimatedComplexity === "medium",
			),
			low: context.processedFiles.filter(
				(f) => f.estimatedComplexity === "low",
			),
		};

		const byPurpose = new Map<string, FileSummary[]>();
		context.processedFiles.forEach((file) => {
			const purpose = file.mainPurpose;
			if (!byPurpose.has(purpose)) {
				byPurpose.set(purpose, []);
			}
			byPurpose.get(purpose)!.push(file);
		});

		// Add complexity breakdown
		contextString += `Complexity Breakdown:\n`;
		contextString += `- High complexity: ${byComplexity.high.length} files\n`;
		contextString += `- Medium complexity: ${byComplexity.medium.length} files\n`;
		contextString += `- Low complexity: ${byComplexity.low.length} files\n\n`;

		// Add purpose breakdown
		contextString += `Purpose Breakdown:\n`;
		for (const [purpose, files] of byPurpose) {
			contextString += `- ${purpose}: ${files.length} files\n`;
		}
		contextString += `\n`;

		// Add recent file summaries (last 5 files)
		const recentFiles = context.processedFiles.slice(-5);
		contextString += `Recent File Summaries:\n`;
		for (const file of recentFiles) {
			contextString += `\n--- ${file.relativePath} ---\n`;
			contextString += `Purpose: ${file.mainPurpose}\n`;
			contextString += `Complexity: ${file.estimatedComplexity}\n`;
			if (file.keyInsights.length > 0) {
				contextString += `Key Insights: ${file.keyInsights.join(", ")}\n`;
			}
			contextString += `Summary: ${file.summary.substring(0, 300)}${
				file.summary.length > 300 ? "..." : ""
			}\n`;
		}

		return contextString;
	}

	/**
	 * Get a specific file's detailed context for AI processing, leveraging summaries of previously analyzed files.
	 * This context aims to provide the AI with highly relevant information from the project history,
	 * prioritizing files based on inferred relevance to the current file and user request.
	 *
	 * @param fileUri The URI of the file for which context is being generated.
	 * @param previousSummaries An array of summaries of files processed previously in the sequence.
	 * @param userRequest The user's current request.
	 * @returns A string containing the contextual information for the AI.
	 */
	public async getFileContextForAI(
		fileUri: vscode.Uri,
		previousSummaries: FileSummary[],
		userRequest: string,
	): Promise<string> {
		const relativePath = vscode.workspace.asRelativePath(fileUri);

		let context = `Processing file: ${relativePath}\n`;
		context += `User request: ${userRequest}\n\n`;

		if (previousSummaries.length > 0) {
			context += `Context from previously analyzed files:\n`;
			context += `Total files analyzed: ${previousSummaries.length}\n\n`;

			// Find and add relevant previous file summaries, sorted by relevance and limited in number.
			const relevantFiles = this.findRelevantPreviousFiles(
				previousSummaries,
				fileUri, // Pass fileUri to `findRelevantPreviousFiles` for more granular path-based checks.
				userRequest,
			);

			// Limit the number of previously processed file summaries included to prevent context overload.
			// The `slice(0, N)` ensures we take the *top N* most relevant files as determined by `findRelevantPreviousFiles`.
			const maxRelevantContextFiles = 10; // Limit to 10 files for context brevity
			for (const file of relevantFiles.slice(0, maxRelevantContextFiles)) {
				context += `--- ${file.relativePath} ---\n`;
				context += `Purpose: ${file.mainPurpose}\n`;
				context += `Complexity: ${file.estimatedComplexity}\n`;
				if (file.keyInsights.length > 0) {
					context += `Key insights: ${file.keyInsights.join(", ")}\n`;
				}
				context += `Summary: ${file.summary.substring(0, 200)}${
					file.summary.length > 200 ? "..." : ""
				}\n\n`;
			}

			if (relevantFiles.length > maxRelevantContextFiles) {
				context += `... (additional ${
					relevantFiles.length - maxRelevantContextFiles
				} relevant files not shown to save space)\n\n`;
			}
		}

		return context;
	}

	/**
	 * Finds relevant previous files based on dependencies, shared purpose, and user request.
	 * This function assigns a score to each previously processed file to determine its relevance.
	 * Prioritization:
	 * 1. Files whose dependencies list contains the current file (reverse dependency).
	 * 2. Files whose `mainPurpose` or `keyInsights` align with the `userRequest`.
	 * 3. More recently processed files receive a slight recency bonus.
	 * The result is sorted by score and de-duplicated.
	 *
	 * @param previousSummaries An array of previously processed file summaries.
	 * @param currentFileUri The URI of the file currently being processed.
	 * @param userRequest The user's current request string.
	 * @returns A sorted and de-duplicated array of `FileSummary` objects, representing the most relevant previous files.
	 */
	private findRelevantPreviousFiles(
		previousSummaries: FileSummary[],
		currentFileUri: vscode.Uri,
		userRequest: string,
	): FileSummary[] {
		const currentRelativePath = vscode.workspace.asRelativePath(currentFileUri);
		const currentFsPath = currentFileUri.fsPath;
		const requestLower = userRequest.toLowerCase();
		const scoredFiles = new Map<
			string,
			{ summary: FileSummary; score: number }
		>();

		// Helper to add/update score for a file
		const addScore = (summary: FileSummary, score: number) => {
			const existing = scoredFiles.get(summary.relativePath);
			if (existing) {
				existing.score += score;
			} else {
				scoredFiles.set(summary.relativePath, { summary, score });
			}
		};

		// 1. Prioritize files that explicitly import or require the *current file*
		//    Using the injected reverseFileDependencies map for accurate lookup.
		const filesDependingOnCurrent =
			this.reverseFileDependencies.get(currentFsPath);
		if (filesDependingOnCurrent) {
			for (const file of previousSummaries) {
				if (filesDependingOnCurrent.includes(file.filePath)) {
					addScore(file, 5); // Highest score for direct import awareness
				}
			}
		}

		// 2. Prioritize files that share a similar `mainPurpose` or contain `keyInsights` strongly matching the user's request.
		for (const file of previousSummaries) {
			let purposeInsightsScore = 0;
			if (file.mainPurpose.toLowerCase().includes(requestLower)) {
				purposeInsightsScore += 3; // High score for direct purpose match
			}
			if (
				file.keyInsights.some((insight) =>
					insight.toLowerCase().includes(requestLower),
				)
			) {
				purposeInsightsScore += 2; // Moderate score for insight match
			}
			if (purposeInsightsScore > 0) {
				addScore(file, purposeInsightsScore);
			}
		}

		// 3. Prioritize most recently processed files (higher index means more recent)
		previousSummaries.forEach((file, index) => {
			// Assign a small recency bonus. More recent files are slightly preferred.
			addScore(file, index * 0.001); // Small coefficient to avoid dominating other scores
		});

		// Sort by score (descending)
		const sortedFiles = Array.from(scoredFiles.values())
			.sort((a, b) => b.score - a.score)
			.map((item) => item.summary);

		// Deduplicate the results ensuring unique file paths, keeping the one with higher score if duplicates arose from different scoring paths
		const uniqueFiles = new Map<string, FileSummary>();
		for (const file of sortedFiles) {
			if (!uniqueFiles.has(file.relativePath)) {
				uniqueFiles.set(file.relativePath, file);
			}
		}
		return Array.from(uniqueFiles.values());
	}

	/**
	 * Extracts and normalizes the file extension from a given relative path.
	 * This helper ensures consistency in determining file types.
	 *
	 * @param relativePath The relative path of the file.
	 * @returns The lowercase file extension, or 'unknown' if no extension is found.
	 */
	private _getFileExtension(relativePath: string): string {
		return relativePath.split(".").pop()?.toLowerCase() || "unknown";
	}

	/**
	 * Uses AI to extract dependencies from file content.
	 * Falls back to regex if AI fails.
	 */
	private async extractDependenciesAI(
		fileContent: string,
		fileExtension: string,
		modelName: string,
	): Promise<string[]> {
		// Skip for non-code files
		if (!SUPPORTED_CODE_EXTENSIONS.includes(fileExtension)) {
			return [];
		}

		const prompt = `Extract all imported module names (e.g. 'react', './utils', 'fs') from this ${fileExtension} code.
Ignore built-in language keywords unless they are explicitly imported modules.
Return ONLY a valid JSON array of strings. Do not include markdown code blocks.

Code:
${fileContent.substring(0, 8000)} // Truncate to avoid token limits on huge files
`;

		try {
			const response = await this.aiRequestService.generateWithRetry(
				[{ text: prompt }],
				modelName,
				undefined,
				"dependency_extraction",
				{ responseMimeType: "application/json" },
				undefined,
				undefined,
				false,
				"You are a code analysis expert. Extract all module dependencies from the provided code snippet. Return a strict JSON array of strings choices.",
			);

			// Clean and parse JSON
			const jsonMatch = response.match(/\[.*\]/s);
			if (jsonMatch) {
				const parsed = JSON.parse(jsonMatch[0]);
				if (
					Array.isArray(parsed) &&
					parsed.every((i) => typeof i === "string")
				) {
					return parsed;
				}
			}
			console.warn(
				"[SequentialFileProcessor] AI response was not a valid string array:",
				response,
			);
			throw new Error("Invalid JSON response");
		} catch (error) {
			console.warn(
				"[SequentialFileProcessor] AI Dependency extraction error:",
				error,
			);
			throw error; // Re-throw to trigger fallback
		}
	}
}
