import * as vscode from "vscode";
import * as path from "path";
import { PlanGenerationContext } from "../sidebar/common/sidebarTypes";
import { AIRequestService } from "../services/aiRequestService";
import { DEFAULT_FLASH_LITE_MODEL } from "../sidebar/common/sidebarConstants";

// Scoring weights constants
const HIGH_RELEVANCE = 100;
const MEDIUM_RELEVANCE = 80;
const LOW_RELEVANCE = 50;
const ACTIVE_FILE_SCORE_BOOST = 200;

export interface HeuristicSelectionOptions {
	heuristicSelectionEnabled?: boolean;
	maxHeuristicFilesTotal: number;
	maxSameDirectoryFiles: number;
	maxDirectDependencies: number;
	maxReverseDependencies: number;
	maxCallHierarchyFiles: number;
	sameDirectoryWeight: number;
	runtimeDependencyWeight: number;
	typeDependencyWeight: number;
	conceptualProximityWeight: number;
	reverseDependencyWeight: number;
	callHierarchyWeight: number;
	definitionWeight: number;
	implementationWeight: number;
	typeDefinitionWeight: number;
	referencedTypeDefinitionWeight: number;
	generalSymbolRelatedBoost: number;
	dependencyWeight: number;
	directoryWeight: number;
	neighborDirectoryWeight: number;
	sharedAncestorWeight: number;
}

export async function getHeuristicRelevantFiles(
	allScannedFiles: ReadonlyArray<vscode.Uri>,
	projectRoot: vscode.Uri,
	activeEditorContext?: PlanGenerationContext["editorContext"],
	// Legacy params removed
	_unused1?: any,
	_unused2?: any,
	_unused3?: any,
	_unused4?: any,
	cancellationToken?: vscode.CancellationToken,
	options?: Partial<HeuristicSelectionOptions>,
	aiRequestService?: AIRequestService,
	userRequest?: string,
	modelName: string = DEFAULT_FLASH_LITE_MODEL,
): Promise<vscode.Uri[]> {
	const isHeuristicSelectionEnabled =
		options?.heuristicSelectionEnabled === true;

	if (!isHeuristicSelectionEnabled) {
		console.log(
			"[HeuristicContextSelector] Heuristic selection is not explicitly true. Skipping scoring.",
		);
		return [];
	}

	// Initialize effective options with provided options or default weights
	const effectiveOptions: HeuristicSelectionOptions = {
		heuristicSelectionEnabled: true,
		maxHeuristicFilesTotal: options?.maxHeuristicFilesTotal ?? 30,
		maxSameDirectoryFiles: options?.maxSameDirectoryFiles ?? 15,
		maxDirectDependencies: options?.maxDirectDependencies ?? 10,
		maxReverseDependencies: options?.maxReverseDependencies ?? 10,
		maxCallHierarchyFiles: options?.maxCallHierarchyFiles ?? 10,
		sameDirectoryWeight: options?.sameDirectoryWeight ?? LOW_RELEVANCE,
		runtimeDependencyWeight:
			options?.runtimeDependencyWeight ?? HIGH_RELEVANCE * 1.5,
		typeDependencyWeight: options?.typeDependencyWeight ?? MEDIUM_RELEVANCE,
		conceptualProximityWeight:
			options?.conceptualProximityWeight ?? LOW_RELEVANCE,
		reverseDependencyWeight:
			options?.reverseDependencyWeight ?? MEDIUM_RELEVANCE,
		callHierarchyWeight: options?.callHierarchyWeight ?? HIGH_RELEVANCE,
		definitionWeight: options?.definitionWeight ?? HIGH_RELEVANCE * 2, // Definition is often very important
		implementationWeight: options?.implementationWeight ?? HIGH_RELEVANCE,
		typeDefinitionWeight: options?.typeDefinitionWeight ?? HIGH_RELEVANCE,
		referencedTypeDefinitionWeight:
			options?.referencedTypeDefinitionWeight ?? MEDIUM_RELEVANCE,
		generalSymbolRelatedBoost:
			options?.generalSymbolRelatedBoost ?? MEDIUM_RELEVANCE,
		dependencyWeight: options?.dependencyWeight ?? MEDIUM_RELEVANCE,
		directoryWeight: options?.directoryWeight ?? LOW_RELEVANCE,
		neighborDirectoryWeight: options?.neighborDirectoryWeight ?? LOW_RELEVANCE, // New default value
		sharedAncestorWeight: options?.sharedAncestorWeight ?? LOW_RELEVANCE, // New default value
	};

	const fileScores = new Map<string, number>();
	const uriMap = new Map<string, vscode.Uri>();

	// Legacy symbol-related logic removed

	const activeFileRelativePath = activeEditorContext?.documentUri
		? path
				.relative(projectRoot.fsPath, activeEditorContext.documentUri.fsPath)
				.replace(/\\/g, "/")
		: undefined;

	const activeFileDir = activeFileRelativePath
		? path.dirname(activeFileRelativePath)
		: undefined;

	// --- AI-Powered Batch Scoring ---
	let aiFileScores = new Map<string, number>();
	if (aiRequestService && userRequest && isHeuristicSelectionEnabled) {
		try {
			aiFileScores = await _aiHeuristicScoring(
				allScannedFiles,
				projectRoot,
				userRequest,
				aiRequestService,
				modelName,
				cancellationToken,
			);
		} catch (e: any) {
			console.warn(
				`[HeuristicContextSelector] AI scoring failed: ${e.message}`,
			);
		}
	}

	for (const fileUri of allScannedFiles) {
		if (cancellationToken?.isCancellationRequested) {
			break;
		}

		const relativePath = path
			.relative(projectRoot.fsPath, fileUri.fsPath)
			.replace(/\\/g, "/");
		uriMap.set(relativePath, fileUri);
		let score = 0;

		if (relativePath === activeFileRelativePath) {
			score += ACTIVE_FILE_SCORE_BOOST;
		}

		// Legacy scoring logic removed - focusing on simple proximity and AI scoring

		// Score based on directory proximity
		if (activeFileDir) {
			const fileDir = path.dirname(relativePath);
			if (fileDir === activeFileDir) {
				score += effectiveOptions.sameDirectoryWeight;
			} else {
				// Score neighbor directories
				const activeParentDir = path.dirname(activeFileDir);
				if (
					activeParentDir !== "." &&
					path.dirname(fileDir) === activeParentDir
				) {
					score += effectiveOptions.neighborDirectoryWeight;
				}

				// Score shared ancestor directories
				const activePathParts = activeFileDir.split("/");
				const filePathParts = fileDir.split("/");
				let commonDepth = 0;
				while (
					commonDepth < activePathParts.length &&
					commonDepth < filePathParts.length &&
					activePathParts[commonDepth] === filePathParts[commonDepth]
				) {
					commonDepth++;
				}
				if (commonDepth > 0) {
					score += effectiveOptions.sharedAncestorWeight * commonDepth;
				}
			}
		}

		if (score > 0 || aiFileScores.has(relativePath)) {
			const finalScore =
				(fileScores.get(relativePath) || 0) +
				score +
				(aiFileScores.get(relativePath) || 0);
			fileScores.set(relativePath, finalScore);
		}
	}

	let sortedFiles = Array.from(fileScores.entries())
		.sort(([, scoreA], [, scoreB]) => scoreB - scoreA)
		.map(([relativePath]) => uriMap.get(relativePath) as vscode.Uri)
		.filter(Boolean);

	if (sortedFiles.length > effectiveOptions.maxHeuristicFilesTotal) {
		sortedFiles = sortedFiles.slice(0, effectiveOptions.maxHeuristicFilesTotal);
	}

	return sortedFiles;
}

