/**
 * @file This utility file provides functions for generating and analyzing diffs between code snippets,
 * and applying those diffs as precise text edits within a VS Code document.
 * It leverages the `diff-match-patch` library for efficient diffing and includes
 * functionalities for summarizing file changes, analyzing the reasonableness of modifications,
 * and parsing/applying standard diff hunks.
 */
import * as vscode from "vscode";
import { diff_match_patch } from "diff-match-patch";
import { DiffAnalysis } from "../types/codeGenerationTypes";

/**
 * Generates an array of precise VS Code TextEdits representing the differences
 * between an original content string and a modified content string.
 * This function uses a character-by-character diff algorithm to identify
 * insertions, deletions, and equalities, translating them into `vscode.Range`
 * and `newText` objects suitable for applying to a `vscode.TextDocument`.
 *
 * @param originalContent The full original content of the document as a string.
 * @param modifiedContent The full modified content as a string, which will be diffed against `originalContent`.
 * @param document The `vscode.TextDocument` object representing the file to which edits will be applied.
 *                 This is used to correctly map character offsets to `vscode.Position` objects.
 * @returns A promise that resolves to an array of objects, each containing a `vscode.Range`
 *          and a `newText` string. An empty `newText` signifies a deletion.
 */
export async function generatePreciseTextEdits(
	originalContent: string,
	modifiedContent: string,
	document: vscode.TextDocument
): Promise<{ range: vscode.Range; newText: string }[]> {
	const dmp = new diff_match_patch();

	const diffs = dmp.diff_main(originalContent, modifiedContent);

	const edits: { range: vscode.Range; newText: string }[] = [];
	let originalPosOffset = 0;

	for (const diff of diffs) {
		const [type, text] = diff;

		if (type === diff_match_patch.DIFF_EQUAL) {
			// Text is present in both original and modified. No edit is needed.
			originalPosOffset += text.length;
		} else if (type === diff_match_patch.DIFF_INSERT) {
			// Text was added in the modified content. Insert this text.
			const startPos = document.positionAt(originalPosOffset);
			const endPos = document.positionAt(originalPosOffset); // Insertion point
			edits.push({
				range: new vscode.Range(startPos, endPos),
				newText: text,
			});
			// originalPosOffset does not advance for insertions.
		} else if (type === diff_match_patch.DIFF_DELETE) {
			// Text was removed from the original content. Delete this text.
			const startPos = document.positionAt(originalPosOffset);
			const endPos = document.positionAt(originalPosOffset + text.length);
			edits.push({
				range: new vscode.Range(startPos, endPos),
				newText: "", // Empty string signifies deletion
			});
			// originalPosOffset advances by the length of the deleted text.
			originalPosOffset += text.length;
		}
	}

	return edits;
}

