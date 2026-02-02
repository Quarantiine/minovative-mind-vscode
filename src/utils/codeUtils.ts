// src/utils/codeUtils.ts
import * as vscode from "vscode";
import { generatePreciseTextEdits } from "../utils/diffingUtils";

export function cleanCodeOutput(codeString: string): string {
	if (!codeString) {
		return "";
	}

	let contentToProcess = codeString;

	// Step 1: Globally remove all Markdown code block fences (```...```) from the extracted content.
	let cleanedStringContent = contentToProcess.replace(
		/^```(?:\S+)?\s*\n?|\n?```$/gm,
		"",
	);

	return cleanedStringContent;
}

export async function applyAITextEdits(
	editor: vscode.TextEditor,
	originalContent: string,
	modifiedContent: string,
	token: vscode.CancellationToken,
): Promise<void> {
	if (token.isCancellationRequested) {
		return;
	}

	if (originalContent === modifiedContent) {
		// No changes, nothing to apply
		return;
	}

	// Generate precise text edits based on the original and modified content
	const preciseEdits = await generatePreciseTextEdits(
		originalContent,
		modifiedContent,
		editor.document,
	);

	if (token.isCancellationRequested) {
		return;
	}

	// --- Visual Feedback Implementation ---

	// 1. Setup Decoration Type for the "Flash" effect
	const flashDecorationType = vscode.window.createTextEditorDecorationType({
		backgroundColor: "rgba(100, 255, 100, 0.2)", // Light green background
		borderRadius: "2px",
		isWholeLine: true,
	});

	// We'll collect all ranges that were modified to apply the flash at the end (or during)
	const modifiedRanges: vscode.Range[] = [];

	// 2. Apply edits sequentially with streaming
	// We sort in reverse order to keep positions valid for upstream edits
	const sortedEdits = preciseEdits.sort((a, b) => {
		return b.range.start.compareTo(a.range.start);
	});

	for (const edit of sortedEdits) {
		if (token.isCancellationRequested) {
			return;
		}

		const isInsertion = edit.range.isEmpty && edit.newText.length > 0;
		const isReplacement = !edit.range.isEmpty && edit.newText.length > 0;
		const isDeletion = !edit.range.isEmpty && edit.newText === "";

		if (isDeletion) {
			// Deletions are instantaneous
			await editor.edit((builder) => {
				builder.replace(edit.range, edit.newText);
			});

			// Calculate line delta for deletion
			const finalLine = edit.range.start.line; // Since content was removed
			const originalEndLine = edit.range.end.line;
			const lineDelta = finalLine - originalEndLine;

			// Deletions can remove lines, so we might need to shift UP (negative delta)
			// However, for deletions we just treat the start point as the remaining point.
			// But wait, if we deleted lines, subsequent edits (which we processed in reverse order? No, we sorted reverse order)
			// We sorted reverse order: b.start.compareTo(a.start)
			// So edits appearing later in the specific file happen towards the top.
			// Wait, if we process from bottom to top, upstream line numbers remain valid for *applying* edits.
			// BUT, for *tracking* ranges for the flash effect, we are collecting ranges.
			// Since we process bottom-up, the ranges we collected *earlier* in this loop are actually *below* the current edit.
			// So when we modify lines here, we need to shift the *previously collected* ranges (which are physically below this edit).

			if (lineDelta !== 0) {
				for (let i = 0; i < modifiedRanges.length; i++) {
					const r = modifiedRanges[i];
					modifiedRanges[i] = new vscode.Range(
						r.start.translate(lineDelta),
						r.end.translate(lineDelta),
					);
				}
			}
			// For deletion we might want to flash the line where deletion happened?
			// The user mainly cares about insertions/changes.
			// Let's add the start line of the deletion to modified ranges so it flashes "something happened here"
			modifiedRanges.push(new vscode.Range(edit.range.start, edit.range.start));
		} else {
			// Insertion or Replacement
			const text = edit.newText;
			const chunkSize = 20; // char chunk size
			const delay = 0; // ms delay

			let insertPos = edit.range.start;

			if (isReplacement) {
				// Clear the existing text first
				await editor.edit((builder) => {
					builder.delete(edit.range);
				});
				// after deletion, start remains valid as the insertion point
			}

			// Stream the insertion
			let currentOffset = 0;
			while (currentOffset < text.length) {
				if (token.isCancellationRequested) {
					break;
				}

				const chunk = text.slice(currentOffset, currentOffset + chunkSize);
				await editor.edit((builder) => {
					builder.insert(insertPos, chunk);
				});

				// Calculate new position for next chunk
				const lines = chunk.split("\n");
				if (lines.length === 1) {
					insertPos = insertPos.translate(0, lines[0].length);
				} else {
					insertPos = new vscode.Position(
						insertPos.line + lines.length - 1,
						lines[lines.length - 1].length,
					);
				}

				currentOffset += chunkSize;
				// Small delay to simulate typing
				await new Promise((resolve) => setTimeout(resolve, delay));
			}

			// Calculate line delta
			// For insertion/replacement:
			// The new end line is insertPos.line
			// The old end line was edit.range.end.line
			const finalLine = insertPos.line;
			const originalEndLine = edit.range.end.line;
			const lineDelta = finalLine - originalEndLine;

			if (lineDelta !== 0) {
				// Shift all previously recorded ranges (which are below this current edit because we iterate in reverse)
				for (let i = 0; i < modifiedRanges.length; i++) {
					const r = modifiedRanges[i];
					modifiedRanges[i] = new vscode.Range(
						r.start.translate(lineDelta),
						r.end.translate(lineDelta),
					);
				}
			}

			// Track range for flash effect
			// From original start (which is preserved/restored) to final insertPos
			modifiedRanges.push(new vscode.Range(edit.range.start, insertPos));
		}
	}

	// 3. Reveal Changes and Apply Flash Effect
	if (modifiedRanges.length > 0) {
		const rangeToReveal = modifiedRanges[modifiedRanges.length - 1]; // This is actually the top-most edit now
		editor.revealRange(rangeToReveal, vscode.TextEditorRevealType.InCenter);

		// Deduplicate lines to prevent opacity stacking
		const distinctLines = new Set<number>();
		for (const r of modifiedRanges) {
			// Because we set isWholeLine: true, we just need to know which lines to highlight.
			// We don't want to add the same line multiple times.
			for (let l = r.start.line; l <= r.end.line; l++) {
				distinctLines.add(l);
			}
		}

		// Convert back to ranges (one range per line)
		const decorationRanges = Array.from(distinctLines).map(
			(l) => new vscode.Range(l, 0, l, 0),
		);

		editor.setDecorations(flashDecorationType, decorationRanges);

		// Fade out after delay
		const timeoutId = setTimeout(() => {
			editor.setDecorations(flashDecorationType, []);
			flashDecorationType.dispose();
			changeSubscription.dispose();
		}, 30000);

		// Smart Flash Removal: Only remove if user edits the flashed lines
		// We need to track the flashed lines as they might shift due to edits above them.
		let currentFlashedLines = Array.from(distinctLines).sort((a, b) => a - b);

		const changeSubscription = vscode.workspace.onDidChangeTextDocument(
			(event) => {
				if (event.document !== editor.document) {
					return;
				}

				// Process changes to check for intersection and update line numbers
				for (const change of event.contentChanges) {
					const rangeStartLine = change.range.start.line;
					const rangeEndLine = change.range.end.line;

					// Check intersection: If any flashed line is within the changed range, remove flash
					// Logic: if flashedLine >= startLine AND flashedLine <= endLine
					const touchesFlash = currentFlashedLines.some(
						(line) => line >= rangeStartLine && line <= rangeEndLine,
					);

					if (touchesFlash) {
						editor.setDecorations(flashDecorationType, []);
						flashDecorationType.dispose();
						clearTimeout(timeoutId);
						changeSubscription.dispose();
						return; // Stop processing
					}

					// If no overlap, we must shift the flashed lines for NEXT comparison
					const linesRemoved = rangeEndLine - rangeStartLine;
					const linesAdded = change.text.split("\n").length - 1;
					const netChange = linesAdded - linesRemoved;

					if (netChange !== 0) {
						currentFlashedLines = currentFlashedLines.map((line) => {
							// Only shifts lines that are physically below the change
							if (line > rangeEndLine) {
								return line + netChange;
							}
							return line;
						});
					}
				}
			},
		);
	}
}
