import * as vscode from "vscode";
import * as path from "path";
import { AIRequestService } from "../services/aiRequestService";
import { DEFAULT_FLASH_LITE_MODEL } from "../sidebar/common/sidebarConstants";
import {
	Tool,
	SchemaType,
	FunctionCallingMode,
	Content,
} from "@google/generative-ai";

/**
 * Represents an inferred relationship between two files
 * that are likely coupled but have no direct import dependency.
 */
export interface InferredRelationship {
	/** The file that triggered the inference */
	sourceFile: string;
	/** The file discovered through inference */
	relatedFile: string;
	/** Human-readable explanation of why these files are related */
	reason: string;
	/** Confidence score from 0 to 1 */
	confidence: number;
}

/**
 * AI-classified file name decomposition.
 */
interface FileNameClassification {
	/** The domain/core name (e.g., "User", "Login", "Auth") */
	coreName: string;
	/** The architectural role (e.g., "Service", "Controller", "Component") */
	architecturalRole: string;
	/** The original full file name */
	originalName: string;
}

/**
 * Tool definition for AI-powered file name classification.
 * The AI decomposes file names into {coreName, architecturalRole} pairs
 * instead of relying on a giant regex of known suffixes.
 */
const FILE_NAME_CLASSIFICATION_TOOL: Tool = {
	functionDeclarations: [
		{
			name: "classifyFileNames",
			description:
				"Decomposes a list of file names (without extensions) into their core domain name and " +
				"architectural role. For example: 'UserService' → {coreName: 'User', architecturalRole: 'Service'}, " +
				"'LoginController' → {coreName: 'Login', architecturalRole: 'Controller'}. " +
				"Only classify names that clearly follow a domain+role pattern. Skip generic names " +
				"like 'index', 'main', 'utils', 'helpers', 'constants', or single-word names without a clear role.",
			parameters: {
				type: SchemaType.OBJECT,
				properties: {
					classifications: {
						type: SchemaType.ARRAY,
						description:
							"Array of classified file names. Only include names that have a clear domain+role decomposition.",
						items: {
							type: SchemaType.OBJECT,
							properties: {
								originalName: {
									type: SchemaType.STRING,
									description: "The original file name as provided",
								},
								coreName: {
									type: SchemaType.STRING,
									description:
										"The domain/entity portion of the name (e.g., 'User' from 'UserService', 'Auth' from 'AuthMiddleware')",
								},
								architecturalRole: {
									type: SchemaType.STRING,
									description:
										"The architectural role suffix (e.g., 'Service', 'Controller', 'Component', 'Page', 'Model', 'Hook', 'Store', 'Guard', 'Pipe', 'Subscriber', etc.)",
								},
							},
							required: ["originalName", "coreName", "architecturalRole"],
						},
					},
				},
				required: ["classifications"],
			},
		},
	],
};

/**
 * Uses AI (DEFAULT_FLASH_LITE_MODEL) with function calling to classify
 * file names into {coreName, architecturalRole} pairs.
 * This replaces the massive regex of known architectural suffixes.
 */
async function classifyFileNamesViaAI(
	fileNames: string[],
	aiRequestService: AIRequestService,
	cancellationToken?: vscode.CancellationToken,
): Promise<FileNameClassification[]> {
	const apiKey = aiRequestService.getActiveApiKey();
	if (!apiKey) {
		console.warn(
			"[CrossFileInference] No API key for file name classification.",
		);
		return [];
	}

	// Batch file names to keep prompt small — cap at 100
	const batch = fileNames.slice(0, 100);

	const contents: Content[] = [
		{
			role: "user",
			parts: [
				{
					text: `Classify each of the following file names (without extensions) into their domain core name and architectural role.\n\nFile names:\n${batch.map((n) => `- ${n}`).join("\n")}`,
				},
			],
		},
	];

	try {
		const result = await aiRequestService.generateFunctionCall(
			apiKey,
			DEFAULT_FLASH_LITE_MODEL,
			contents,
			[FILE_NAME_CLASSIFICATION_TOOL],
			FunctionCallingMode.ANY,
			"You are a precise file name classifier for software projects. Decompose file names into domain core name + architectural role. Only classify names that clearly follow a pattern. Be accurate, not creative.",
			undefined,
			cancellationToken,
			"file_name_classification",
		);

		if (result?.functionCall?.args) {
			const args = result.functionCall.args as any;
			if (Array.isArray(args.classifications)) {
				return args.classifications
					.filter(
						(c: any) =>
							typeof c.originalName === "string" &&
							typeof c.coreName === "string" &&
							typeof c.architecturalRole === "string",
					)
					.map((c: any) => ({
						originalName: c.originalName,
						coreName: c.coreName,
						architecturalRole: c.architecturalRole,
					}));
			}
		}
	} catch (error) {
		console.warn(
			"[CrossFileInference] AI file name classification failed:",
			error,
		);
	}

	return [];
}

