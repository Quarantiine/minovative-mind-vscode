// src/context/workspaceScanner.ts
import * as vscode from "vscode";
import BPromise from "bluebird"; // using bluebird map for concurrency control
import * as path from "path";
import { loadGitIgnoreMatcher } from "../utils/ignoreUtils";
import { DEFAULT_SIZE } from "../sidebar/common/sidebarConstants";
import { SUPPORTED_CODE_EXTENSIONS } from "../utils/languageUtils";

// Interface for scan options (can be expanded later for settings)
interface ScanOptions {
	respectGitIgnore?: boolean;
	additionalIgnorePatterns?: string[];
	maxConcurrentReads?: number; // Optional concurrency limit
	maxConcurrency?: number; // Alternative name for maxConcurrentReads
	fileTypeFilter?: string[]; // Filter by file extensions
	maxFileSize?: number; // Skip files larger than this (in bytes)
	useCache?: boolean; // Enable caching of scan results
	cacheTimeout?: number; // Cache timeout in milliseconds
}

// Cache interface for scan results
interface ScanCache {
	timestamp: number;
	files: vscode.Uri[];
	workspacePath: string;
}

// File type patterns for better filtering (default fallback)
// Now using the centralized list from languageUtils, but formatted with dot prefix
const RELEVANT_FILE_EXTENSIONS = SUPPORTED_CODE_EXTENSIONS.map(
	(ext) => `.${ext}`,
).concat([
	// Add specific filenames that are important but not covered by simple extensions
	"package.json",
	"tsconfig.json",
	"webpack.config.js",
	"vite.config.js",
	"rollup.config.js",
	"jest.config.js",
	"Dockerfile",
	"docker-compose.yml",
	"docker-compose.yaml",
	".gitignore",
	".eslintrc",
	".prettierrc",
	"README.md",
	"CHANGELOG.md",
	"LICENSE",
	"CONTRIBUTING.md",
]);

// Cache storage
const scanCache = new Map<string, ScanCache>();

/**
 * Scans the workspace for relevant files, respecting .gitignore and default excludes.
 * Now includes caching, better file filtering, and performance optimizations.
 *
 * @param options Optional configuration for the scan.
 * @returns A promise that resolves to an array of vscode.Uri objects representing relevant files.
 */
