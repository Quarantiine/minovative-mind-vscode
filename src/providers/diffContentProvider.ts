// src/providers/diffContentProvider.ts
import * as vscode from "vscode";

/**
 * A TextDocumentContentProvider that serves original (pre-edit) file content
 * via the `minovative-diff` URI scheme. This enables VS Code's native diff editor
 * to compare the original content against the modified file on disk.
 *
 * Usage:
 *   1. Call `setOriginalContent(filePath, content)` before applying edits.
 *   2. Use `getOriginalUri(filePath)` to get the virtual URI for the diff command.
 *   3. After the diff is no longer needed, call `clearOriginalContent(filePath)`.
 *
 * URI format: `minovative-diff:/{filePath}?ts={timestamp}`
 */
export class DiffContentProvider implements vscode.TextDocumentContentProvider {
	private static _instance: DiffContentProvider;

	/**
	 * In-memory store mapping file paths to their original (pre-edit) content snapshots.
	 */
	private _originalContentMap = new Map<string, string>();

	/**
	 * Event emitter to notify VS Code when virtual document content has changed.
	 */
	private _onDidChange = new vscode.EventEmitter<vscode.Uri>();

	/** Fired when the content of a virtual document has changed. */
	public readonly onDidChange = this._onDidChange.event;

	/** The URI scheme used by this provider. */
	public static readonly scheme = "minovative-diff";

	private constructor() {}

	/**
	 * Returns the singleton instance of the provider.
	 */
	public static getInstance(): DiffContentProvider {
		if (!DiffContentProvider._instance) {
			DiffContentProvider._instance = new DiffContentProvider();
		}
		return DiffContentProvider._instance;
	}

	/**
	 * Stores a snapshot of the original file content before AI edits are applied.
	 * @param filePath Absolute path to the file being edited.
	 * @param content The original file content before any modifications.
	 */
	public setOriginalContent(filePath: string, content: string): void {
		this._originalContentMap.set(filePath, content);
	}

	/**
	 * Removes the stored original content for a file (cleanup after diff is viewed).
	 * @param filePath Absolute path to the file.
	 */
	public clearOriginalContent(filePath: string): void {
		this._originalContentMap.delete(filePath);
	}

	/**
	 * Constructs a virtual URI that VS Code will use to request the original file content
	 * from this provider. A timestamp query parameter ensures the URI is unique per snapshot.
	 *
	 * @param filePath Absolute path to the file being diffed.
	 * @returns A `minovative-diff:` scheme URI.
	 */
	public getOriginalUri(filePath: string): vscode.Uri {
		return vscode.Uri.parse(
			`${DiffContentProvider.scheme}:${filePath}?ts=${Date.now()}`,
		);
	}

	/**
	 * Called by VS Code when it needs the content for a virtual document under this scheme.
	 * Returns the stored original content snapshot for the given file path.
	 *
	 * @param uri The virtual document URI.
	 * @returns The original file content, or an empty string if no snapshot exists.
	 */
	public provideTextDocumentContent(uri: vscode.Uri): string {
		// The path portion of the URI is the original file path
		const filePath = uri.path;
		return this._originalContentMap.get(filePath) ?? "";
	}

	/**
	 * Disposes of all stored content and event emitters.
	 */
	public dispose(): void {
		this._originalContentMap.clear();
		this._onDidChange.dispose();
	}
}
