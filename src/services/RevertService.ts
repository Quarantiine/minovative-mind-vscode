import * as vscode from "vscode";
import * as path from "path";
import { ProjectChangeLogger } from "../workflow/ProjectChangeLogger";
import { FileChangeEntry } from "../types/workflow";
import { showErrorNotification } from "../utils/notificationUtils";
import { applyAITextEdits } from "../utils/codeUtils";
import { generateFileChangeSummary, applyPatch } from "../utils/diffingUtils";

export class RevertService {
	private readonly workspaceRootUri: vscode.Uri;
	private readonly projectChangeLogger: ProjectChangeLogger;

	constructor(
		workspaceRootUri: vscode.Uri,
		projectChangeLogger: ProjectChangeLogger
	) {
		this.workspaceRootUri = workspaceRootUri;
		this.projectChangeLogger = projectChangeLogger;
	}

	/**
	 * Reverts a list of file changes recorded by the ProjectChangeLogger.
	 * This operation attempts to undo 'created', 'modified', and 'deleted' changes.
	 *
	 * IMPORTANT ASSUMPTION for 'modified' and 'deleted' changes:
	 * This service assumes that for 'modified' and 'deleted' changes, the `originalContent` field in `FileChangeEntry`
	 * represents the *entire content* of the file prior to the change. This content will be used to restore or recreate the file.
	 * If `FileChangeEntry` does not store the full original content, this revert might be incomplete.
	 *
	 * @param changes An array of FileChangeEntry objects to revert.
	 * @returns A Promise that resolves when all changes have been processed.
	 */
	public async revertChanges(changes: FileChangeEntry[]): Promise<void> {
		if (!this.workspaceRootUri) {
			showErrorNotification(
				new Error("Workspace root URI not found."),
				"Cannot revert changes: No workspace folder is currently open.",
				"Revert Failed: "
			);
			throw new Error(
				"Revert operation failed: Workspace root URI is undefined."
			);
		}

		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: "Minovative Mind: Reverting Changes",
				cancellable: false, // Revert operation typically not cancellable by user in notification
			},
			async (progress, token) => {
				const totalChanges = changes.length;
				let processedChanges = 0;

				changes.reverse(); // Process changes in reverse chronological order

				for (const change of changes) {
					if (token.isCancellationRequested) {
						showErrorNotification(
							new Error("Operation cancelled by user."),
							"Revert operation cancelled.",
							"Revert Cancelled: "
						);
						break;
					}

					const fileUri = vscode.Uri.joinPath(
						this.workspaceRootUri,
						change.filePath
					);
					const relativePath = path.relative(
						this.workspaceRootUri.fsPath,
						fileUri.fsPath
					);
					let revertSummary = "";

					progress.report({
						message: `Reverting ${relativePath}...`,
						increment: (1 / totalChanges) * 100,
					});

					try {
						switch (change.changeType) {
							case "created":
								// Reverting a "created" file means deleting it.
								try {
									const fileStat = await vscode.workspace.fs.stat(fileUri);

									if (fileStat.type === vscode.FileType.Directory) {
										const error = new Error(
											`Attempted to delete a directory entry during revert (created file log points to a directory). Aborting deletion of: ${relativePath}`
										);
										console.error(
											`[RevertService] CRITICAL SAFETY WARNING: ${error.message}`
										);
										// showErrorNotification(
										// 	error,
										// 	`Revert blocked: Attempted to delete directory '${relativePath}'. Please clean up manually if necessary.`,
										// 	"Revert Safety Block: "
										// );
										revertSummary = `Skipped revert: Attempted deletion of directory '${relativePath}'.`;
										break; // Skip deletion if it's a directory
									}

									// If it's a file, proceed with non-recursive deletion
									await vscode.workspace.fs.delete(fileUri, {
										useTrash: true,
										recursive: false, // Prevent accidental mass deletion
									});
									revertSummary = `Reverted creation: Deleted file '${relativePath}' (moved to trash).`;
									// Log the revert action as a 'deleted' entry in the logger.
									this.projectChangeLogger.logChange({
										filePath: change.filePath,
										changeType: "deleted",
										summary: revertSummary,
										timestamp: Date.now(),
									});
								} catch (error: any) {
									if (
										error instanceof vscode.FileSystemError &&
										(error.code === "FileNotFound" ||
											error.code === "EntryNotFound")
									) {
										console.warn(
											`[RevertService] File not found for deletion (already gone?): ${relativePath}`
										);
										revertSummary = `Reverted creation: File '${relativePath}' was already gone.`;
									} else {
										throw error; // Re-throw other errors
									}
								}
								break;

							case "modified": {
								// Reverting a "modified" file means restoring its original content.
								let document: vscode.TextDocument;
								let editor: vscode.TextEditor;
								let currentContent: string = "";

								try {
									document = await vscode.workspace.openTextDocument(fileUri);
									editor = await vscode.window.showTextDocument(document);
									currentContent = editor.document.getText();
								} catch (docError: any) {
									if (
										docError instanceof vscode.FileSystemError &&
										(docError.code === "FileNotFound" ||
											docError.code === "EntryNotFound")
									) {
										// If the modified file no longer exists, we must fall back to originalContent.
										if (!change.originalContent) {
											console.warn(
												`[RevertService] Skipping revert for missing modified file '${relativePath}': No 'originalContent' available.`
											);
											revertSummary = `Skipped revert for missing modified '${relativePath}': No original content found.`;
											break;
										}
										console.warn(
											`[RevertService] Modified file '${relativePath}' not found, attempting to recreate with assumed original content.`
										);
										const parentDir = vscode.Uri.file(
											path.dirname(fileUri.fsPath)
										);
										try {
											await vscode.workspace.fs.createDirectory(parentDir);
										} catch (dirError: any) {
											if (
												!(
													dirError instanceof vscode.FileSystemError &&
													dirError.code === "FileExists"
												)
											) {
												throw dirError; // Re-throw if it's not just "directory already exists"
											}
										}
										await vscode.workspace.fs.writeFile(
											fileUri,
											Buffer.from(change.originalContent)
										);
										revertSummary = `Reverted modification: Recreated missing '${relativePath}' with original content.`;

										const { formattedDiff, summary } =
											await generateFileChangeSummary(
												"",
												change.originalContent,
												change.filePath
											);
										this.projectChangeLogger.logChange({
											filePath: change.filePath,
											changeType: "created", // Logged as created because it was missing and now exists
											summary: summary,
											timestamp: Date.now(),
											diffContent: formattedDiff,
										});
										break; // Done with this change
									}
									throw docError; // Re-throw other errors
								}

								let contentToRestore: string | undefined;

								// Prioritize using the inverse patch if it exists, as it's more precise.
								if (change.inversePatch) {
									try {
										contentToRestore = applyPatch(
											currentContent,
											change.inversePatch
										);
									} catch (patchError: any) {
										console.warn(
											`[RevertService] Failed to apply inverse patch for '${relativePath}'. Falling back to originalContent. Error: ${patchError.message}`
										);
										// Fallback to originalContent if patch fails
										contentToRestore = change.originalContent;
									}
								} else {
									// Fallback for older change entries without an inverse patch.
									contentToRestore = change.originalContent;
								}

								if (contentToRestore === undefined) {
									console.warn(
										`[RevertService] Skipping revert for modified file '${relativePath}': No content available to restore.`
									);
									revertSummary = `Skipped revert for modified '${relativePath}': No original content found.`;
									break;
								}

								// Apply the edits to restore content using applyAITextEdits
								await applyAITextEdits(
									editor,
									currentContent,
									contentToRestore,
									token
								);

								const newContent = editor.document.getText();
								const { formattedDiff, summary } =
									await generateFileChangeSummary(
										currentContent,
										newContent,
										change.filePath
									);
								revertSummary = `Reverted modification: Restored original content for '${relativePath}'`;

								// Log the revert action as a 'modified' entry in the logger
								this.projectChangeLogger.logChange({
									filePath: change.filePath,
									changeType: "modified",
									summary: summary,
									timestamp: Date.now(),
									diffContent: formattedDiff,
									originalContent: currentContent, // The state before the revert
									newContent: newContent, // The state after the revert (restored state)
								});
								break;
							}

							case "deleted": {
								// Reverting a "deleted" file means recreating it with its original content.
								// We assume `change.originalContent` holds the *entire* content before deletion.
								if (!change.originalContent) {
									console.warn(
										`[RevertService] Skipping revert for deleted file '${relativePath}': No 'originalContent' available to recreate content.`
									);
									revertSummary = `Skipped revert for deleted '${relativePath}': No content found to recreate.`;
									break;
								}
								const contentToRecreate = change.originalContent;

								try {
									// Check if file already exists to prevent accidental overwrite or conflicts.
									await vscode.workspace.fs.stat(fileUri);
									console.warn(
										`[RevertService] File '${relativePath}' already exists when attempting to revert deletion. Skipping recreation.`
									);
									revertSummary = `Skipped revert for deleted '${relativePath}': File already exists.`;
									break; // Skip if file already exists
								} catch (error: any) {
									if (
										error instanceof vscode.FileSystemError &&
										(error.code === "FileNotFound" ||
											error.code === "EntryNotFound")
									) {
										// File does not exist, proceed with recreation
										const parentDir = vscode.Uri.file(
											path.dirname(fileUri.fsPath)
										);
										try {
											await vscode.workspace.fs.createDirectory(parentDir);
										} catch (dirError: any) {
											if (
												!(
													dirError instanceof vscode.FileSystemError &&
													dirError.code === "FileExists"
												)
											) {
												throw dirError; // Re-throw if it's not just "directory already exists"
											}
										}
										await vscode.workspace.fs.writeFile(
											fileUri,
											Buffer.from(contentToRecreate)
										);
										revertSummary = `Reverted deletion: Recreated '${relativePath}'.`;

										const { formattedDiff, summary } =
											await generateFileChangeSummary(
												"",
												contentToRecreate,
												change.filePath
											);
										this.projectChangeLogger.logChange({
											filePath: change.filePath,
											changeType: "created", // Logged as created because it was missing and now exists
											summary: summary,
											timestamp: Date.now(),
											diffContent: formattedDiff,
										});
									} else {
										throw error; // Re-throw other errors
									}
								}
								break;
							}
							default:
								console.warn(
									`[RevertService] Skipping unknown or unsupported change type: ${change.changeType} for ${relativePath}`
								);
								revertSummary = `Skipped unknown change type '${change.changeType}' for '${relativePath}'.`;
								break;
						}

						// Report general progress for the step (message updated)
						progress.report({ message: `Reverted: ${relativePath}` });
					} catch (error: any) {
						const errorMessage = `Failed to revert '${relativePath}': ${
							error.message || String(error)
						}`;
						console.error(`[RevertService] ${errorMessage}`, error);
						showErrorNotification(
							error,
							`An error occurred while reverting changes for '${relativePath}'.`,
							`Revert Error: `,
							this.workspaceRootUri
						);
						// Continue to the next change even if one fails
					}
					processedChanges++;
				}
				progress.report({
					message: "Revert operation complete.",
					increment: 100,
				});
			}
		);
	}
}