/**
 * Discovers files that are *indirectly* related through naming patterns,
 * directory structure, domain coupling, and architectural roles.
 *
 * Uses AI-powered file name classification (via DEFAULT_FLASH_LITE_MODEL)
 * for naming pattern sibling detection (Rule 2), replacing the old regex approach.
 * Other rules remain fast and rules-based.
 *
 * @param targetFiles - Files already selected as priority
 * @param allFiles - All workspace files
 * @param projectRoot - Workspace root URI
 * @param searchKeywords - Keywords from intent decomposition
 * @param aiRequestService - Optional AI service for file name classification
 * @param cancellationToken - Optional cancellation token
 */
export async function inferCrossFileRelationships(
	targetFiles: vscode.Uri[],
	allFiles: readonly vscode.Uri[],
	projectRoot: vscode.Uri,
	searchKeywords?: string[],
	aiRequestService?: AIRequestService,
	cancellationToken?: vscode.CancellationToken,
): Promise<InferredRelationship[]> {
	// Cost guard: skip entirely if nothing to work with
	if (
		(!targetFiles || targetFiles.length === 0) &&
		(!searchKeywords || searchKeywords.length === 0)
	) {
		return [];
	}

	const inferred: InferredRelationship[] = [];
	const allRelativePaths = allFiles.map((uri) =>
		path.relative(projectRoot.fsPath, uri.fsPath).replace(/\\/g, "/"),
	);
	const allRelativeSet = new Set(allRelativePaths);
	const alreadySelected = new Set(
		targetFiles.map((uri) =>
			path.relative(projectRoot.fsPath, uri.fsPath).replace(/\\/g, "/"),
		),
	);

	for (const targetUri of targetFiles) {
		const targetRelative = path
			.relative(projectRoot.fsPath, targetUri.fsPath)
			.replace(/\\/g, "/");
		const targetBasename = path.basename(targetRelative);
		const targetDir = path.dirname(targetRelative);
		const targetExt = path.extname(targetBasename);
		const targetName = path.basename(targetBasename, targetExt);

		// --- Rule 1: Test file pairing ---
		// foo.ts → foo.test.ts, foo.spec.ts, __tests__/foo.ts, __tests__/foo.test.ts
		const testPatterns = [
			`${targetDir}/${targetName}.test${targetExt}`,
			`${targetDir}/${targetName}.spec${targetExt}`,
			`${targetDir}/__tests__/${targetName}${targetExt}`,
			`${targetDir}/__tests__/${targetName}.test${targetExt}`,
			`${targetDir}/__tests__/${targetName}.spec${targetExt}`,
			// Common test directory at project root
			`tests/${targetRelative}`,
			`test/${targetRelative}`,
		];

		for (const testPath of testPatterns) {
			const normalized = testPath.replace(/^\.\//, "");
			if (allRelativeSet.has(normalized) && !alreadySelected.has(normalized)) {
				inferred.push({
					sourceFile: targetRelative,
					relatedFile: normalized,
					reason: `Test file for ${targetBasename}`,
					confidence: 0.9,
				});
			}
		}

		// --- Rule 3: Feature folder expansion ---
		// If a file is inside a feature folder (e.g., features/login/api.ts),
		// include other files in the same feature folder
		const featureFolderMatch = targetDir.match(
			/(?:features?|modules?|pages?|views?|screens?|components?)\/([^/]+)/i,
		);
		if (featureFolderMatch) {
			const featurePrefix = targetDir.substring(
				0,
				targetDir.indexOf(featureFolderMatch[0]) + featureFolderMatch[0].length,
			);
			for (const relativePath of allRelativePaths) {
				if (
					relativePath.startsWith(featurePrefix + "/") &&
					relativePath !== targetRelative &&
					!alreadySelected.has(relativePath)
				) {
					inferred.push({
						sourceFile: targetRelative,
						relatedFile: relativePath,
						reason: `Same feature folder: ${featureFolderMatch[0]}`,
						confidence: 0.7,
					});
				}
			}
		}

		// --- Rule 4: Index/barrel file inclusion ---
		// If a file is in a directory that has an index.ts, include it
		const indexPatterns = [
			`${targetDir}/index.ts`,
			`${targetDir}/index.tsx`,
			`${targetDir}/index.js`,
			`${targetDir}/index.jsx`,
		];
		for (const indexPath of indexPatterns) {
			const normalized = indexPath.replace(/^\.\//, "");
			if (
				allRelativeSet.has(normalized) &&
				!alreadySelected.has(normalized) &&
				normalized !== targetRelative
			) {
				inferred.push({
					sourceFile: targetRelative,
					relatedFile: normalized,
					reason: `Barrel/index file for ${targetDir}`,
					confidence: 0.6,
				});
			}
		}
	}

	// --- Rule 2: AI-powered naming pattern siblings ---
	// COST OPTIMIZATION: Only classify TARGET file names via AI (typically 5-15),
	// then do a lightweight string scan of all workspace file names to find siblings.
	// This avoids sending hundreds of file names to the AI.
	if (aiRequestService && targetFiles.length > 0) {
		// Collect target file names only
		const targetNameMap = new Map<string, string>(); // name → relativePath
		for (const targetUri of targetFiles) {
			const rel = path
				.relative(projectRoot.fsPath, targetUri.fsPath)
				.replace(/\\/g, "/");
			const ext = path.extname(path.basename(rel));
			const name = path.basename(rel, ext);
			// Only classify names that look like they could have a domain+role pattern
			if (name.length >= 4 && name !== "index" && name !== "main") {
				targetNameMap.set(name, rel);
			}
		}

		if (targetNameMap.size > 0) {
			// Only send TARGET names to AI — this is the expensive call, keep it small
			const classifications = await classifyFileNamesViaAI(
				Array.from(targetNameMap.keys()),
				aiRequestService,
				cancellationToken,
			);

			// For each classified target, do a lightweight string scan of all file names
			// to find siblings with the same core name — NO AI call needed for this
			for (const cls of classifications) {
				const targetPath = targetNameMap.get(cls.originalName);
				if (!targetPath) continue;

				const coreNameLower = cls.coreName.toLowerCase();

				for (const relativePath of allRelativePaths) {
					if (alreadySelected.has(relativePath)) continue;
					const otherBasename = path.basename(relativePath);
					const otherExt = path.extname(otherBasename);
					const otherName = path.basename(otherBasename, otherExt);
					const otherNameLower = otherName.toLowerCase();

					// Quick string check: does this file name start with the classified core name?
					// e.g., core="User" → matches "UserController", "UserModel", "userService"
					if (
						otherNameLower !== cls.originalName.toLowerCase() &&
						otherNameLower.startsWith(coreNameLower) &&
						otherNameLower.length > coreNameLower.length
					) {
						const alreadyInferred = inferred.some(
							(r) => r.relatedFile === relativePath,
						);
						if (!alreadyInferred) {
							inferred.push({
								sourceFile: targetPath,
								relatedFile: relativePath,
								reason: `Shared domain "${cls.coreName}" (${cls.architecturalRole}): ${cls.originalName} ↔ ${otherName}`,
								confidence: 0.8,
							});
						}
					}
				}
			}
		}
	}

	// --- Rule 5: Keyword-based file discovery ---
	// If the intent decomposer provided search keywords, find files whose
	// names contain those keywords (even if they share no imports with selected files)
	if (searchKeywords && searchKeywords.length > 0) {
		for (const keyword of searchKeywords) {
			if (keyword.length < 3) continue; // Skip very short keywords
			const lowerKeyword = keyword.toLowerCase();
			for (const relativePath of allRelativePaths) {
				if (alreadySelected.has(relativePath)) continue;
				const lowerBasename = path.basename(relativePath).toLowerCase();

				// Match filename (not full path) to avoid false positives from directory names
				if (lowerBasename.includes(lowerKeyword)) {
					// Check it's not already inferred
					const alreadyInferred = inferred.some(
						(r) => r.relatedFile === relativePath,
					);
					if (!alreadyInferred) {
						inferred.push({
							sourceFile: "(keyword search)",
							relatedFile: relativePath,
							reason: `Filename matches search keyword "${keyword}"`,
							confidence: 0.65,
						});
					}
				}
			}
		}
	}

	// Deduplicate by relatedFile, keeping highest confidence
	const deduped = new Map<string, InferredRelationship>();
	for (const rel of inferred) {
		const existing = deduped.get(rel.relatedFile);
		if (!existing || existing.confidence < rel.confidence) {
			deduped.set(rel.relatedFile, rel);
		}
	}

	// Sort by confidence descending and cap at 30 results
	return Array.from(deduped.values())
		.sort((a, b) => b.confidence - a.confidence)
		.slice(0, 30);
}

/**
 * Formats inferred relationships into a prompt-friendly string.
 */
export function formatInferredRelationshipsForPrompt(
	relationships: InferredRelationship[],
): string {
	if (relationships.length === 0) {
		return "";
	}

	const lines: string[] = [
		"--- Inferred Related Files (Naming/Structure Analysis) ---",
	];
	lines.push(
		"The following files were identified through naming patterns, feature folders, and structural analysis. Consider investigating them:",
	);

	// Group by confidence tier
	const highConf = relationships.filter((r) => r.confidence >= 0.8);
	const medConf = relationships.filter(
		(r) => r.confidence >= 0.6 && r.confidence < 0.8,
	);

	if (highConf.length > 0) {
		lines.push("**Highly Likely Related:**");
		for (const rel of highConf.slice(0, 10)) {
			lines.push(`  - "${rel.relatedFile}" — ${rel.reason}`);
		}
	}

	if (medConf.length > 0) {
		lines.push("**Possibly Related:**");
		for (const rel of medConf.slice(0, 10)) {
			lines.push(`  - "${rel.relatedFile}" — ${rel.reason}`);
		}
	}

	lines.push("--- End Inferred Related Files ---");

	return lines.join("\n");
}
