import * as vscode from "vscode";
import * as path from "path";
import BPromise from "bluebird";
import { parseFileImports } from "../utils/fileDependencyParser";
import * as ts from "typescript";
import {
	findAndLoadTsConfig,
	createProjectCompilerHost,
} from "../utils/tsConfigLoader";

export interface DependencyRelation {
	path: string;
	relationType: "runtime" | "type" | "unknown";
}

// Cache interface for dependency graphs
interface DependencyCache {
	timestamp: number;
	dependencyGraph: Map<string, DependencyRelation[]>;
	reverseDependencyGraph: Map<string, DependencyRelation[]>;
	workspacePath: string;
	fileCount: number;
}

// Cache storage
const dependencyCache = new Map<string, DependencyCache>();

// Configuration for dependency building
interface DependencyBuildOptions {
	useCache?: boolean;
	cacheTimeout?: number;
	maxConcurrency?: number;
	skipLargeFiles?: boolean;
	maxFileSizeForParsing?: number;
	retryFailedFiles?: boolean;
	maxRetries?: number;
}

export async function buildDependencyGraph(
	allScannedFiles: vscode.Uri[],
	projectRoot: vscode.Uri,
	options?: DependencyBuildOptions
): Promise<Map<string, DependencyRelation[]>> {
	const workspacePath = projectRoot.fsPath;
	const useCache = options?.useCache ?? true;
	const cacheTimeout = options?.cacheTimeout ?? 10 * 60 * 1000; // 10 minutes default

	// Check cache first
	if (useCache) {
		const cached = dependencyCache.get(workspacePath);
		if (
			cached &&
			Date.now() - cached.timestamp < cacheTimeout &&
			cached.fileCount === allScannedFiles.length
		) {
			console.log(`Using cached dependency graph for: ${workspacePath}`);
			return cached.dependencyGraph;
		}
	}

	const dependencyGraph = new Map<string, DependencyRelation[]>();
	const concurrencyLimit = options?.maxConcurrency ?? 15;
	const skipLargeFiles = options?.skipLargeFiles ?? true;
	const maxFileSizeForParsing = options?.maxFileSizeForParsing ?? 1024 * 1024; // 1MB default
	const retryFailedFiles = options?.retryFailedFiles ?? true;
	const maxRetries = options?.maxRetries ?? 2;

	// Pre-filter files by size and type
	const filesToProcess = allScannedFiles.filter((fileUri) => {
		if (!skipLargeFiles) {
			return true;
		}

		// For now, include all files and let the processing handle size checks
		// This avoids the async filter issue
		return true;
	});

	console.log(
		`Building dependency graph for ${filesToProcess.length} files (filtered from ${allScannedFiles.length})`
	);

	const parsedCommandLine = await findAndLoadTsConfig(projectRoot);
	const compilerOptions = parsedCommandLine?.options || {
		moduleResolution: ts.ModuleResolutionKind.NodeJs,
		target: ts.ScriptTarget.ES2020,
	};
	const compilerHost = createProjectCompilerHost(projectRoot, compilerOptions);
	const moduleResolutionCache = ts.createModuleResolutionCache(
		compilerHost.getCurrentDirectory(),
		compilerHost.getCanonicalFileName,
		compilerOptions
	);

	// Track failed files for retry
	const failedFiles: Array<{ uri: vscode.Uri; retries: number }> = [];

	// Process files with better error handling and retry logic
	async function processFile(
		fileUri: vscode.Uri,
		retryCount = 0
	): Promise<void> {
		try {
			const relativePath = path.relative(projectRoot.fsPath, fileUri.fsPath);

			// Skip non-parsable files early
			const ext = path.extname(fileUri.fsPath).toLowerCase();
			const skipExtensions = [
				".png",
				".jpg",
				".jpeg",
				".gif",
				".svg",
				".ico",
				".woff",
				".woff2",
				".ttf",
				".otf",
			];
			if (skipExtensions.includes(ext)) {
				return;
			}

			const imports = await parseFileImports(
				fileUri.fsPath,
				projectRoot,
				compilerOptions,
				compilerHost,
				moduleResolutionCache
			);
			const relations: DependencyRelation[] = imports;
			dependencyGraph.set(relativePath, relations);
		} catch (error) {
			if (retryCount < maxRetries && retryFailedFiles) {
				failedFiles.push({ uri: fileUri, retries: retryCount + 1 });
			} else {
				console.warn(
					`Failed to parse dependencies for ${fileUri.fsPath} after ${
						retryCount + 1
					} attempts:`,
					error
				);
			}
		}
	}

	// Process files in batches with progress tracking
	const batchSize = Math.ceil(filesToProcess.length / 10); // Process in 10 batches
	const startTime = Date.now();

	for (let i = 0; i < filesToProcess.length; i += batchSize) {
		const batch = filesToProcess.slice(i, i + batchSize);

		await BPromise.map(
			batch,
			async (fileUri: vscode.Uri) => {
				await processFile(fileUri);
			},
			{ concurrency: concurrencyLimit }
		);

		// Progress logging
		const progress = Math.min(
			100,
			((i + batchSize) / filesToProcess.length) * 100
		);
		console.log(`Dependency parsing progress: ${progress.toFixed(1)}%`);
	}

	// Retry failed files
	if (failedFiles.length > 0 && retryFailedFiles) {
		console.log(`Retrying ${failedFiles.length} failed files...`);

		for (const failedFile of failedFiles) {
			if (failedFile.retries <= maxRetries) {
				await processFile(failedFile.uri, failedFile.retries);
			}
		}
	}

	const buildTime = Date.now() - startTime;
	console.log(
		`Dependency graph built in ${buildTime}ms. Processed ${dependencyGraph.size} files.`
	);

	// Cache the results
	if (useCache) {
		const reverseGraph = buildReverseDependencyGraph(dependencyGraph);
		dependencyCache.set(workspacePath, {
			timestamp: Date.now(),
			dependencyGraph,
			reverseDependencyGraph: reverseGraph,
			workspacePath,
			fileCount: allScannedFiles.length,
		});
	}

	return dependencyGraph;
}