/**
 * Generates a comprehensive summary of changes between two versions of a file's content.
 * This includes a human-readable summary message, lists of added and removed lines,
 * and a formatted diff string. It also attempts to identify and categorize
 * modified, added, and removed code entities (functions, classes, variables, etc.).
 *
 * @param oldContent The original content of the file.
 * @param newContent The modified content of the file.
 * @param filePath The path of the file being summarized, used for context in the summary message.
 * @returns A promise that resolves to an object containing:
 *          - `summary`: A concise string describing the changes, including entity modifications and line counts.
 *          - `addedLines`: An array of strings, each representing a line added in the new content.
 *          - `removedLines`: An array of strings, each representing a line removed from the old content.
 *          - `formattedDiff`: A string representing the diff in a standard `+`/`-` format, excluding equal lines.
 */
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

	// Convert content to character-based representation for efficient line-level diffing.
	const lineDiffResult = dmp.diff_linesToChars_(oldContent, newContent);
	const {
		chars1: text1_chars,
		chars2: text2_chars,
		lineArray: line_array,
	} = lineDiffResult;

	// Perform the diff on character representations.
	let diffs = dmp.diff_main(text1_chars, text2_chars, false);

	// Convert character-level diffs back to line-level and apply semantic cleanup.
	dmp.diff_charsToLines_(diffs, line_array);
	dmp.diff_cleanupSemantic(diffs);

	let formattedDiffLines: string[] = [];
	let addedLines: string[] = [];
	let removedLines: string[] = [];

	for (const diff of diffs) {
		const [type, text] = diff;

		const lines = text.split("\n");
		// Filter out empty strings that result from a trailing newline or initial empty `text`
		const effectiveLines =
			text === "" && lines.length === 1 && lines[0] === "" ? [] : lines;

		if (type === diff_match_patch.DIFF_INSERT) {
			addedLines.push(...effectiveLines.filter((line) => line !== ""));
			effectiveLines.forEach((line) => formattedDiffLines.push(`+ ${line}`));
		} else if (type === diff_match_patch.DIFF_DELETE) {
			removedLines.push(...effectiveLines.filter((line) => line !== ""));
			effectiveLines.forEach((line) => formattedDiffLines.push(`- ${line}`));
		}
		// For DIFF_EQUAL, we intentionally don't add to formattedDiffLines to keep the diff concise.
	}

	const formattedDiff = formattedDiffLines.join("\n");
	const addedContentFlat = addedLines.join("\n");
	const removedContentFlat = removedLines.join("\n");

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

		// Helper to check if a name is already captured as a function/method to avoid double counting
		const isFunctionName = (name: string): boolean => {
			return (
				(targetMap.get("function")?.includes(name) ||
					targetMap.get("method")?.includes(name)) ??
				false
			);
		};

		const functionRegex =
			/(?:(?:export|declare)\s+)?(?:async\s+)?function\s+(\w+)\s*\(|(?:\b(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)\s*=>|function\s*\(|$))|(?:\b(?:public|private|protected|static|async)?\s*(\w+)\s*\([^)]*\)\s*\{)/g;
		while ((match = functionRegex.exec(content)) !== null) {
			const name = match[1] || match[2] || match[3];
			if (name) {
				addEntity(match[3] ? "method" : "function", name);
			}
		}
		functionRegex.lastIndex = 0;

		const classRegex = /(?:(?:export|declare)\s+)?class\s+(\w+)/g;
		while ((match = classRegex.exec(content)) !== null) {
			const name = match[1];
			if (name) {
				addEntity("class", name);
			}
		}
		classRegex.lastIndex = 0;

		const variableRegex =
			/(?:(?:export|declare)\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?!async\s+)(?!function\s*)[^;,\n]*;?\s*(?:\n|$)/g;
		while ((match = variableRegex.exec(content)) !== null) {
			const name = match[1];
			if (name && !isFunctionName(name)) {
				addEntity("variable", name);
			}
		}
		variableRegex.lastIndex = 0;

		const interfaceTypeAliasRegex =
			/(?:(?:export|declare)\s+)?(?:interface|type)\s+(\w+)/g;
		while ((match = interfaceTypeAliasRegex.exec(content)) !== null) {
			const name = match[1];
			if (name) {
				addEntity("type/interface", name);
			}
		}
		interfaceTypeAliasRegex.lastIndex = 0;

		const enumRegex = /(?:(?:export|declare)\s+)?enum\s+(\w+)/g;
		while ((match = enumRegex.exec(content)) !== null) {
			const name = match[1];
			if (name) {
				addEntity("enum", name);
			}
		}
		enumRegex.lastIndex = 0;

		const importLineRegex = /^\s*import\s+\S/gm;
		let importStatementCount = 0;
		while ((match = importLineRegex.exec(content)) !== null) {
			importStatementCount++;
		}
		if (importStatementCount > 0) {
			addEntity("import statement", `(${importStatementCount})`);
		}
		importLineRegex.lastIndex = 0;

		const exportLineRegex = /^\s*export\s+\S/gm;
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

	// Helper function to categorize entities as added, removed, or modified
	const getProcessedEntities = (
		added: Map<string, string[]>,
		removed: Map<string, string[]>,
		type: "added" | "removed" | "modified"
	): Map<string, string[]> => {
		const result = new Map<string, string[]>();

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

	const formatGroup = (prefix: string, groupedMap: Map<string, string[]>) => {
		const entries: string[] = [];
		for (const [type, names] of groupedMap.entries()) {
			if (names.length === 0) {
				continue;
			}

			const formattedNames = names.map((name) => `\`${name}\``).join(", ");
			let typeDisplay = type;
			if (names.length > 1 && !type.endsWith("s")) {
				if (type.endsWith("statement")) {
					typeDisplay += "s";
				} else {
					typeDisplay += "s";
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

	const addedLineCount = addedLines.length;
	const removedLineCount = removedLines.length;

	if (finalSummary === "") {
		if (addedLineCount > 0 && removedLineCount === 0) {
			finalSummary = "added new content";
		} else if (removedLineCount > 0 && addedLineCount === 0) {
			finalSummary = "removed content";
		} else if (addedLineCount > 0 && removedLineCount > 0) {
			if (addedLineCount + removedLineCount > 10) {
				finalSummary = "major changes detected";
			} else {
				finalSummary = "modified existing content";
			}
		} else {
			finalSummary = "no significant changes";
		}
	}

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

	const summaryWithFilePath = `${filePath}: ${finalSummary}${quantitativeSummary}`;

	return {
		summary: summaryWithFilePath,
		addedLines: addedLines,
		removedLines: removedLines,
		formattedDiff: formattedDiff,
	};
}

/**
 * Analyzes the diff between two content strings (original and modified) to provide
 * insights into the nature and reasonableness of the changes. It calculates a change ratio
 * and identifies potential issues, such as a large proportion of content being changed
 * or all import statements being removed.
 *
 * @param original The original content string.
 * @param modified The modified content string.
 * @returns An object of type `DiffAnalysis` containing:
 *          - `isReasonable`: A boolean indicating whether the changes appear reasonable based on heuristics.
 *          - `issues`: An array of strings describing any identified issues with the changes.
 *          - `changeRatio`: A number representing the ratio of lines changed relative to the original content length.
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
 * Parses a standard Git-style diff hunk (e.g., lines starting with '+', '-', or ' ')
 * and converts it into an array of VS Code `TextEdit` objects. This function correctly
 * handles additions, deletions, and context lines, applying them to the appropriate
 * positions within a `vscode.TextDocument`.
 *
 * @param diffHunk The string content of a single diff hunk, typically starting with `@@ -l,s +l,s @@`.
 * @param document The `vscode.TextDocument` object to which these edits conceptually apply.
 *                 This is used to resolve positions correctly.
 * @param startLineOffset The starting line number in the `document` where the hunk is considered to begin.
 *                        This helps in correctly mapping hunk lines to document lines. Defaults to 0.
 * @returns An array of objects, each containing a `vscode.Range` and a `newText` string.
 *          An empty `newText` signifies a deletion within the specified range.
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

	for (const line of lines) {
		if (line.startsWith("+")) {
			// Addition: insert new text at the current line position.
			const newText = line.substring(1) + "\n";
			const insertPos = document.positionAt(
				document.offsetAt(new vscode.Position(currentLine, 0))
			);

			edits.push({
				range: new vscode.Range(insertPos, insertPos),
				newText: newText,
			});
			// currentLine does not increment for insertions as they don't consume original lines.
		} else if (line.startsWith("-")) {
			// Deletion: mark the beginning of a deletion range if not already in one.
			if (!inDeletion) {
				deletionStart = document.positionAt(
					document.offsetAt(new vscode.Position(currentLine, 0))
				);
				inDeletion = true;
			}
			// For deletions, we consume an original line.
			currentLine++;
		} else {
			// Context line or unchanged line: If a deletion was in progress, finalize it.
			if (inDeletion && deletionStart) {
				// The deletion ends before the current context line.
				const deletionEnd = document.positionAt(
					document.offsetAt(new vscode.Position(currentLine, 0))
				);
				edits.push({
					range: new vscode.Range(deletionStart, deletionEnd),
					newText: "",
				});
				inDeletion = false;
				deletionStart = null;
			}
			// For context lines, we consume an original line.
			currentLine++;
		}
	}

	// Handle any remaining deletion at the end of the hunk.
	if (inDeletion && deletionStart) {
		const deletionEnd = document.positionAt(
			document.offsetAt(new vscode.Position(currentLine, 0))
		);
		edits.push({
			range: new vscode.Range(deletionStart, deletionEnd),
			newText: "",
		});
	}

	return edits;
}

/**
 * Applies a given diff hunk to a `vscode.TextDocument` as a series of text edits.
 * This function parses the diff hunk into VS Code `TextEdit` objects and then
 * applies them to the active editor. It includes validation to ensure that the
 * proposed edit ranges are within the document bounds and supports cancellation.
 *
 * @param document The `vscode.TextDocument` to which the diff hunk will be applied.
 * @param diffHunk The string content of the diff hunk to apply.
 * @param startLineOffset The starting line number in the `document` where the hunk is considered to begin.
 *                        This helps in correctly mapping hunk lines to document lines. Defaults to 0.
 * @param token An optional `vscode.CancellationToken` to allow for early cancellation of the operation.
 * @returns A promise that resolves to an object indicating the success or failure of the operation:
 *          - `success`: A boolean, `true` if the edits were applied successfully, `false` otherwise.
 *          - `error`: An optional string containing an error message if the operation failed.
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
				return { success: false, error: "Operation cancelled." };
			}

			// Check if the range is valid for this document
			if (
				edit.range.start.line > document.lineCount ||
				(edit.range.end.line > document.lineCount &&
					edit.range.start.line !== edit.range.end.line)
			) {
				// An insertion can happen at document.lineCount (end of file)
				// A deletion range ending at document.lineCount (exclusive of next line) is also valid
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
