import * as vscode from "vscode";
import {
	ActiveSymbolDetailedInfo,
	MAX_REFERENCED_TYPE_CONTENT_CHARS_CONSTANT,
} from "../services/contextService";

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

/**
 * Helper to extract content string from a specific VS Code Range within the full file content.
 * Handles multiline ranges correctly.
 * @param fullContent The entire file content as a single string.
 * @param range The VS Code Range object specifying the start and end of the desired content.
 * @returns The extracted string content for the given range.
 */
function extractContentForRange(
	fullContent: string,
	range: vscode.Range
): string {
	const lines = fullContent.split("\n");
	const startLine = range.start.line;
	const endLine = range.end.line;

	if (startLine < 0 || endLine >= lines.length || startLine > endLine) {
		return ""; // Invalid range
	}

	let contentLines: string[] = [];
	// Iterate through lines within the range
	for (let i = startLine; i <= endLine; i++) {
		let line = lines[i];
		if (i === startLine && i === endLine) {
			// Single line range
			line = line.substring(range.start.character, range.end.character);
		} else if (i === startLine) {
			line = line.substring(range.start.character);
		} else if (i === endLine) {
			line = line.substring(0, range.end.character);
		}
		contentLines.push(line);
	}
	return contentLines.join("\n");
}

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
	 * "Substantially" means more than 70% of the candidate range is already covered.
	 * @param candidateRange The range to check for overlap.
	 * @returns True if there's a substantial overlap, false otherwise.
	 */
	const isSubstantiallyOverlapping = (
		candidateRange: vscode.Range
	): boolean => {
		for (const existingRange of includedRanges) {
			const intersection = existingRange.intersection(candidateRange);
			if (
				intersection &&
				!intersection.isEmpty &&
				intersection.end.line - intersection.start.line + 1 >=
					(candidateRange.end.line - candidateRange.start.line + 1) * 0.7
			) {
				return true; // 70% or more of the candidate range is covered
			}
		}
		return false;
	};

	/**
	 * Adds a content block to the summary if space allows and it doesn't significantly overlap
	 * with already included content.
	 * @param contentRaw The raw string content to add.
	 * @param range The VS Code Range of the content.
	 * @param header Optional header for the section.
	 * @param footer Optional footer for the section.
	 * @param desiredBlockLength Optional preferred maximum length for the raw content part of the block.
	 * @returns True if content was added, false otherwise.
	 */
	const addContentBlock = (
		contentRaw: string,
		range: vscode.Range,
		header?: string,
		footer?: string,
		desiredBlockLength?: number
	): boolean => {
		if (currentLength >= maxAllowedLength) {
			return false;
		}

		if (isSubstantiallyOverlapping(range)) {
			return false;
		}

		const headerPart = header ? `${header}\n` : "";
		const footerPart = footer ? `\n${footer}` : "";
		let contentToUse = contentRaw;

		// Apply desiredBlockLength if provided and contentRaw exceeds it
		if (
			desiredBlockLength !== undefined &&
			contentToUse.length > desiredBlockLength
		) {
			contentToUse = contentToUse.substring(0, desiredBlockLength);
		}

		let combinedContent = headerPart + contentToUse + footerPart;

		const remainingSpace = maxAllowedLength - currentLength;
		if (combinedContent.length > remainingSpace) {
			combinedContent = combinedContent.substring(0, remainingSpace);
			if (remainingSpace > 30) {
				// Add truncation message if enough space
				combinedContent += "\n// ... (section truncated)";
			} else {
				// If after truncation, it's too small or empty to be meaningful
				return false;
			}
		}

		if (combinedContent.length > 0) {
			collectedParts.push({
				content: combinedContent,
				startLine: range.start.line,
			});
			currentLength += combinedContent.length;
			includedRanges.push(range);
			return true;
		}
		return false;
	};

	// --- Prioritized Content Candidates ---
	interface ContentCandidate {
		priority: number; // Higher number = higher priority
		range: vscode.Range;
		header?: string;
		footer?: string;
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
		candidates.push({
			priority: 5, // Highest priority
			range: activeSymbolDetailedInfo.fullRange,
			header: `// --- Active Symbol: ${activeSymbolDetailedInfo.name} (${
				activeSymbolDetailedInfo.kind !== undefined
					? activeSymbolDetailedInfo.kind
					: "Unknown"
			}) ---`,
			footer: `// --- End Active Symbol ---`,
		});
	}

	// 2. Candidate: File Preamble / Top-level comments (e.g., file-level JSDoc, license)
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
			header: "// --- File Preamble (High-level description) ---",
			footer: "// --- End File Preamble ---",
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
				header: "// --- Imports and Module Setup ---",
				footer: "// --- End Imports and Module Setup ---",
				desiredBlockLength: Math.floor(maxAllowedLength * 0.2),
			});
		}
	}

	// 4. Candidates: Exported Major Symbols
	if (documentSymbols) {
		documentSymbols
			.filter(
				(symbol) =>
					EXPORTED_SYMBOL_KINDS.includes(symbol.kind) &&
					symbol.range.start.line > importAndSetupEndLine
			)
			.forEach((symbol) => {
				candidates.push({
					priority: 3.5,
					range: symbol.range,
					header: `// --- Exported ${vscode.SymbolKind[symbol.kind]}: ${
						symbol.name
					} ---`,
				});
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
					header: `// --- Context: Call to active symbol from: ${call.from.name} ---`,
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
					header: `// --- Context: Active symbol calls: ${call.to.name} ---`,
					desiredBlockLength: MAX_REFERENCED_TYPE_CONTENT_CHARS_CONSTANT,
				});
			}
		});
	}

	// 6. Candidates: Other Major Symbol Definitions
	if (documentSymbols) {
		documentSymbols
			.filter((symbol) => MAJOR_SYMBOL_KINDS.includes(symbol.kind))
			.forEach((symbol) => {
				candidates.push({
					priority: 3,
					range: symbol.range,
					header: `// --- Definition: ${vscode.SymbolKind[symbol.kind]} ${
						symbol.name
					} ---`,
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
		const contentExtracted = extractContentForRange(
			fileContent,
			candidate.range
		);
		if (contentExtracted.trim()) {
			addContentBlock(
				contentExtracted,
				candidate.range,
				candidate.header,
				candidate.footer,
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
				if (snippetContent.trim()) {
					addContentBlock(
						snippetContent,
						snippetRange,
						`// --- General Context (Lines ${currentLine + 1}-${
							blockEndLine + 1
						}) ---`,
						undefined,
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
		return `// File content could not be summarized. Snippet: ${fileContent.substring(
			0,
			100
		)}...`;
	}

	return finalContent.trim();
}
