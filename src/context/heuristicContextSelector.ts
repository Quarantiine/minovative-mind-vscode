import * as vscode from "vscode";
import * as path from "path";
import { PlanGenerationContext } from "../sidebar/common/sidebarTypes";
import { ActiveSymbolDetailedInfo } from "../services/contextService";

// Scoring weights constants
const HIGH_RELEVANCE = 100;
const MEDIUM_RELEVANCE = 80;
const LOW_RELEVANCE = 50;
const ACTIVE_FILE_SCORE_BOOST = 200;

export interface HeuristicSelectionOptions {
	maxHeuristicFilesTotal: number;
	maxSameDirectoryFiles: number;
	maxDirectDependencies: number;
	maxReverseDependencies: number;
	maxCallHierarchyFiles: number;
	sameDirectoryWeight: number;
	directDependencyWeight: number;
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
	fileDependencies?: Map<string, string[]>,
	reverseFileDependencies?: Map<string, string[]>,
	activeSymbolDetailedInfo?: ActiveSymbolDetailedInfo,
	cancellationToken?: vscode.CancellationToken,
	options?: Partial<HeuristicSelectionOptions>
): Promise<vscode.Uri[]> {
	// Initialize effective options with provided options or default weights
	const effectiveOptions: HeuristicSelectionOptions = {
		maxHeuristicFilesTotal: options?.maxHeuristicFilesTotal ?? 30,
		maxSameDirectoryFiles: options?.maxSameDirectoryFiles ?? 15,
		maxDirectDependencies: options?.maxDirectDependencies ?? 10,
		maxReverseDependencies: options?.maxReverseDependencies ?? 10,
		maxCallHierarchyFiles: options?.maxCallHierarchyFiles ?? 10,
		sameDirectoryWeight: options?.sameDirectoryWeight ?? LOW_RELEVANCE,
		directDependencyWeight: options?.directDependencyWeight ?? MEDIUM_RELEVANCE,
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

	// Pre-process symbol-related URIs for direct lookups
	const symbolRelatedRelativePaths = new Set<string>(); // General set for any symbol relation
	const definitionRelativePaths = new Set<string>();
	const typeDefinitionRelativePaths = new Set<string>();
	const implementationRelativePaths = new Set<string>();
	const referencedTypeDefinitionRelativePaths = new Set<string>();
	const callHierarchyRelativePaths = new Set<string>();

	const addUriToSet = (
		location: vscode.Uri | vscode.Location | vscode.Location[] | undefined,
		targetSet: Set<string>
	) => {
		if (!location) {
			return;
		}
		const uris = Array.isArray(location)
			? location.map((l) => l.uri)
			: [location instanceof vscode.Uri ? location : location.uri];

		uris.forEach((uri) => {
			if (uri?.scheme === "file") {
				const relativePath = path
					.relative(projectRoot.fsPath, uri.fsPath)
					.replace(/\\/g, "/");
				targetSet.add(relativePath);
				symbolRelatedRelativePaths.add(relativePath);
			}
		});
	};

	if (activeSymbolDetailedInfo) {
		addUriToSet(activeSymbolDetailedInfo.definition, definitionRelativePaths);
		addUriToSet(
			activeSymbolDetailedInfo.typeDefinition,
			typeDefinitionRelativePaths
		);
		activeSymbolDetailedInfo.implementations?.forEach((loc) =>
			addUriToSet(loc, implementationRelativePaths)
		);
		activeSymbolDetailedInfo.referencedTypeDefinitions?.forEach(
			(_, relPath) => {
				referencedTypeDefinitionRelativePaths.add(relPath);
				symbolRelatedRelativePaths.add(relPath);
			}
		);
		activeSymbolDetailedInfo.incomingCalls?.forEach((call) =>
			addUriToSet(call.from.uri, callHierarchyRelativePaths)
		);
		activeSymbolDetailedInfo.outgoingCalls?.forEach((call) =>
			addUriToSet(call.to.uri, callHierarchyRelativePaths)
		);
	}

	const activeFileRelativePath = activeEditorContext?.documentUri
		? path
				.relative(projectRoot.fsPath, activeEditorContext.documentUri.fsPath)
				.replace(/\\/g, "/")
		: undefined;

	const activeFileDir = activeFileRelativePath
		? path.dirname(activeFileRelativePath)
		: undefined;

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

		// Score based on specific symbol relationships
		if (definitionRelativePaths.has(relativePath)) {
			score += effectiveOptions.definitionWeight;
		}
		if (typeDefinitionRelativePaths.has(relativePath)) {
			score += effectiveOptions.typeDefinitionWeight;
		}
		if (implementationRelativePaths.has(relativePath)) {
			score += effectiveOptions.implementationWeight;
		}
		if (referencedTypeDefinitionRelativePaths.has(relativePath)) {
			score += effectiveOptions.referencedTypeDefinitionWeight;
		}
		if (callHierarchyRelativePaths.has(relativePath)) {
			score += effectiveOptions.callHierarchyWeight;
		}
		if (symbolRelatedRelativePaths.has(relativePath)) {
			score += effectiveOptions.generalSymbolRelatedBoost;
		}

		// Score based on dependencies
		if (activeFileRelativePath) {
			if (
				fileDependencies?.get(activeFileRelativePath)?.includes(relativePath)
			) {
				score += effectiveOptions.directDependencyWeight;
			}
			if (
				reverseFileDependencies
					?.get(activeFileRelativePath)
					?.includes(relativePath)
			) {
				score += effectiveOptions.reverseDependencyWeight;
			}
		}

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

		if (score > 0) {
			fileScores.set(relativePath, (fileScores.get(relativePath) || 0) + score);
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
