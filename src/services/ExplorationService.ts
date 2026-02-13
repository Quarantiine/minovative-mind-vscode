import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs/promises";
import { SidebarProvider } from "../sidebar/SidebarProvider";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export interface ExplorationOptions {
	maxDepth?: number;
	exclude?: string[];
}

export interface SearchResult {
	file: string;
	line: number;
	text: string;
}

export class ExplorationService {
	private readonly projectRoot: vscode.Uri;
	private readonly extensionContext: vscode.ExtensionContext;
	private _abortController: AbortController | null = null;

	constructor(
		provider: SidebarProvider,
		context: vscode.ExtensionContext,
		projectRoot: vscode.Uri,
	) {
		this.extensionContext = context;
		this.projectRoot = projectRoot;
	}

	/**
	 * Cancels any ongoing exploration task.
	 */
	public cancelOptions() {
		if (this._abortController) {
			this._abortController.abort();
			this._abortController = null;
		}
	}

	private getSignal(): AbortSignal {
		this.cancelOptions();
		this._abortController = new AbortController();
		return this._abortController.signal;
	}

	/**
	 * Scans the workspace to understand the project structure.
	 * ZERO-INSTALL: Uses strictly Node.js fs/path.
	 */
	public async scanWorkspace(
		strategy: "shallow" | "deep",
		signal?: AbortSignal,
	): Promise<string[]> {
		const actualSignal = signal || this.getSignal();
		if (actualSignal.aborted) throw new Error("Operation cancelled");

		const depth = strategy === "shallow" ? 2 : 5;
		const files: string[] = [];

		await this.traverseDirectory(
			this.projectRoot.fsPath,
			depth,
			files,
			actualSignal,
		);
		return files;
	}

	private async traverseDirectory(
		dir: string,
		depth: number,
		results: string[],
		signal: AbortSignal,
	): Promise<void> {
		if (depth < 0 || signal.aborted) return;

		try {
			const entries = await fs.readdir(dir, { withFileTypes: true });

			for (const entry of entries) {
				if (signal.aborted) return;

				const fullPath = path.join(dir, entry.name);

				// Basic ignore list - can be improved based on .gitignore later
				if (
					entry.name.startsWith(".") ||
					entry.name === "node_modules" ||
					entry.name === "dist" ||
					entry.name === "out"
				) {
					continue;
				}

				if (entry.isDirectory()) {
					await this.traverseDirectory(fullPath, depth - 1, results, signal);
				} else {
					results.push(path.relative(this.projectRoot.fsPath, fullPath));
				}
			}
		} catch (error) {
			// Ignore access errors
		}
	}

	/**
	 * Wrapper for text search.
	 * Tries to use 'rg' if available (fastest), falls back to simplistic Node search if not.
	 */
	public async searchCodebase(
		query: string,
		signal?: AbortSignal,
	): Promise<SearchResult[]> {
		const actualSignal = signal || this.getSignal();

		try {
			// Try Ripgrep first
			return await this.runRipgrep(query, actualSignal);
		} catch (error) {
			console.warn(
				"Ripgrep failed or not found, falling back to Node.js search",
				error,
			);
			return await this.runNodeSearch(query, actualSignal);
		}
	}

	private async runRipgrep(
		query: string,
		signal: AbortSignal,
	): Promise<SearchResult[]> {
		// This assumes rg is in path.
		// In a real extension, we might bundle fs-ripgrep or use vscode.findTextInFiles (which is complex to call from here).
		// For now, we try to spawn 'rg'.

		if (signal.aborted) throw new Error("Operation cancelled");

		try {
			const { stdout } = await execAsync(`rg -n "${query}" .`, {
				cwd: this.projectRoot.fsPath,
				maxBuffer: 1024 * 1024,
				signal, // Node 14+ supports signal in exec
			});

			const lines = stdout.split("\n");
			const results: SearchResult[] = [];

			for (const line of lines) {
				if (!line) continue;
				// rg -n output: file:line:text
				const parts = line.split(":");
				if (parts.length >= 3) {
					const file = parts[0];
					const lineNumber = parseInt(parts[1], 10);
					const text = parts.slice(2).join(":");
					results.push({ file, line: lineNumber, text });
				}
			}
			return results;
		} catch (e: any) {
			if (e.name === "AbortError") throw new Error("Operation cancelled");
			throw e;
		}
	}

	private async runNodeSearch(
		query: string,
		signal: AbortSignal,
	): Promise<SearchResult[]> {
		// Fallback: Read files and match string. Slow but works everywhere.
		const allFiles = await this.scanWorkspace("deep", signal);
		const results: SearchResult[] = [];

		for (const relativePath of allFiles) {
			if (signal.aborted) break;

			const fileUri = vscode.Uri.joinPath(this.projectRoot, relativePath);
			try {
				const content = await fs.readFile(fileUri.fsPath, "utf8");
				const lines = content.split("\n");
				for (let i = 0; i < lines.length; i++) {
					if (lines[i].includes(query)) {
						results.push({
							file: relativePath,
							line: i + 1,
							text: lines[i].trim(),
						});
						// Limit results per file to avoid spam locally
						if (results.length > 500) break;
					}
				}
			} catch (ignore) {
				// Binary files etc.
			}
		}
		return results;
	}

	/**
	 * Analyzes dependencies of a specific file using Regex (Language Agnostic-ish).
	 * Supports basic import patterns for JS/TS, Python, Ruby, Go, C#, PHP/Rust, C/C++, Java, etc.
	 */
	public async analyzeDependencies(
		filePath: string,
		signal?: AbortSignal,
	): Promise<string[]> {
		const actualSignal = signal || this.getSignal();
		if (actualSignal.aborted) throw new Error("Operation cancelled");

		const fileUri = vscode.Uri.joinPath(this.projectRoot, filePath);
		const content = await fs.readFile(fileUri.fsPath, "utf8");

		const dependencies: string[] = [];

		// Generic Import Patterns
		const patterns = [
			/import\s+.*?\s+from\s+['"](.*?)['"]/g, // JS/TS: import ... from "..."
			/import\s+['"](.*?)['"]/g, // JS/TS/Go: import "..."
			/require\(['"](.*?)['"]\)/g, // JS: require("...")
			/require(?:_relative)?\s+['"](.*?)['"]/g, // Ruby: require "..." or require_relative "..."
			/import\s+([^\s;]+)/g, // Python/Java/Kotlin/Swift: import ...
			/from\s+([^\s;]+)\s+import/g, // Python: from ... import
			/using\s+([^\s;]+);/g, // C#: using ...;
			/use\s+([^\s;]+)/g, // PHP/Rust: use ...
			/#include\s+[<"](.*)[>"]/g, // C/C++: #include ...
			/@import\s+['"](.*?)['"]/g, // CSS/SCSS: @import "..."
		];

		for (const pattern of patterns) {
			let match;
			while ((match = pattern.exec(content)) !== null) {
				if (match[1]) dependencies.push(match[1]);
			}
		}

		return [...new Set(dependencies)]; // De-duplicate
	}
}
