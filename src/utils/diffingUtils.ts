// src/utils/diffingUtils.ts
import * as vscode from "vscode";
import { diff_match_patch } from "diff-match-patch";
import { DiffAnalysis } from "../types/codeGenerationTypes";

export async function generatePreciseTextEdits(
	originalContent: string,
	modifiedContent: string,
	document: vscode.TextDocument
): Promise<{ range: vscode.Range; newText: string }[]> {
	const dmp = new diff_match_patch();

	// Compute the diffs between originalContent and modifiedContent
	// The diff_main function returns an array of arrays. Each inner array has
	// two elements: an operation code (DIFF_INSERT, DIFF_DELETE, DIFF_EQUAL)
	// and the text associated with that operation.
	const diffs = dmp.diff_main(originalContent, modifiedContent);

	const edits: { range: vscode.Range; newText: string }[] = [];
	let originalPosOffset = 0; // Tracks the current character offset in the original content

	for (const diff of diffs) {
		const [type, text] = diff;

		// DIFF_EQUAL (0): Text is present in both original and modified.
		// No edit is needed; we just advance our position in the original content.
		if (type === diff_match_patch.DIFF_EQUAL) {
			originalPosOffset += text.length;
		}
		// DIFF_INSERT (1): Text was added in the modified content.
		// We need to insert this text at the current position in the original document.
		else if (type === diff_match_patch.DIFF_INSERT) {
			const startPos = document.positionAt(originalPosOffset);
			const endPos = document.positionAt(originalPosOffset); // For an insertion, the range is a single point
			edits.push({
				range: new vscode.Range(startPos, endPos),
				newText: text,
			});
			// For insertions, the originalPosOffset does NOT advance because
			// the insertion happens *at* this point, it doesn't consume original text.
		}
		// DIFF_DELETE (-1): Text was removed from the original content.
		// We need to delete this text from the original document.
		else if (type === diff_match_patch.DIFF_DELETE) {
			const startPos = document.positionAt(originalPosOffset);
			const endPos = document.positionAt(originalPosOffset + text.length);
			edits.push({
				range: new vscode.Range(startPos, endPos),
				newText: "", // Empty string signifies deletion
			});
			// For deletions, the originalPosOffset *does* advance by the length
			// of the deleted text, as that portion of the original document has now been processed.
			originalPosOffset += text.length;
		}
	}

	return edits;
}

