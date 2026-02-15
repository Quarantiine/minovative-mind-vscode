import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

/**
 * Summary of project configuration for Context Agent.
 * Contains only the most relevant details to help AI understand the project.
 */
export interface ProjectConfigContext {
	projectName?: string;
	scripts?: Record<string, string>;
	keyDependencies?: string[];
	devDependencies?: string[];
	tsConfig?: {
		paths?: Record<string, string[]>;
		baseUrl?: string;
		target?: string;
		module?: string;
	};
	frameworkHints?: string[];
	engines?: Record<string, string>;
}

// Cache for config context
const configContextCache = new Map<
	string,
	{ timestamp: number; context: ProjectConfigContext }
>();
const CACHE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Gathers project configuration context from common config files.
 * Returns a compact summary suitable for including in AI prompts.
 */
export async function gatherProjectConfigContext(
	workspaceRoot: vscode.Uri,
): Promise<ProjectConfigContext> {
	const workspacePath = workspaceRoot.fsPath;

	// Check cache
	const cached = configContextCache.get(workspacePath);
	if (cached && Date.now() - cached.timestamp < CACHE_TIMEOUT_MS) {
		console.log("[ConfigContextProvider] Using cached config context");
		return cached.context;
	}

	const context: ProjectConfigContext = {};
	const frameworkHints: string[] = [];

	// 1. Parse package.json
	const packageJsonPath = path.join(workspacePath, "package.json");
	if (fs.existsSync(packageJsonPath)) {
		try {
			const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));

			context.projectName = packageJson.name;
			context.scripts = packageJson.scripts;
			context.engines = packageJson.engines;

			// Extract key dependencies (top 15 by importance)
			const deps = packageJson.dependencies || {};
			const devDeps = packageJson.devDependencies || {};

			// Prioritize framework/core dependencies
			const priorityPatterns = [
				/^react/,
				/^next/,
				/^vue/,
				/^angular/,
				/^svelte/,
				/^express/,
				/^fastify/,
				/^@google/,
				/^vscode/,
				/^typescript/,
				/^@types/,
			];

			const sortByPriority = (depList: string[]) => {
				return depList.sort((a, b) => {
					const aScore = priorityPatterns.findIndex((p) => p.test(a));
					const bScore = priorityPatterns.findIndex((p) => p.test(b));
					// -1 means not found, put at end
					if (aScore === -1 && bScore === -1) {
						return a.localeCompare(b);
					}
					if (aScore === -1) {
						return 1;
					}
					if (bScore === -1) {
						return -1;
					}
					return aScore - bScore;
				});
			};

			context.keyDependencies = sortByPriority(Object.keys(deps)).slice(0, 15);
			context.devDependencies = sortByPriority(Object.keys(devDeps)).slice(
				0,
				10,
			);

			// Detect frameworks
			if (deps["next"] || devDeps["next"]) {
				frameworkHints.push(`Next.js ${deps["next"] || devDeps["next"]}`);
			}
			if (deps["react"] || devDeps["react"]) {
				frameworkHints.push(`React ${deps["react"] || devDeps["react"]}`);
			}
			if (deps["vue"] || devDeps["vue"]) {
				frameworkHints.push(`Vue ${deps["vue"] || devDeps["vue"]}`);
			}
			if (deps["express"]) {
				frameworkHints.push(`Express ${deps["express"]}`);
			}
			if (deps["vscode"] || devDeps["@types/vscode"]) {
				frameworkHints.push("VS Code Extension");
			}
			if (deps["electron"] || devDeps["electron"]) {
				frameworkHints.push("Electron");
			}
			if (deps["tailwindcss"] || devDeps["tailwindcss"]) {
				frameworkHints.push("Tailwind CSS");
			}
			if (deps["jest"] || devDeps["jest"]) {
				frameworkHints.push("Jest");
			}
			if (deps["eslint"] || devDeps["eslint"]) {
				frameworkHints.push("ESLint");
			}
			if (deps["prettier"] || devDeps["prettier"]) {
				frameworkHints.push("Prettier");
			}
		} catch (e) {
			console.warn(
				`[ConfigContextProvider] Failed to parse package.json: ${
					(e as Error).message
				}`,
			);
		}
	}

	// 2. Parse tsconfig.json
	const tsconfigPath = path.join(workspacePath, "tsconfig.json");
	if (fs.existsSync(tsconfigPath)) {
		try {
			// Read with comment stripping (tsconfig often has comments)
			const tsconfigRaw = fs.readFileSync(tsconfigPath, "utf-8");
			const tsconfigClean = tsconfigRaw
				.replace(/\/\/.*$/gm, "") // Remove single-line comments
				.replace(/\/\*[\s\S]*?\*\//g, ""); // Remove multi-line comments
			const tsconfig = JSON.parse(tsconfigClean);

			const compilerOptions = tsconfig.compilerOptions || {};
			context.tsConfig = {};

			if (compilerOptions.paths) {
				context.tsConfig.paths = compilerOptions.paths;
			}
			if (compilerOptions.baseUrl) {
				context.tsConfig.baseUrl = compilerOptions.baseUrl;
			}
			if (compilerOptions.target) {
				context.tsConfig.target = compilerOptions.target;
			}
			if (compilerOptions.module) {
				context.tsConfig.module = compilerOptions.module;
			}
		} catch (e) {
			console.warn(
				`[ConfigContextProvider] Failed to parse tsconfig.json: ${
					(e as Error).message
				}`,
			);
		}
	}

	// 3. Detect other framework configs
	const viteConfigExists =
		fs.existsSync(path.join(workspacePath, "vite.config.ts")) ||
		fs.existsSync(path.join(workspacePath, "vite.config.js"));
	if (viteConfigExists) {
		frameworkHints.push("Vite");
	}

	const nextConfigExists =
		fs.existsSync(path.join(workspacePath, "next.config.js")) ||
		fs.existsSync(path.join(workspacePath, "next.config.mjs"));
	if (nextConfigExists && !frameworkHints.some((h) => h.startsWith("Next"))) {
		frameworkHints.push("Next.js");
	}

	const dockerfileExists = fs.existsSync(
		path.join(workspacePath, "Dockerfile"),
	);
	if (dockerfileExists) {
		frameworkHints.push("Docker");
	}

	if (frameworkHints.length > 0) {
		context.frameworkHints = frameworkHints;
	}

	// Cache the result
	configContextCache.set(workspacePath, {
		timestamp: Date.now(),
		context,
	});

	console.log(
		`[ConfigContextProvider] Gathered config context for ${
			context.projectName || "project"
		}`,
	);
	return context;
}