export async function scanWorkspace(
	options?: ScanOptions,
): Promise<vscode.Uri[]> {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders || workspaceFolders.length === 0) {
		console.warn("No workspace folder open.");
		return [];
	}

	// For simplicity, let's focus on the first workspace folder for now.
	// Multi-root workspaces can be handled later by iterating through workspaceFolders.
	const rootFolder = workspaceFolders[0];
	const workspacePath = rootFolder.uri.fsPath;

	// Check cache first
	const useCache = options?.useCache ?? true;

	const cacheTimeout = options?.cacheTimeout ?? 5 * 60 * 1000; // 5 minutes default

	if (useCache) {
		const cached = scanCache.get(workspacePath);
		if (cached && Date.now() - cached.timestamp < cacheTimeout) {
			console.log(`Using cached scan results for: ${workspacePath}`);
			return cached.files;
		}
	}

	const relevantFiles: vscode.Uri[] = [];

	// Load gitignore rules and default patterns using the utility function
	const ig = await loadGitIgnoreMatcher(rootFolder.uri);

	// custom ignore patterns from options
	if (options?.additionalIgnorePatterns) {
		ig.add(options.additionalIgnorePatterns);
	}

	// Define concurrency. Tune to 15 (was 10) to align with common usage in ContextService.
	const concurrency = options?.maxConcurrentReads ?? 15;
	const maxFileSize = options?.maxFileSize ?? DEFAULT_SIZE;

	// Make RELEVANT_FILE_EXTENSIONS configurable via VS Code settings
	const config = vscode.workspace.getConfiguration(
		"minovativeMind.workspaceScanner",
	);
	const userDefinedFileExtensions = config.get<string[]>(
		"relevantFileExtensions",
	);

	// Use user-defined extensions from settings, fallback to options filter, then to hardcoded default
	const fileTypeFilter =
		options?.fileTypeFilter ??
		userDefinedFileExtensions ??
		RELEVANT_FILE_EXTENSIONS;

	/**
	 * Check if a file's name or extension matches the filter.
	 * This is applied early to minimize I/O.
	 */
	function passesNameAndExtensionFilter(filePath: string): boolean {
		const ext = path.extname(filePath).toLowerCase();
		const fileName = path.basename(filePath).toLowerCase();

		return fileTypeFilter.some((pattern) => {
			if (pattern.startsWith(".")) {
				return ext === pattern;
			}
			return fileName === pattern;
		});
	}

	/**
	 * Check if a file's size is within the allowed limit.
	 * This is applied after initial name/extension filter and stat call.
	 */
	function passesSizeFilter(fileSize: number): boolean {
		return fileSize <= maxFileSize;
	}

	/**
	 * Recursively scans a directory.
	 * Uses Bluebird's map for controlled concurrency when reading subdirectories.
	 * Now includes better error handling and performance optimizations.
	 */
	async function _scanDir(dirUri: vscode.Uri): Promise<void> {
		try {
			const entries = await vscode.workspace.fs.readDirectory(dirUri);

			// Pre-filter entries to reduce processing
			const relevantEntries = entries.filter(([name, type]) => {
				const fullPath = path.join(dirUri.fsPath, name);
				const relativePath = path.relative(workspacePath, fullPath);

				// Skip ignored paths early (minimize I/O)
				if (
					ig.ignores(relativePath) ||
					(type === vscode.FileType.Directory && ig.ignores(relativePath + "/"))
				) {
					return false;
				}

				// For files, apply name/extension filter immediately (minimize I/O)
				if (type === vscode.FileType.File) {
					return passesNameAndExtensionFilter(relativePath);
				}

				return true; // Include directories for further scanning
			});

			// Use Bluebird map for concurrent processing of directory entries
			await BPromise.map(
				relevantEntries,
				async ([name, type]) => {
					const fullUri = vscode.Uri.joinPath(dirUri, name);

					if (type === vscode.FileType.File) {
						// Check file size before adding. This is done after initial filtering.
						try {
							const stat = await vscode.workspace.fs.stat(fullUri);
							if (passesSizeFilter(stat.size)) {
								relevantFiles.push(fullUri);
							}
						} catch (statError) {
							// If we can't get file size (e.g., file disappeared, permission denied), skip it.
							console.warn(`Could not stat file ${fullUri.fsPath}, skipping.`);
						}
					} else if (type === vscode.FileType.Directory) {
						// Recursively scan subdirectories
						await _scanDir(fullUri);
					}
					// Ignore symlinks and other types for now
				},
				{ concurrency: concurrency },
			);
		} catch (error) {
			console.error(`Error reading directory ${dirUri.fsPath}:`, error);
		}
	}

	console.log(`Starting optimized workspace scan in: ${workspacePath}`);
	const startTime = Date.now();

	await _scanDir(rootFolder.uri); // Start the scan from the root

	const scanTime = Date.now() - startTime;
	console.log(
		`Workspace scan finished in ${scanTime}ms. Found ${relevantFiles.length} relevant files.`,
	);

	// Cache the results
	if (useCache) {
		scanCache.set(workspacePath, {
			timestamp: Date.now(),
			files: relevantFiles,
			workspacePath,
		});
	}

	console.log(
		`[WorkspaceScanner] Final scan results: Found ${relevantFiles.length} relevant files in ${rootFolder.uri.fsPath}.`,
	);
	return relevantFiles;
}

/**
 * Clear scan cache for a specific workspace or all workspaces
 */
export function clearScanCache(workspacePath?: string): void {
	if (workspacePath) {
		scanCache.delete(workspacePath);
		console.log(`Cleared scan cache for: ${workspacePath}`);
	} else {
		scanCache.clear();
		console.log("Cleared all scan caches");
	}
}

/**
 * Get cache statistics
 */
export function getScanCacheStats(): {
	size: number;
	entries: Array<{ path: string; age: number }>;
} {
	const entries = Array.from(scanCache.entries()).map(([path, cache]) => ({
		path,
		age: Date.now() - cache.timestamp,
	}));

	return {
		size: scanCache.size,
		entries,
	};
}