export async function generateFileChangeSummary(
	oldContent: string,
	newContent: string,
	filePath: string
): Promise<{
	summary: string;
	addedLines: string[];
	removedLines: string[];
	formattedDiff: string;
}> {
	const dmp = new diff_match_patch();

	// 1. Convert the input strings (oldContent and newContent) from lines to a compact, character-based representation.
	// This is crucial for efficient diffing on longer texts while preserving line integrity.
	// The result `lineDiffResult` contains:
	//   - `text1_chars`: a string representing oldContent mapped to unique characters.
	//   - `text2_chars`: a string representing newContent mapped to unique characters.
	//   - `line_array`: an array that maps the unique characters back to their original full lines.
	const lineDiffResult = dmp.diff_linesToChars_(oldContent, newContent);
	const {
		chars1: text1_chars,
		chars2: text2_chars,
		lineArray: line_array,
	} = lineDiffResult;

	// 2. Perform the actual diff operation on the character-based representations.
	// This is a much faster operation for large files.
	let diffs = dmp.diff_main(text1_chars, text2_chars, false); // `false` for checklines optimization (optional, but good practice)

	// 3. Convert the character-level diffs back to line-level diffs using the original `line_array`.
	// This transforms the diff objects to contain actual lines rather than characters.
	dmp.diff_charsToLines_(diffs, line_array);
	// 4. Apply semantic cleanup to filter out trivial differences (e.g., purely whitespace changes,
	// or minor reordering that doesn't change meaning). This is crucial for avoiding
	// reporting changes for cosmetic-only modifications.
	dmp.diff_cleanupSemantic(diffs);

	let formattedDiffLines: string[] = [];
	let addedLines: string[] = [];
	let removedLines: string[] = [];
	// totalInsertions and totalDeletions are not needed as we use addedLines.length and removedLines.length
	// let totalInsertions = 0;
	// let totalDeletions = 0;

	for (const diff of diffs) {
		const [type, text] = diff;

		// Split the text into lines. If the `text` from dmp is an empty string,
		// `split('\n')` returns `['']`. This `['']` does not represent an actual line
		// to be displayed in the diff or counted. Otherwise, all lines from `split`
		// are processed, including empty strings that result from actual blank lines or trailing newlines.
		const lines = text.split("\n");
		const effectiveLines =
			text === "" && lines.length === 1 && lines[0] === "" ? [] : lines;

		if (type === diff_match_patch.DIFF_INSERT) {
			// Ensure empty strings from split are filtered out for cleaner results in addedLines array
			addedLines.push(...effectiveLines.filter((line) => line !== ""));
			// Add to formattedDiffLines
			effectiveLines.forEach((line) => formattedDiffLines.push(`+ ${line}`));
		} else if (type === diff_match_patch.DIFF_DELETE) {
			// Ensure empty strings from split are filtered out for cleaner results in removedLines array
			removedLines.push(...effectiveLines.filter((line) => line !== ""));
			// Add to formattedDiffLines
			effectiveLines.forEach((line) => formattedDiffLines.push(`- ${line}`));
		} else if (type === diff_match_patch.DIFF_EQUAL) {
			// Add to formattedDiffLines
			// Removed: effectiveLines.forEach((line) => formattedDiffLines.push(`  ${line}`));
		}
	}

	const formattedDiff = formattedDiffLines.join("\n");
	const addedLineCount = addedLines.length;
	const removedLineCount = removedLines.length;
	const LARGE_CHANGE_THRESHOLD = 500;

	if (addedLineCount + removedLineCount > LARGE_CHANGE_THRESHOLD) {
		const lineSummaryParts: string[] = [];
		if (addedLineCount > 0) {
			lineSummaryParts.push(
				`Added ${addedLineCount} line${addedLineCount === 1 ? "" : "s"}`
			);
		}
		if (removedLineCount > 0) {
			lineSummaryParts.push(
				`Removed ${removedLineCount} line${removedLineCount === 1 ? "" : "s"}`
			);
		}
		let quantitativeSummary = "";
		if (lineSummaryParts.length > 0) {
			quantitativeSummary = ` (${lineSummaryParts.join(", ")})`;
		}

		const summaryWithFilePath = `${filePath}: major changes detected${quantitativeSummary}`;

		return {
			summary: summaryWithFilePath,
			addedLines: addedLines,
			removedLines: removedLines,
			formattedDiff: formattedDiff,
		};
	}

	const addedContentFlat = addedLines.join("\n");
	const removedContentFlat = removedLines.join("\n");

	// Maps to store identified entities: type -> list of names (e.g., 'function' -> ['name1', 'name2'])
	const addedEntities: Map<string, string[]> = new Map();
	const removedEntities: Map<string, string[]> = new Map();

	// Helper to extract entities from a given content string
	const collectEntities = (
		content: string,
		targetMap: Map<string, string[]>
	) => {
		let match;

		// Helper to add entity, ensuring uniqueness within its type list
		const addEntity = (type: string, name: string) => {
			if (!targetMap.has(type)) {
				targetMap.set(type, []);
			}
			const namesForType = targetMap.get(type)!;
			if (!namesForType.includes(name)) {
				namesForType.push(name);
			}
		};

		// Helper to check if a name is already captured as a function/method
		const isFunctionName = (name: string): boolean => {
			return (
				(targetMap.get("function")?.includes(name) ||
					targetMap.get("method")?.includes(name)) ??
				false
			);
		};

		// Regex for function declarations (e.g., `function name()`, `const name = () => {}`, class methods)
		// Capture group 1: standalone function `function name(...)`
		// Capture group 2: variable-assigned function `const name = (...) =>`
		// Capture group 3: class method `methodName(...)`
		const functionRegex =
			/(?:(?:export|declare)\s+)?(?:async\s+)?function\s+(\w+)\s*\(|(?:\b(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)\s*=>|function\s*\(|$))|(?:\b(?:public|private|protected|static|async)?\s*(\w+)\s*\([^)]*\)\s*\{)/g;
		while ((match = functionRegex.exec(content)) !== null) {
			const name = match[1] || match[2] || match[3];
			if (name) {
				addEntity(match[3] ? "method" : "function", name);
			}
		}
		functionRegex.lastIndex = 0; // Reset regex for next use

		// Regex for class declarations
		const classRegex = /(?:(?:export|declare)\s+)?class\s+(\w+)/g;
		while ((match = classRegex.exec(content)) !== null) {
			const name = match[1];
			if (name) {
				addEntity("class", name);
			}
		}
		classRegex.lastIndex = 0;

		// Regex for variable declarations (trying to avoid functions captured above)
		// It attempts to match a variable name followed by `=`, but not immediately by `async` or `function`
		const variableRegex =
			/(?:(?:export|declare)\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?!async\s+)(?!function\s*)[^;,\n]*;?\s*(?:\n|$)/g;
		while ((match = variableRegex.exec(content)) !== null) {
			const name = match[1];
			// Only add if not already identified as a function/method
			if (name && !isFunctionName(name)) {
				addEntity("variable", name);
			}
		}
		variableRegex.lastIndex = 0;

		// Regex for interface/type alias declarations
		const interfaceTypeAliasRegex =
			/(?:(?:export|declare)\s+)?(?:interface|type)\s+(\w+)/g;
		while ((match = interfaceTypeAliasRegex.exec(content)) !== null) {
			const name = match[1];
			if (name) {
				addEntity("type/interface", name);
			}
		}
		interfaceTypeAliasRegex.lastIndex = 0;

		// Regex for enum declarations
		const enumRegex = /(?:(?:export|declare)\s+)?enum\s+(\w+)/g;
		while ((match = enumRegex.exec(content)) !== null) {
			const name = match[1];
			if (name) {
				addEntity("enum", name);
			}
		}
		enumRegex.lastIndex = 0;

		// Regex for import statements. Count each line that starts with 'import'.
		const importLineRegex = /^\s*import\s+\S/gm; // Matches lines starting with 'import ' (and not just 'import')
		let importStatementCount = 0;
		while ((match = importLineRegex.exec(content)) !== null) {
			importStatementCount++;
		}
		if (importStatementCount > 0) {
			addEntity("import statement", `(${importStatementCount})`);
		}
		importLineRegex.lastIndex = 0;

		// Regex for export statements. Count each line that starts with 'export'.
		const exportLineRegex = /^\s*export\s+\S/gm; // Matches lines starting with 'export '
		let exportStatementCount = 0;
		while ((match = exportLineRegex.exec(content)) !== null) {
			exportStatementCount++;
		}
		if (exportStatementCount > 0) {
			addEntity("export statement", `(${exportStatementCount})`);
		}
		exportLineRegex.lastIndex = 0;
	};

	collectEntities(addedContentFlat, addedEntities);
	collectEntities(removedContentFlat, removedEntities);

	const summaries: string[] = [];

	// Helper function to get entity types and their names, considering modifications
	// An entity is 'modified' if a name+type pair exists in both added and removed content.
	// It's 'added' if it's in added but not in removed.
	// It's 'removed' if it's in removed but not in added.
	const getProcessedEntities = (
		added: Map<string, string[]>,
		removed: Map<string, string[]>,
		type: "added" | "removed" | "modified"
	): Map<string, string[]> => {
		const result = new Map<string, string[]>();

		// Determine modified and purely added
		for (const [addedType, addedNames] of added.entries()) {
			for (const addedName of addedNames) {
				const isModified =
					removed.has(addedType) && removed.get(addedType)?.includes(addedName);
				if (
					(type === "modified" && isModified) ||
					(type === "added" && !isModified)
				) {
					if (!result.has(addedType)) {
						result.set(addedType, []);
					}
					result.get(addedType)?.push(addedName);
				}
			}
		}

		// Determine purely removed
		if (type === "removed") {
			for (const [removedType, removedNames] of removed.entries()) {
				for (const removedName of removedNames) {
					const isModified =
						added.has(removedType) &&
						added.get(removedType)?.includes(removedName);
					if (!isModified) {
						if (!result.has(removedType)) {
							result.set(removedType, []);
						}
						result.get(removedType)?.push(removedName);
					}
				}
			}
		}
		return result;
	};

	const modifiedGrouped = getProcessedEntities(
		addedEntities,
		removedEntities,
		"modified"
	);
	const addedGrouped = getProcessedEntities(
		addedEntities,
		removedEntities,
		"added"
	);
	const removedGrouped = getProcessedEntities(
		addedEntities,
		removedEntities,
		"removed"
	);

	// Helper to format grouped entities into summary strings
	const formatGroup = (prefix: string, groupedMap: Map<string, string[]>) => {
		const entries: string[] = [];
		for (const [type, names] of groupedMap.entries()) {
			if (names.length === 0) {
				continue;
			}

			const formattedNames = names.map((name) => `\`${name}\``).join(", ");
			// Determine pluralization for entity type
			let typeDisplay = type;
			if (names.length > 1 && !type.endsWith("s")) {
				// Avoid double-pluralizing already plural names or counts
				if (type.endsWith("statement")) {
					// "import statement" -> "import statements"
					typeDisplay += "s";
				} else {
					typeDisplay += "s"; // "function" -> "functions"
				}
			}
			entries.push(`${prefix} ${typeDisplay} ${formattedNames}`);
		}
		return entries;
	};

	summaries.push(...formatGroup("modified", modifiedGrouped));
	summaries.push(...formatGroup("added", addedGrouped));
	summaries.push(...formatGroup("removed", removedGrouped));

	let finalSummary = summaries.length > 0 ? summaries.join(", ") : "";

	// General summary if specific entities aren't found
	if (finalSummary === "") {
		if (addedLineCount > 0 && removedLineCount === 0) {
			finalSummary = "added new content";
		} else if (removedLineCount > 0 && addedLineCount === 0) {
			finalSummary = "removed content";
		} else if (addedLineCount > 0 && removedLineCount > 0) {
			// Use total line changes for magnitude
			if (addedLineCount + removedLineCount > 10) {
				// Arbitrary threshold for "major changes" based on lines
				finalSummary = "major changes detected";
			} else {
				finalSummary = "modified existing content";
			}
		} else {
			finalSummary = "no significant changes"; // Fallback, should rarely happen if diffs exist
		}
	}

	// Append quantitative summary of line changes
	const lineSummaryParts: string[] = [];
	if (addedLineCount > 0) {
		lineSummaryParts.push(
			`Added ${addedLineCount} line${addedLineCount === 1 ? "" : "s"}`
		);
	}
	if (removedLineCount > 0) {
		lineSummaryParts.push(
			`Removed ${removedLineCount} line${removedLineCount === 1 ? "" : "s"}`
		);
	}

	let quantitativeSummary = "";
	if (lineSummaryParts.length > 0) {
		quantitativeSummary = ` (${lineSummaryParts.join(", ")})`;
	}

	// Prepend the file path and append quantitative summary
	const summaryWithFilePath = `${filePath}: ${finalSummary}${quantitativeSummary}`;

	return {
		summary: summaryWithFilePath,
		addedLines: addedLines,
		removedLines: removedLines,
		formattedDiff: formattedDiff,
	};
}

export function createInversePatch(
	originalContent: string,
	newContent: string
): string {
	const dmp = new diff_match_patch();
	// To create an inverse patch, we calculate the diff from new to original
	const diffs = dmp.diff_main(newContent, originalContent);
	const patch = dmp.patch_make(newContent, diffs);
	return dmp.patch_toText(patch);
}

export function applyPatch(content: string, patchString: string): string {
	const dmp = new diff_match_patch();
	const patches = dmp.patch_fromText(patchString);
	// The patch_apply function returns an array where the first element is the new text
	// and the second is an array of booleans indicating which patches were applied.
	const [patchedContent] = dmp.patch_apply(patches, content);
	return patchedContent;
}

/**
 * Analyze the diff between original and modified content
 */
export function analyzeDiff(original: string, modified: string): DiffAnalysis {
	const originalLines = original.split("\n");
	const modifiedLines = modified.split("\n");

	const issues: string[] = [];
	let isReasonable = true;

	const originalLength = originalLines.length;
	const modifiedLength = modifiedLines.length;
	const changeRatio =
		originalLength === 0
			? modifiedLength > 0
				? 1
				: 0
			: Math.abs(modifiedLength - originalLength) / originalLength;

	if (changeRatio > 0.8) {
		issues.push(
			"Modification seems too drastic - consider a more targeted approach"
		);
		isReasonable = false;
	}

	const originalImports = originalLines.filter((line) =>
		line.trim().startsWith("import")
	);
	const modifiedImports = modifiedLines.filter((line) =>
		line.trim().startsWith("import")
	);

	if (originalImports.length > 0 && modifiedImports.length === 0) {
		issues.push("All imports were removed - this may be incorrect");
		isReasonable = false;
	}

	return {
		isReasonable,
		issues,
		changeRatio,
	};
}

/**
 * Parse a diff hunk and convert it to VS Code text edits
 * Handles additions (+), deletions (-), and context lines
 */
export function parseDiffHunkToTextEdits(
	diffHunk: string,
	document: vscode.TextDocument,
	startLineOffset: number = 0
): { range: vscode.Range; newText: string }[] {
	const edits: { range: vscode.Range; newText: string }[] = [];
	const lines = diffHunk.split("\n").filter((line) => line.trim() !== "");

	let currentLine = startLineOffset;
	let inDeletion = false;
	let deletionStart: vscode.Position | null = null;
	let deletionEnd: vscode.Position | null = null;

	for (const line of lines) {
		if (line.startsWith("+")) {
			// Addition: insert new text
			const newText = line.substring(1) + "\n";
			const insertPos = document.positionAt(
				document.offsetAt(new vscode.Position(currentLine, 0))
			);

			edits.push({
				range: new vscode.Range(insertPos, insertPos),
				newText: newText,
			});

			// Don't increment currentLine for insertions
		} else if (line.startsWith("-")) {
			// Deletion: mark the range to delete
			if (!inDeletion) {
				deletionStart = document.positionAt(
					document.offsetAt(new vscode.Position(currentLine, 0))
				);
				inDeletion = true;
			}

			// Update deletion end position
			deletionEnd = document.positionAt(
				document.offsetAt(new vscode.Position(currentLine, 0)) +
					document.lineAt(currentLine).text.length
			);

			currentLine++;
		} else {
			// Context line or unchanged line
			if (inDeletion) {
				// End the current deletion
				if (deletionStart && deletionEnd) {
					edits.push({
						range: new vscode.Range(deletionStart, deletionEnd),
						newText: "",
					});
				}
				inDeletion = false;
				deletionStart = null;
				deletionEnd = null;
			}
			currentLine++;
		}
	}

	// Handle any remaining deletion at the end
	if (inDeletion && deletionStart && deletionEnd) {
		edits.push({
			range: new vscode.Range(deletionStart, deletionEnd),
			newText: "",
		});
	}

	return edits;
}

/**
 * Apply diff hunks to a document
 * This is a robust version that handles edge cases and validates the edits
 */
export async function applyDiffHunkToDocument(
	document: vscode.TextDocument,
	diffHunk: string,
	startLineOffset: number = 0,
	token?: vscode.CancellationToken
): Promise<{ success: boolean; error?: string }> {
	try {
		// Parse the diff hunk into text edits
		const edits = parseDiffHunkToTextEdits(diffHunk, document, startLineOffset);

		if (edits.length === 0) {
			return { success: false, error: "No valid edits found in diff hunk" };
		}

		// Validate edits before applying
		for (const edit of edits) {
			if (token?.isCancellationRequested) {
				return { success: false, error: "" };
			}

			// Check if the range is valid for this document
			if (
				edit.range.start.line >= document.lineCount ||
				edit.range.end.line >= document.lineCount
			) {
				return {
					success: false,
					error: `Edit range out of bounds: ${edit.range.start.line}-${edit.range.end.line} (document has ${document.lineCount} lines)`,
				};
			}
		}

		// Apply the edits
		const editor = await vscode.window.showTextDocument(document);
		await editor.edit(
			(editBuilder) => {
				for (const edit of edits) {
					if (token?.isCancellationRequested) {
						break;
					}
					editBuilder.replace(edit.range, edit.newText);
				}
			},
			{
				undoStopBefore: true,
				undoStopAfter: true,
			}
		);

		return { success: true };
	} catch (error) {
		return {
			success: false,
			error: `Failed to apply diff hunk: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}
}
