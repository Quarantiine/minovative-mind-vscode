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
	});

	// We'll collect all ranges that were modified to apply the flash at the end (or during)
	const modifiedRanges: vscode.Range[] = [];

	// 2. Apply edits sequentially with streaming
	// We sort in reverse order to keep positions valid for upstream edits
	const sortedEdits = preciseEdits.sort((a, b) => {
		return b.range.start.compareTo(a.range.start);
	});

	for (const edit of sortedEdits) {
		if (token.isCancellationRequested) return;

		const isInsertion = edit.range.isEmpty && edit.newText.length > 0;
		const isReplacement = !edit.range.isEmpty && edit.newText.length > 0;
		const isDeletion = !edit.range.isEmpty && edit.newText === "";

		if (isDeletion) {
			// Deletions are instantaneous
			await editor.edit((builder) => {
				builder.replace(edit.range, edit.newText);
			});
		} else {
			// Insertion or Replacement
			const text = edit.newText;
			const chunkSize = 15; // char chunk size
			const delay = 15; // ms delay

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
				if (token.isCancellationRequested) break;

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

			// Track range for flash effect
			// From original start (which is preserved/restored) to final insertPos
			modifiedRanges.push(new vscode.Range(edit.range.start, insertPos));
		}
	}

	// 3. Reveal Changes and Apply Flash Effect
	if (modifiedRanges.length > 0) {
		const rangeToReveal = modifiedRanges[modifiedRanges.length - 1];
		editor.revealRange(rangeToReveal, vscode.TextEditorRevealType.InCenter);

		editor.setDecorations(flashDecorationType, modifiedRanges);

		// Fade out after delay
		setTimeout(() => {
			editor.setDecorations(flashDecorationType, []);
			flashDecorationType.dispose();
		}, 20000);
	}
}