/**
 * Performs a lightweight AI-powered batch scoring of file paths.
 */
async function _aiHeuristicScoring(
	allScannedFiles: ReadonlyArray<vscode.Uri>,
	projectRoot: vscode.Uri,
	userRequest: string,
	aiRequestService: AIRequestService,
	modelName: string,
	token?: vscode.CancellationToken,
): Promise<Map<string, number>> {
	const scores = new Map<string, number>();
	if (allScannedFiles.length === 0) {
		return scores;
	}

	// Prepare file list for ranking
	const relativePaths = allScannedFiles.map((f) =>
		path.relative(projectRoot.fsPath, f.fsPath).replace(/\\/g, "/"),
	);

	// Batch paths to avoid prompt overflow, although for Flash Lite we can handle many
	const BATCH_SIZE = 100;
	for (let i = 0; i < relativePaths.length; i += BATCH_SIZE) {
		if (token?.isCancellationRequested) {
			break;
		}

		const batch = relativePaths.slice(i, i + BATCH_SIZE);
		const prompt = `
Analyze the following user request and file paths. Identify which files are likely most relevant to the request.
Return a JSON object where keys are the file paths and values are relevance scores from 0 to 100.
ONLY include files with a score > 0.

User Request: "${userRequest}"

File Paths:
${batch.join("\n")}

JSON Output:`.trim();

		try {
			const response = await aiRequestService.generateWithRetry(
				[{ text: prompt }],
				modelName,
				undefined,
				"heuristic_ai_selection",
				{ responseMimeType: "application/json" },
				undefined,
				token,
			);

			const jsonMatch = response.match(/\{.*\}/s);
			if (jsonMatch) {
				const parsed = JSON.parse(jsonMatch[0]);
				for (const [filePath, score] of Object.entries(parsed)) {
					if (typeof score === "number" && score > 0) {
						scores.set(filePath, score);
					}
				}
			}
		} catch (e) {
			console.warn(`[HeuristicContextSelector] Batch scoring failed:`, e);
		}
	}

	return scores;
}