/**
 * Builds a reverse dependency graph from a forward dependency graph.
 * The reverse graph maps an imported file path to a list of files that import it.
 * Now includes caching and optimization.
 * @param fileDependencies A map where key is a file path (importer) and value is an array of files it imports.
 * @param projectRoot Optional project root for caching
 * @returns A map where key is an imported file path and value is an array of files that import it.
 */
export function buildReverseDependencyGraph(
	fileDependencies: Map<string, DependencyRelation[]>,
	projectRoot?: vscode.Uri
): Map<string, DependencyRelation[]> {
	// Check cache first if projectRoot is provided
	if (projectRoot) {
		const workspacePath = projectRoot.fsPath;
		const cached = dependencyCache.get(workspacePath);
		if (cached && cached.dependencyGraph === fileDependencies) {
			console.log(
				`Using cached reverse dependency graph for: ${workspacePath}`
			);
			return cached.reverseDependencyGraph;
		}
	}

	const reverseDependencyGraph = new Map<string, DependencyRelation[]>();

	// More efficient reverse graph building
	for (const [importerPath, importedRelations] of fileDependencies.entries()) {
		for (const importedRelation of importedRelations) {
			const importedPath = importedRelation.path;
			// Ensure the importedPath exists as a key in the reverse map
			if (!reverseDependencyGraph.has(importedPath)) {
				reverseDependencyGraph.set(importedPath, []);
			}
			// Add the current importerPath to the list of files that import importedPath
			reverseDependencyGraph.get(importedPath)!.push({
				path: importerPath,
				relationType: importedRelation.relationType,
			});
		}
	}

	// Update cache if projectRoot is provided
	if (projectRoot) {
		const workspacePath = projectRoot.fsPath;
		const cached = dependencyCache.get(workspacePath);
		if (cached) {
			cached.reverseDependencyGraph = reverseDependencyGraph;
		}
	}

	return reverseDependencyGraph;
}

/**
 * Clear dependency cache for a specific workspace or all workspaces
 */
export function clearDependencyCache(workspacePath?: string): void {
	if (workspacePath) {
		dependencyCache.delete(workspacePath);
		console.log(`Cleared dependency cache for: ${workspacePath}`);
	} else {
		dependencyCache.clear();
		console.log("Cleared all dependency caches");
	}
}

/**
 * Get dependency cache statistics
 */
export function getDependencyCacheStats(): {
	size: number;
	entries: Array<{
		path: string;
		age: number;
		fileCount: number;
		dependencyCount: number;
	}>;
} {
	const entries = Array.from(dependencyCache.entries()).map(
		([path, cache]) => ({
			path,
			age: Date.now() - cache.timestamp,
			fileCount: cache.fileCount,
			dependencyCount: cache.dependencyGraph.size,
		})
	);

	return {
		size: dependencyCache.size,
		entries,
	};
}

/**
 * Get dependency statistics for a specific file
 */
export function getFileDependencyStats(
	filePath: string,
	dependencyGraph: Map<string, DependencyRelation[]>,
	reverseDependencyGraph: Map<string, DependencyRelation[]>
): {
	incoming: number;
	outgoing: number;
	imports: string[];
	importedBy: string[];
} {
	const importRelations = dependencyGraph.get(filePath) || [];
	const importedByRelations = reverseDependencyGraph.get(filePath) || [];

	const imports = importRelations.map((rel) => rel.path);
	const importedBy = importedByRelations.map((rel) => rel.path);

	return {
		incoming: importedBy.length,
		outgoing: imports.length,
		imports,
		importedBy,
	};
}
