import * as vscode from "vscode";
import {
	ActiveSymbolDetailedInfo,
	MAX_REFERENCED_TYPE_CONTENT_CHARS_CONSTANT,
} from "../services/contextService";
import {
	extractContentForRange,
	getDocumentationRange,
	getDeclarationRange,
	formatSymbolStructure,
} from "../utils/codeAnalysisUtils";

// Define what constitutes a "major" symbol kind for content prioritization
const MAJOR_SYMBOL_KINDS: vscode.SymbolKind[] = [
	vscode.SymbolKind.Class,
	vscode.SymbolKind.Function,
	vscode.SymbolKind.Method,
	vscode.SymbolKind.Interface,
	vscode.SymbolKind.Enum,
	vscode.SymbolKind.Namespace,
	vscode.SymbolKind.Constructor,
	vscode.SymbolKind.Module,
	vscode.SymbolKind.Variable, // Variables can also be major, especially constants
	vscode.SymbolKind.Constant, // Explicitly add constant
	vscode.SymbolKind.TypeParameter, // Consider if these are important for summary
	vscode.SymbolKind.Property, // For classes/interfaces, these are important
	vscode.SymbolKind.Field, // For classes/interfaces, these are important
];

// Define what constitutes an "exported" symbol kind, often a subset of major
const EXPORTED_SYMBOL_KINDS: vscode.SymbolKind[] = [
	vscode.SymbolKind.Class,
	vscode.SymbolKind.Function,
	vscode.SymbolKind.Interface,
	vscode.SymbolKind.Enum,
	vscode.SymbolKind.Variable,
	vscode.SymbolKind.Constant,
];

// Structural markers for improved AI processing
const MARKERS = {
	DOC: "DOC",
	STRUCT: "STRUCT",
	SIGNATURE: "SIGNATURE",
	ACTIVE_SYMBOL: "ACTIVE_SYMBOL",
	IMPORTS: "IMPORTS",
	PREAMBLE: "PREAMBLE",
	CONTEXT: "CONTEXT",
	END_SECTION: "END_SECTION",
};

/**
 * Extracts and summarizes relevant content from a file based on symbol information.
 * Prioritizes the active symbol's definition, major symbol definitions, imports, and exports.
 * @param fileContent The full content of the file.
 * @param documentSymbols An array of DocumentSymbols for the file.
 * @param activeSymbolDetailedInfo Detailed information about the active symbol, if any, *and if it belongs to this file*.
 * @param maxAllowedLength The maximum character length for the summarized content.
 * @returns A string containing the intelligently summarized file content.
 */
