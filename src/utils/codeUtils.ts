// src/utils/codeUtils.ts
import * as vscode from "vscode";
import * as path from "path";
import { generatePreciseTextEdits } from "../utils/diffingUtils";
import { DiffContentProvider } from "../providers/diffContentProvider";

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

	// --- Store original content for diff view BEFORE applying edits ---
	const filePath = editor.document.uri.fsPath;
	const diffProvider = DiffContentProvider.getInstance();
	diffProvider.setOriginalContent(filePath, originalContent);

	// --- Visual Feedback Implementation ---

	// 1. Setup Decoration Type for the "Flash" effect
	const flashDecorationType = vscode.window.createTextEditorDecorationType({
		backgroundColor: "rgba(100, 255, 100, 0.2)", // Light green background
		borderRadius: "2px",
		isWholeLine: true,
	});

	// We'll collect all ranges that were modified to apply the flash at the end (or during)
	const modifiedRanges: vscode.Range[] = [];

	// 2. Apply edits in a single transaction
	// We sort ASCENDING to make line delta calculation for the final document helper
	const sortedEdits = preciseEdits.sort((a, b) => {
		return a.range.start.compareTo(b.range.start);
	});

	let lineDelta = 0;

	await editor.edit((builder) => {
		for (const edit of sortedEdits) {
			// Apply edit (VS Code handles original coordinates within the transaction)
			builder.replace(edit.range, edit.newText);

			// --- Calculate Final Range for Flash Effect ---

			// 1. Calculate how many lines this edit adds/removes
			const newLines = edit.newText.split("\n");
			const textAddedHeight = newLines.length - 1;
			const textRemovedHeight = edit.range.end.line - edit.range.start.line;

			// 2. Determine the start line in the FINAL document
			// It is the original start line + all accumulated shifts from previous edits
			const finalStartLine = edit.range.start.line + lineDelta;

			// 3. Determine the end line in the FINAL document
			const finalEndLine =
				finalStartLine + (textAddedHeight > 0 ? textAddedHeight : 0);

			// 4. Push the range representing this change in the FINAL document
			// We only care about lines for the "isWholeLine" decoration
			modifiedRanges.push(new vscode.Range(finalStartLine, 0, finalEndLine, 0));

			// 5. Update global delta for the next edit (which is below this one)
			lineDelta += textAddedHeight - textRemovedHeight;
		}
	});

	// 3. Reveal Changes and Apply Flash Effect
	if (modifiedRanges.length > 0) {
		const rangeToReveal = modifiedRanges[modifiedRanges.length - 1];
		editor.revealRange(rangeToReveal, vscode.TextEditorRevealType.InCenter);

		// Deduplicate lines to prevent opacity stacking
		const distinctLines = new Set<number>();
		for (const r of modifiedRanges) {
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
		let currentFlashedLines = Array.from(distinctLines).sort((a, b) => a - b);

		const changeSubscription = vscode.workspace.onDidChangeTextDocument(
			(event) => {
				if (event.document !== editor.document) {
					return;
				}

				for (const change of event.contentChanges) {
					const rangeStartLine = change.range.start.line;
					const rangeEndLine = change.range.end.line;

					const touchesFlash = currentFlashedLines.some(
						(line) => line >= rangeStartLine && line <= rangeEndLine,
					);

					if (touchesFlash) {
						editor.setDecorations(flashDecorationType, []);
						flashDecorationType.dispose();
						clearTimeout(timeoutId);
						changeSubscription.dispose();
						return;
					}

					const linesRemoved = rangeEndLine - rangeStartLine;
					const linesAdded = change.text.split("\n").length - 1;
					const netChange = linesAdded - linesRemoved;

					if (netChange !== 0) {
						currentFlashedLines = currentFlashedLines.map((line) => {
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

	// --- 4. Open Native Diff Editor (Before vs After) ---
	if (!token.isCancellationRequested) {
		try {
			const originalUri = diffProvider.getOriginalUri(filePath);
			const modifiedUri = editor.document.uri;
			const fileName = path.basename(filePath);
			const diffTitle = `${fileName} (Before AI Edit ↔ After AI Edit)`;

			await vscode.commands.executeCommand(
				"vscode.diff",
				originalUri,
				modifiedUri,
				diffTitle,
				{ preview: true } as vscode.TextDocumentShowOptions,
			);

			// Auto-close diff after 60 seconds and clean up stored content
			const diffCleanupTimeout = setTimeout(() => {
				diffProvider.clearOriginalContent(filePath);
				diffChangeSubscription.dispose();
			}, 60000);

			// Also clean up if user starts editing the file (diff becomes stale)
			const diffChangeSubscription = vscode.workspace.onDidChangeTextDocument(
				(event) => {
					if (
						event.document.uri.fsPath === filePath &&
						event.contentChanges.length > 0
					) {
						diffProvider.clearOriginalContent(filePath);
						clearTimeout(diffCleanupTimeout);
						diffChangeSubscription.dispose();
					}
				},
			);
		} catch (error) {
			// Non-critical: log but don't interrupt the edit workflow
			console.warn(
				`[Minovative Mind] Failed to open diff editor: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}