/**
 * Formats the project config context into a prompt-friendly string.
 */
export function formatProjectConfigForPrompt(
	config: ProjectConfigContext,
): string {
	if (!config || Object.keys(config).length === 0) {
		return "";
	}

	const lines: string[] = ["--- Project Configuration ---"];

	if (config.projectName) {
		lines.push(`Project: ${config.projectName}`);
	}

	if (config.frameworkHints && config.frameworkHints.length > 0) {
		lines.push(`Framework: ${config.frameworkHints.join(", ")}`);
	}

	if (config.engines && Object.keys(config.engines).length > 0) {
		const enginesInfo = Object.entries(config.engines)
			.map(([engine, version]) => `${engine}: ${version}`)
			.join(", ");
		lines.push(`Engines: ${enginesInfo}`);
	}

	if (config.scripts && Object.keys(config.scripts).length > 0) {
		const scriptNames = Object.keys(config.scripts).slice(0, 8).join(", ");
		lines.push(`Scripts: ${scriptNames}`);
	}

	if (config.keyDependencies && config.keyDependencies.length > 0) {
		lines.push(`Key Dependencies: ${config.keyDependencies.join(", ")}`);
	}

	if (config.tsConfig) {
		const tsInfo: string[] = [];
		if (config.tsConfig.baseUrl) {
			tsInfo.push(`baseUrl: ${config.tsConfig.baseUrl}`);
		}
		if (config.tsConfig.paths) {
			const pathMappings = Object.entries(config.tsConfig.paths)
				.slice(0, 3)
				.map(([alias, targets]) => `${alias} → ${targets[0]}`)
				.join("; ");
			if (pathMappings) {
				tsInfo.push(`paths: ${pathMappings}`);
			}
		}
		if (tsInfo.length > 0) {
			lines.push(`TypeScript: ${tsInfo.join(", ")}`);
		}
	}

	lines.push("--- End Project Configuration ---");

	return lines.join("\n");
}

/**
 * Clear the config context cache.
 */
export function clearConfigContextCache(workspacePath?: string): void {
	if (workspacePath) {
		configContextCache.delete(workspacePath);
	} else {
		configContextCache.clear();
	}
	console.log("[ConfigContextProvider] Cache cleared");
}