export function intelligentlySummarizeFileContent(
	fileContent: string,
	documentSymbols: vscode.DocumentSymbol[] | undefined,
	activeSymbolDetailedInfo: ActiveSymbolDetailedInfo | undefined,
	maxAllowedLength: number
): string {
	let currentLength = 0;
	const collectedParts: { content: string; startLine: number }[] = [];
	const includedRanges: vscode.Range[] = []; // To track content ranges already added
	const fileLines = fileContent.split("\n");

	/**
	 * Checks if a given range substantially overlaps with any already included ranges.
	 * "Substantially" means more than 70% of the candidate range is covered in terms of lines.
	 * @param candidateRange The range to check for overlap.
	 * @returns True if there's a substantial overlap, false otherwise.
	 */
	const isSubstantiallyOverlapping = (
		candidateRange: vscode.Range
	): boolean => {
		const candidateLineCount =
			candidateRange.end.line - candidateRange.start.line + 1;
		if (candidateLineCount <= 0) {
			return false;
		}

		for (const existingRange of includedRanges) {
			const intersection = existingRange.intersection(candidateRange);
			if (intersection && !intersection.isEmpty) {
				const intersectionLineCount =
					intersection.end.line - intersection.start.line + 1;

				// 4a. Update isSubstantiallyOverlapping logic
				if (intersectionLineCount >= candidateLineCount * 0.7) {
					return true; // 70% or more of the candidate range is covered
				}
			}
		}
		return false;
	};

	/**
	 * Adds a content block to the summary if space allows and it doesn't significantly overlap
	 * with already included content.
	 * @param contentRaw The raw string content to add (may be pre-formatted, e.g., from formatSymbolStructure).
	 * @param sourceRange The VS Code Range corresponding to the content's location in the file.
	 * @param markerType The type of content (e.g., IMPORTS, DOC).
	 * @param description Optional detailed description for the marker header.
	 * @param desiredBlockLength Optional preferred maximum length for the raw content part of the block.
	 * @returns True if content was added, false otherwise.
	 */
	const addContentBlock = (
		contentRaw: string,
		sourceRange: vscode.Range,
		markerType: string,
		description: string = "",
		desiredBlockLength?: number
	): boolean => {
		if (currentLength >= maxAllowedLength) {
			return false;
		}

		if (isSubstantiallyOverlapping(sourceRange)) {
			return false;
		}

		// 4b. Adjust header/footer logic to use new MARKERS
		const headerContent = description ? `: ${description}` : "";
		const headerPart = `// [${markerType}${headerContent}]\n`;
		const footerPart = `\n// [${MARKERS.END_SECTION}: ${markerType}]`;

		let contentToUse = contentRaw;

		// Apply desiredBlockLength if provided and contentRaw exceeds it
		if (
			desiredBlockLength !== undefined &&
			contentToUse.length > desiredBlockLength
		) {
			contentToUse = contentToUse.substring(0, desiredBlockLength);
		}

		let combinedContent = contentToUse;
		let combinedLength =
			headerPart.length + contentToUse.length + footerPart.length;

		const remainingSpace = maxAllowedLength - currentLength;

		if (combinedLength > remainingSpace) {
			const truncationMessage = "\n// ... (section truncated)";
			const availableContentLength =
				remainingSpace - headerPart.length - footerPart.length;

			if (availableContentLength > 30) {
				combinedContent =
					contentToUse.substring(
						0,
						availableContentLength - truncationMessage.length
					) + truncationMessage;
			} else {
				// Too small to be meaningful after reserving space
				return false;
			}
		}

		const finalBlock = headerPart + combinedContent + footerPart;

		if (finalBlock.length > 0) {
			collectedParts.push({
				content: finalBlock,
				startLine: sourceRange.start.line,
			});
			currentLength += finalBlock.length;
			includedRanges.push(sourceRange); // 4b. Ensure sourceRange is included
			return true;
		}
		return false;
	};

	// --- Prioritized Content Candidates ---
	interface ContentCandidate {
		priority: number; // Higher number = higher priority
		range: vscode.Range; // Range to extract content from
		marker: string; // Marker type
		description: string; // Description for the marker header
		contentOverride?: string; // Optional pre-calculated content (e.g., from formatSymbolStructure)
		desiredBlockLength?: number;
	}

	const candidates: ContentCandidate[] = [];

	// Helper to check if a location is within the current file being summarized
	const isLocationInCurrentFile = (
		location: vscode.Location | undefined,
		currentFilePath: string // This should be activeSymbolDetailedInfo.filePath
	): boolean => {
		if (!location || !location.uri || !currentFilePath) {
			return false;
		}
		const locationNormalizedPath = location.uri.fsPath.replace(/\\/g, "/");
		const currentFileNormalizedPath = currentFilePath.replace(/\\/g, "/");
		return locationNormalizedPath === currentFileNormalizedPath;
	};

	// 1. Candidate: Active Symbol's Full Definition (Highest Priority)
	if (activeSymbolDetailedInfo?.fullRange) {
		const kindName =
			activeSymbolDetailedInfo.kind !== undefined
				? (vscode.SymbolKind as any)[activeSymbolDetailedInfo.kind]
				: "Unknown";
		candidates.push({
			priority: 5, // Highest priority
			range: activeSymbolDetailedInfo.fullRange,
			marker: MARKERS.ACTIVE_SYMBOL,
			description: `${activeSymbolDetailedInfo.name} (${kindName})`,
		});
	}

	// 2. Candidate: File Preamble / Top-level comments
	let preambleEndLine = -1;
	for (let i = 0; i < Math.min(fileLines.length, 20); i++) {
		const line = fileLines[i].trim();
		if (
			line.startsWith("//") ||
			line.startsWith("/*") ||
			line.startsWith("*") ||
			line.startsWith("#") ||
			line === ""
		) {
			preambleEndLine = i;
		} else {
			break;
		}
	}
	if (preambleEndLine >= 0) {
		candidates.push({
			priority: 4.5,
			range: new vscode.Range(
				0,
				0,
				preambleEndLine,
				fileLines[preambleEndLine]?.length || 0
			),
			marker: MARKERS.PREAMBLE, // 4c. Use MARKERS
			description: "High-level description",
			desiredBlockLength: Math.floor(maxAllowedLength * 0.15),
		});
	}

	// 3. Candidate: Import Statements and Module-level setup
	let importAndSetupEndLine = -1;
	let foundFirstCodeOrImportLine = false;
	const importKeywords = ["import ", "require(", "from ", "using ", "package "];

	for (let i = 0; i < fileLines.length; i++) {
		const line = fileLines[i].trim();
		const isImportLike = importKeywords.some((keyword) =>
			line.startsWith(keyword)
		);
		const isCommentOrEmpty =
			line === "" || line.startsWith("//") || line.startsWith("/*");

		if (isImportLike) {
			importAndSetupEndLine = i;
			foundFirstCodeOrImportLine = true;
		} else if (!isCommentOrEmpty && foundFirstCodeOrImportLine) {
			break;
		}
	}

	if (importAndSetupEndLine >= 0) {
		const startLineForImports = Math.max(preambleEndLine + 1, 0);
		if (importAndSetupEndLine >= startLineForImports) {
			candidates.push({
				priority: 4,
				range: new vscode.Range(
					startLineForImports,
					0,
					importAndSetupEndLine,
					fileLines[importAndSetupEndLine]?.length || 0
				),
				marker: MARKERS.IMPORTS, // 4c. Use MARKERS
				description: "Module Setup",
				desiredBlockLength: Math.floor(maxAllowedLength * 0.2),
			});
		}
	}

	// 4. Candidates: Exported Major Symbols (4d. Implement prioritization)
	if (documentSymbols) {
		documentSymbols
			.filter(
				(symbol) =>
					EXPORTED_SYMBOL_KINDS.includes(symbol.kind) &&
					symbol.range.start.line > importAndSetupEndLine
			)
			.forEach((symbol) => {
				const kindName = vscode.SymbolKind[symbol.kind];

				// P3.9: Documentation Range (if available)
				const docRange = getDocumentationRange(fileContent, symbol);
				if (docRange) {
					candidates.push({
						priority: 3.9,
						range: docRange,
						marker: MARKERS.DOC,
						description: `Exported ${kindName} Documentation: ${symbol.name}`,
						desiredBlockLength: 512,
					});
				}

				// P3.8: Structure (for Interfaces/TypeAliases) - Using pre-formatted content
				if (
					symbol.kind === vscode.SymbolKind.Interface ||
					symbol.kind === vscode.SymbolKind.TypeParameter ||
					(symbol.kind as number) === 25
				) {
					const structuredContent = formatSymbolStructure(symbol, fileContent);

					if (structuredContent) {
						candidates.push({
							priority: 3.8,
							range: symbol.range, // Use full range for overlap tracking
							marker: MARKERS.STRUCT,
							description: `Exported ${kindName} Structure: ${symbol.name}`,
							contentOverride: structuredContent,
							desiredBlockLength: Math.floor(maxAllowedLength * 0.15),
						});
					}
				}

				// P3.7: Declaration Range (Signature only) for functions, classes, variables, constants
				const declarationRange = getDeclarationRange(fileContent, symbol);
				if (declarationRange) {
					candidates.push({
						priority: 3.7,
						range: declarationRange, // Use declaration range (signature)
						marker: MARKERS.SIGNATURE,
						description: `Exported ${kindName} Signature: ${symbol.name}`,
						desiredBlockLength: 1024,
					});
				}
			});
	}

	// 5. Candidates: Call Hierarchy details within the current file
	if (activeSymbolDetailedInfo?.filePath) {
		const currentFileNormalizedPath = activeSymbolDetailedInfo.filePath.replace(
			/\\/g,
			"/"
		);

		activeSymbolDetailedInfo.incomingCalls?.forEach((call) => {
			if (
				isLocationInCurrentFile(call.from, currentFileNormalizedPath) &&
				call.fromRanges?.[0]
			) {
				candidates.push({
					priority: 3.25,
					range: call.fromRanges[0],
					marker: MARKERS.CONTEXT,
					description: `Call to active symbol from: ${call.from.name}`,
					desiredBlockLength: MAX_REFERENCED_TYPE_CONTENT_CHARS_CONSTANT,
				});
			}
		});

		activeSymbolDetailedInfo.outgoingCalls?.forEach((call) => {
			if (
				isLocationInCurrentFile(call.to, currentFileNormalizedPath) &&
				call.to.range
			) {
				candidates.push({
					priority: 3.25,
					range: call.to.range,
					marker: MARKERS.CONTEXT,
					description: `Active symbol calls: ${call.to.name}`,
					desiredBlockLength: MAX_REFERENCED_TYPE_CONTENT_CHARS_CONSTANT,
				});
			}
		});
	}

	// 6. Candidates: Other Major Symbol Definitions (Internal definitions)
	if (documentSymbols) {
		documentSymbols
			.filter(
				(symbol) =>
					MAJOR_SYMBOL_KINDS.includes(symbol.kind) &&
					!EXPORTED_SYMBOL_KINDS.includes(symbol.kind)
			)
			.forEach((symbol) => {
				const kindName = vscode.SymbolKind[symbol.kind];

				// 4e. Refactor Other Major Symbol Candidates (Priority 3)
				const declarationRange = getDeclarationRange(fileContent, symbol);
				const rangeToUse = declarationRange || symbol.range;

				candidates.push({
					priority: 3,
					range: rangeToUse,
					marker: MARKERS.SIGNATURE,
					description: `Internal ${kindName} Signature: ${symbol.name}`,
					desiredBlockLength: 2048,
				});
			});
	}

	// Sort candidates: highest priority first, then by line number
	candidates.sort(
		(a, b) => b.priority - a.priority || a.range.start.line - b.range.start.line
	);

	// --- Process Candidates ---
	for (const candidate of candidates) {
		if (currentLength >= maxAllowedLength) {
			break;
		}

		const contentRaw = candidate.contentOverride
			? candidate.contentOverride
			: extractContentForRange(fileContent, candidate.range);

		if (contentRaw.trim()) {
			addContentBlock(
				contentRaw,
				candidate.range,
				candidate.marker,
				candidate.description,
				candidate.desiredBlockLength
			);
		}
	}

	// --- Fallback: Fill remaining space with uncaught context ---
	if (currentLength < maxAllowedLength) {
		let currentLine = 0;
		while (currentLine < fileLines.length && currentLength < maxAllowedLength) {
			const lineRange = new vscode.Range(
				currentLine,
				0,
				currentLine,
				fileLines[currentLine].length
			);
			const isLineCovered = includedRanges.some((r) =>
				r.contains(lineRange.start)
			);

			if (!isLineCovered) {
				let blockEndLine = currentLine;
				while (blockEndLine + 1 < fileLines.length) {
					const nextLinePos = new vscode.Position(blockEndLine + 1, 0);
					if (includedRanges.some((r) => r.contains(nextLinePos))) {
						break;
					}
					blockEndLine++;
				}
				const snippetRange = new vscode.Range(
					currentLine,
					0,
					blockEndLine,
					fileLines[blockEndLine].length
				);
				const snippetContent = extractContentForRange(
					fileContent,
					snippetRange
				);

				// 4f. Refactor Fallback Logic
				if (snippetContent.trim()) {
					addContentBlock(
						snippetContent,
						snippetRange,
						MARKERS.CONTEXT,
						`Lines ${currentLine + 1}-${blockEndLine + 1}`,
						maxAllowedLength - currentLength
					);
				}
				currentLine = blockEndLine + 1;
			} else {
				currentLine++;
			}
		}
	}

	// Final assembly: Sort by line number for coherence
	collectedParts.sort((a, b) => a.startLine - b.startLine);
	let finalContent = collectedParts
		.map((p) => p.content)
		.join("\n\n// ... (non-contiguous section) ...\n\n");

	if (finalContent.length > maxAllowedLength) {
		finalContent =
			finalContent.substring(0, maxAllowedLength) + "\n// ... (truncated)";
	}

	if (!finalContent.trim() && fileContent.length > 0) {
		// Edge case: If nothing was collected but the file isn't empty
		return `// File content could not be summarized. Snippet: ${fileContent.substring(
			0,
			Math.min(fileContent.length, 100)
		)}...`;
	}

	return finalContent.trim();
}
