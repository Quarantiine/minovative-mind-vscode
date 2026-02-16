import * as vscode from "vscode";
import {
	HistoryEntry,
	ChatMessage,
	UpdateRelevantFilesDisplayMessage,
	HistoryEntryPart,
	ImageInlineData,
	ChatSessionMetadata,
} from "../common/sidebarTypes";
import { v4 as uuidv4 } from "uuid";

const CHAT_HISTORY_STORAGE_KEY = "minovativeMindChatHistory"; // Legacy key
const SESSIONS_METADATA_KEY = "minovativeMindChatSessions";
const CURRENT_SESSION_ID_KEY = "minovativeMindCurrentSessionId";
const HISTORY_KEY_PREFIX = "minovativeMindChatHistory_";
const MAX_HISTORY_ITEMS = 100;

export class ChatHistoryManager {
	private _chatHistory: HistoryEntry[] = [];
	private _sessions: ChatSessionMetadata[] = [];
	private _currentSessionId: string | null = null;
	private _workspaceState: vscode.Memento;

	constructor(
		workspaceState: vscode.Memento,
		private readonly postMessageToWebview: (message: any) => void,
	) {
		this._workspaceState = workspaceState;
		this.initializeSessions();
	}

	public getChatHistory(): readonly HistoryEntry[] {
		return this._chatHistory;
	}

	public getSessions(): readonly ChatSessionMetadata[] {
		return this._sessions;
	}

	public getCurrentSessionId(): string | null {
		return this._currentSessionId;
	}

	private async initializeSessions(): Promise<void> {
		await this.loadSessionsMetadata();
		const legacyHistory = this._workspaceState.get<string>(
			CHAT_HISTORY_STORAGE_KEY,
		);

		if (legacyHistory && this._sessions.length === 0) {
			console.log("Migrating legacy chat history to new session storage.");
			const defaultSessionId = uuidv4();
			const defaultSession: ChatSessionMetadata = {
				id: defaultSessionId,
				name: "Default Session",
				lastModified: Date.now(),
			};
			this._sessions = [defaultSession];
			this._currentSessionId = defaultSessionId;
			await this.saveSessionsMetadata();
			await this._workspaceState.update(CHAT_HISTORY_STORAGE_KEY, undefined);
			await this._workspaceState.update(
				HISTORY_KEY_PREFIX + defaultSessionId,
				legacyHistory,
			);
		}

		if (this._sessions.length === 0) {
			await this.createNewSession("New Chat");
		} else {
			this._currentSessionId =
				this._workspaceState.get<string>(CURRENT_SESSION_ID_KEY) ||
				this._sessions[0].id;
			// Ensure currentSessionId is valid
			if (!this._sessions.find((s) => s.id === this._currentSessionId)) {
				this._currentSessionId = this._sessions[0].id;
			}
		}

		await this.loadHistoryFromStorage();
	}

	private async loadSessionsMetadata(): Promise<void> {
		this._sessions = this._workspaceState.get<ChatSessionMetadata[]>(
			SESSIONS_METADATA_KEY,
			[],
		);
	}

	private async saveSessionsMetadata(): Promise<void> {
		await this._workspaceState.update(SESSIONS_METADATA_KEY, this._sessions);
	}

	public async createNewSession(name: string = "New Chat"): Promise<string> {
		const id = uuidv4();
		const newSession: ChatSessionMetadata = {
			id,
			name,
			lastModified: Date.now(),
		};
		this._sessions.unshift(newSession);
		this._currentSessionId = id;
		this._chatHistory = [];
		await this.saveSessionsMetadata();
		await this._workspaceState.update(CURRENT_SESSION_ID_KEY, id);
		await this.saveHistoryToStorage();
		this.restoreChatHistoryToWebview();
		return id;
	}

	public async switchSession(sessionId: string): Promise<void> {
		if (this._currentSessionId === sessionId) return;
		const session = this._sessions.find((s) => s.id === sessionId);
		if (!session) return;

		this._currentSessionId = sessionId;
		await this._workspaceState.update(CURRENT_SESSION_ID_KEY, sessionId);
		await this.loadHistoryFromStorage();
	}

	public async deleteSession(sessionId: string): Promise<void> {
		const index = this._sessions.findIndex((s) => s.id === sessionId);
		if (index === -1) return;

		this._sessions.splice(index, 1);
		await this._workspaceState.update(
			HISTORY_KEY_PREFIX + sessionId,
			undefined,
		);

		if (this._sessions.length === 0) {
			await this.createNewSession();
		} else if (this._currentSessionId === sessionId) {
			await this.switchSession(this._sessions[0].id);
		} else {
			await this.saveSessionsMetadata();
		}
	}

	public async renameSession(
		sessionId: string,
		newName: string,
	): Promise<void> {
		const session = this._sessions.find((s) => s.id === sessionId);
		if (!session) return;
		session.name = newName;
		await this.saveSessionsMetadata();
	}

	public async pickSessionAndLoad(): Promise<void> {
		const items: (vscode.QuickPickItem & {
			sessionId?: string;
			action?: string;
		})[] = [
			{
				label: "$(add) New Session...",
				action: "new",
				alwaysShow: true,
			},
			{
				label: "$(file-code) Load from JSON file...",
				action: "load_file",
				alwaysShow: true,
			},
			{
				label: "",
				kind: vscode.QuickPickItemKind.Separator,
			},
		];

		const sessionItems = this._sessions.map((s) => ({
			label: s.name,
			description: s.id === this._currentSessionId ? "(Active)" : "",
			detail: `Last modified: ${new Date(s.lastModified).toLocaleString()}`,
			sessionId: s.id,
			buttons: [
				{
					iconPath: new vscode.ThemeIcon("save"),
					tooltip: "Save Session to File",
				},
				{
					iconPath: new vscode.ThemeIcon("edit"),
					tooltip: "Rename Session",
				},
				{
					iconPath: new vscode.ThemeIcon("trash"),
					tooltip: "Delete Session",
				},
			],
		}));

		const quickPick = vscode.window.createQuickPick<(typeof items)[0]>();
		quickPick.items = [...items, ...sessionItems];
		quickPick.placeholder = "Select a chat session or action";
		quickPick.title = "Minovative Mind: Chat Sessions";

		quickPick.onDidTriggerItemButton(async (e) => {
			const item = e.item;
			if (!item.sessionId) return;

			if (e.button.tooltip === "Save Session to File") {
				await this.saveSessionToFile(item.sessionId);
			} else if (e.button.tooltip === "Rename Session") {
				const newName = await vscode.window.showInputBox({
					prompt: "Enter a new name for the chat session",
					value: item.label,
				});
				if (newName) {
					await this.renameSession(item.sessionId, newName);
					quickPick.hide();
					await this.pickSessionAndLoad(); // Refresh
				}
			} else if (e.button.tooltip === "Delete Session") {
				const confirm = await vscode.window.showWarningMessage(
					`Are you sure you want to delete the session "${item.label}"?`,
					{ modal: true },
					"Delete",
				);
				if (confirm === "Delete") {
					await this.deleteSession(item.sessionId);
					quickPick.hide();
					await this.pickSessionAndLoad(); // Refresh
				}
			}
		});

		quickPick.onDidAccept(async () => {
			const selection = quickPick.selectedItems[0];
			quickPick.hide();

			if (selection) {
				if (selection.action === "new") {
					const name = await vscode.window.showInputBox({
						prompt: "Enter a name for the new chat session",
						placeHolder: "New Chat",
					});
					if (name !== undefined) {
						await this.createNewSession(name || "New Chat");
					}
				} else if (selection.action === "load_file") {
					await this.loadChat();
				} else if (selection.sessionId) {
					await this.switchSession(selection.sessionId);
				}
			}
		});

		quickPick.show();
	}

	private async loadHistoryFromStorage(): Promise<void> {
		if (!this._currentSessionId) return;
		try {
			const storedHistoryString = this._workspaceState.get<string>(
				HISTORY_KEY_PREFIX + this._currentSessionId,
			);
			if (storedHistoryString) {
				const loadedHistory: HistoryEntry[] = JSON.parse(storedHistoryString);
				if (
					Array.isArray(loadedHistory) &&
					loadedHistory.every(
						(item) =>
							typeof item === "object" &&
							item !== null &&
							typeof item.role === "string" &&
							Array.isArray(item.parts) &&
							item.parts.every(
								(p) =>
									(typeof p === "object" &&
										p !== null &&
										"text" in p &&
										typeof p.text === "string") || // Modified line
									("inlineData" in p &&
										typeof p.inlineData === "object" &&
										p.inlineData !== null &&
										typeof p.inlineData.mimeType === "string" &&
										typeof p.inlineData.data === "string"),
							) &&
							// Add validation for diffContent, relevantFiles, and isRelevantFilesExpanded
							(item.diffContent === undefined ||
								typeof item.diffContent === "string") &&
							(item.relevantFiles === undefined ||
								(Array.isArray(item.relevantFiles) &&
									item.relevantFiles.every(
										(f: any) => typeof f === "string",
									))) &&
							(item.isRelevantFilesExpanded === undefined ||
								typeof item.isRelevantFilesExpanded === "boolean") &&
							(item.isPlanExplanation === undefined ||
								typeof item.isPlanExplanation === "boolean") &&
							(item.isPlanStepUpdate === undefined ||
								typeof item.isPlanStepUpdate === "boolean") &&
							(item.isContextAgentLog === undefined ||
								typeof item.isContextAgentLog === "boolean"),
					)
				) {
					// Map loaded history to apply defensive defaults where needed
					this._chatHistory = loadedHistory.map((entry) => ({
						...entry,
						relevantFiles: entry.relevantFiles || [], // Defensive default for relevantFiles as per instruction
						// isRelevantFilesExpanded does not need a defensive default per instruction and type
						isPlanExplanation: entry.isPlanExplanation,
						isPlanStepUpdate: entry.isPlanStepUpdate,
					}));
					this.restoreChatHistoryToWebview();
					console.log("Chat history loaded from workspace state.");
				} else {
					console.warn(
						"Stored chat history format is invalid. Clearing history.",
					);
					this._chatHistory = [];
					this.saveHistoryToStorage();
				}
			} else {
				console.log("No chat history found in workspace state.");
			}
		} catch (error) {
			console.error("Error loading chat history from storage:", error);
			this._chatHistory = [];
			this.saveHistoryToStorage();
		}
	}

	private async saveHistoryToStorage(): Promise<void> {
		if (!this._currentSessionId) return;
		try {
			// HistoryEntry objects already contain relevantFiles and isRelevantFilesExpanded if present.
			// JSON.stringify will correctly serialize these properties into the stored string.
			await this._workspaceState.update(
				HISTORY_KEY_PREFIX + this._currentSessionId,
				JSON.stringify(this._chatHistory),
			);

			// Update lastModified
			const session = this._sessions.find(
				(s) => s.id === this._currentSessionId,
			);
			if (session) {
				session.lastModified = Date.now();
				await this.saveSessionsMetadata();
			}

			console.log(
				`Chat history saved to workspace state for session ${this._currentSessionId}.`,
			);
		} catch (error) {
			console.error("Error saving chat history to storage:", error);
		}
	}

	public addHistoryEntry(
		role: "user" | "model",
		content: string | HistoryEntryPart[], // Modified parameter type
		diffContent?: string,
		relevantFiles?: string[],
		isRelevantFilesExpanded?: boolean,
		isPlanExplanation: boolean = false,
		isPlanStepUpdate: boolean = false,
		isContextAgentLog: boolean = false,
	): void {
		let parts: HistoryEntryPart[];
		let contentForDuplicateCheck: string;

		if (typeof content === "string") {
			parts = [{ text: content }];
			contentForDuplicateCheck = content;
		} else {
			parts = content;
			// For duplicate check, try to get the first text part.
			// If it's a user message, it's expected to have a text part first.
			contentForDuplicateCheck =
				parts.length > 0 && "text" in parts[0] ? parts[0].text : "";
		}

		// Existing logic for managing chat history and preventing duplicates
		if (this._chatHistory.length > 0) {
			const lastEntry = this._chatHistory[this._chatHistory.length - 1];
			// Updated duplicate check to use contentForDuplicateCheck
			if (
				lastEntry.role === role &&
				lastEntry.parts.length > 0 &&
				"text" in lastEntry.parts[0] &&
				lastEntry.parts[0].text === contentForDuplicateCheck
			) {
				// Prevent adding duplicate messages for certain types of status updates
				if (
					contentForDuplicateCheck.startsWith("Changes reverted") ||
					(contentForDuplicateCheck ===
						"Plan execution finished successfully." &&
						("text" in lastEntry.parts[0]
							? lastEntry.parts[0].text
							: undefined) === contentForDuplicateCheck) || // Modified line
					(contentForDuplicateCheck === "Plan execution cancelled by user." &&
						("text" in lastEntry.parts[0]
							? lastEntry.parts[0].text
							: undefined) === contentForDuplicateCheck) || // Modified line
					(contentForDuplicateCheck === "Chat generation cancelled by user." &&
						("text" in lastEntry.parts[0]
							? lastEntry.parts[0].text
							: undefined) === contentForDuplicateCheck) || // Modified line
					(contentForDuplicateCheck ===
						"Commit message generation cancelled by user." &&
						("text" in lastEntry.parts[0]
							? lastEntry.parts[0].text
							: undefined) === contentForDuplicateCheck) || // Modified line
					(contentForDuplicateCheck ===
						"Structured plan generation cancelled by user." &&
						("text" in lastEntry.parts[0]
							? lastEntry.parts[0].text
							: undefined) === contentForDuplicateCheck) || // Modified line
					(contentForDuplicateCheck.startsWith("Step ") &&
						!contentForDuplicateCheck.includes("FAILED") &&
						!contentForDuplicateCheck.includes("SKIPPED"))
				) {
					console.log(
						"Skipping potential duplicate history entry:",
						contentForDuplicateCheck,
					);
					return;
				}
			}
		}

		const newEntry: HistoryEntry = {
			role,
			parts: parts, // Use the determined parts array
			...(diffContent && { diffContent }),
			// The existing logic correctly assigns relevantFiles and sets isRelevantFilesExpanded
			// based on provided value or defaults it based on relevantFiles.length <= 3 if relevant files are present.
			...(relevantFiles && {
				relevantFiles,
				isRelevantFilesExpanded:
					isRelevantFilesExpanded !== undefined
						? isRelevantFilesExpanded
						: relevantFiles.length <= 3
							? true
							: false,
			}),
			isPlanExplanation: isPlanExplanation,
			isPlanStepUpdate: isPlanStepUpdate,
			isContextAgentLog: isContextAgentLog,
		};

		// Auto-naming logic for first user message
		if (role === "user" && this._chatHistory.length === 0) {
			const session = this._sessions.find(
				(s) => s.id === this._currentSessionId,
			);
			if (session && session.name === "New Chat") {
				let truncatedName = contentForDuplicateCheck.trim();
				if (truncatedName.length > 40) {
					truncatedName = truncatedName.substring(0, 37) + "...";
				}
				if (truncatedName) {
					session.name = truncatedName;
					this.saveSessionsMetadata();
				}
			}
		}

		this._chatHistory.push(newEntry);
		if (this._chatHistory.length > MAX_HISTORY_ITEMS) {
			this._chatHistory.splice(0, this._chatHistory.length - MAX_HISTORY_ITEMS);
		}
		this.saveHistoryToStorage();
	}

	public async saveSessionToFile(sessionId: string): Promise<void> {
		let historyToSave: HistoryEntry[];
		let sessionName: string = "chat";

		const session = this._sessions.find((s) => s.id === sessionId);
		if (session) {
			sessionName = session.name;
		}

		if (sessionId === this._currentSessionId) {
			historyToSave = this._chatHistory;
		} else {
			const storedHistoryString = this._workspaceState.get<string>(
				HISTORY_KEY_PREFIX + sessionId,
			);
			if (storedHistoryString) {
				try {
					historyToSave = JSON.parse(storedHistoryString);
				} catch (e) {
					console.error("Failed to parse history for saving:", e);
					return;
				}
			} else {
				return;
			}
		}

		const options: vscode.SaveDialogOptions = {
			saveLabel: "Save Chat History",
			filters: { "JSON Files": ["json"] },
			defaultUri: vscode.workspace.workspaceFolders
				? vscode.Uri.joinPath(
						vscode.workspace.workspaceFolders[0].uri,
						`${sessionName.replace(/[^a-z0-9]/gi, "-").toLowerCase()}.json`,
					)
				: undefined,
		};
		const fileUri = await vscode.window.showSaveDialog(options);
		if (fileUri) {
			try {
				const saveableHistory: ChatMessage[] = historyToSave.map((entry) => {
					const textContent = entry.parts
						.filter((p): p is { text: string } => "text" in p)
						.map((p) => p.text)
						.join("\n");
					return {
						sender: entry.role === "user" ? "User" : "Model",
						text: textContent,
						className: entry.role === "user" ? "user-message" : "ai-message",
						...(entry.diffContent && { diffContent: entry.diffContent }),
						...(entry.relevantFiles && {
							relevantFiles: entry.relevantFiles,
						}),
						...(entry.isPlanExplanation && {
							isPlanExplanation: entry.isPlanExplanation,
						}),
						...(entry.isPlanStepUpdate && {
							isPlanStepUpdate: entry.isPlanStepUpdate,
						}),
					};
				});
				const contentString = JSON.stringify(saveableHistory, null, 2);
				await vscode.workspace.fs.writeFile(
					fileUri,
					Buffer.from(contentString, "utf-8"),
				);
				this.postMessageToWebview({
					type: "statusUpdate",
					value: "Chat saved successfully.",
				});
			} catch (error) {
				console.error("Error saving chat:", error);
				const message = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(`Failed to save chat: ${message}`);
				this.postMessageToWebview({
					type: "statusUpdate",
					value: "Error: Failed to save chat.",
					isError: true,
				});
			}
		} else {
			this.postMessageToWebview({
				type: "statusUpdate",
				value: "Chat save cancelled.",
			});
		}
	}

	public async clearChat(): Promise<void> {
		this._chatHistory = [];
		this.saveHistoryToStorage();
	}

	public deleteHistoryEntry(index: number): void {
		if (
			typeof index !== "number" ||
			!Number.isInteger(index) ||
			index < 0 ||
			index >= this._chatHistory.length
		) {
			console.warn(
				`Invalid index provided for deleteHistoryEntry: ${index}. History length: ${this._chatHistory.length}`,
			);
			return;
		}

		console.log(`Removing message at index ${index} from history.`);

		const entryToDelete = this._chatHistory[index];
		const isLog = entryToDelete.isContextAgentLog === true;

		// 1. Cascade Backward: remove contiguous logs PRECEDING this message
		// Only cascade if the message being deleted is NOT itself a log
		let backwardDeletedCount = 0;
		if (!isLog) {
			let prevIndex = index - 1;
			while (
				prevIndex >= 0 &&
				this._chatHistory[prevIndex].isContextAgentLog === true
			) {
				console.log(
					`Cascade backward deleting Context Agent log at index ${prevIndex}.`,
				);
				this._chatHistory.splice(prevIndex, 1);
				backwardDeletedCount++;
				prevIndex--;
				index--; // Adjust current index because we removed an item before it
			}
		}

		// 2. Remove the primary entry (at adjusted index)
		// If it's a log, we start cascading forward from here.
		this._chatHistory.splice(index, 1);
		let totalDeleted = backwardDeletedCount + 1;

		// 3. Cascade Forward: remove contiguous logs FOLLOWING this message
		// Cascade forward if the message being deleted is NOT a log (parent cleanup)
		// OR if it IS a log (cleanup the rest of the group)
		while (
			index < this._chatHistory.length &&
			this._chatHistory[index].isContextAgentLog === true
		) {
			console.log(
				`Cascade forward deleting Context Agent log at index ${index}.`,
			);
			this._chatHistory.splice(index, 1);
			totalDeleted++;
		}

		console.log(`Deleted ${totalDeleted} message(s) total.`);
		this.saveHistoryToStorage();
		this.restoreChatHistoryToWebview();
	}

	public updateMessageRelevantFilesExpandedState(
		index: number,
		isExpanded: boolean,
	): void {
		if (index < 0 || index >= this._chatHistory.length) {
			console.warn(
				`Invalid index for updateMessageRelevantFilesExpandedState: ${index}. History length: ${this._chatHistory.length}`,
			);
			return;
		}
		const entry = this._chatHistory[index];
		if (entry.relevantFiles) {
			const oldExpandedState = entry.isRelevantFilesExpanded;
			entry.isRelevantFilesExpanded = isExpanded;
			this.saveHistoryToStorage();
			// Only send update to webview if the state actually changed
			if (oldExpandedState !== isExpanded) {
				const message: UpdateRelevantFilesDisplayMessage = {
					type: "updateRelevantFilesDisplay",
					messageIndex: index,
					isExpanded: isExpanded,
				};
				this.postMessageToWebview(message);
			}
		} else {
			console.warn(
				`No relevantFiles found for entry at index ${index}, cannot update expanded state.`,
			);
		}
	}

	/**
	 * Edits a specific user message in the history and truncates all subsequent messages.
	 * @param index The 0-based index of the user message to edit.
	 * @param newContent The new text content for the message.
	 */
	public editMessageAndTruncate(index: number, newContent: string): void {
		// 1. Validate index
		if (
			typeof index !== "number" ||
			!Number.isInteger(index) ||
			index < 0 ||
			index >= this._chatHistory.length
		) {
			const warningMsg = `[ChatHistoryManager] Invalid index provided for editMessageAndTruncate: ${index}. History length: ${this._chatHistory.length}`;
			console.warn(warningMsg);
			this.postMessageToWebview({
				type: "statusUpdate",
				value: "Error: Could not edit message. Invalid index.",
				isError: true,
			});
			return;
		}

		const messageToEdit = this._chatHistory[index];

		// 2. Validate that it's a 'user' role message
		if (messageToEdit.role !== "user") {
			const warningMsg = `[ChatHistoryManager] Attempted to edit non-user message (role: ${messageToEdit.role}) at index ${index}. Operation skipped.`;
			console.warn(warningMsg);
			this.postMessageToWebview({
				type: "statusUpdate",
				value: "Error: Only your own messages can be edited.",
				isError: true,
			});
			return;
		}

		// 3. Update the text of the first part of the messageToEdit
		// Ensure parts[0] exists and is a text part before attempting to update.
		if (messageToEdit.parts.length > 0 && "text" in messageToEdit.parts[0]) {
			messageToEdit.parts[0].text = newContent;
		} else {
			// If there's no text part or parts array is empty, replace it with a new text part.
			messageToEdit.parts = [{ text: newContent }];
		}

		// 4. Truncate the array, removing all messages after the edited message.
		this._chatHistory.splice(index + 1);

		// 5. Call saveHistoryToStorage() to persist the changes.
		this.saveHistoryToStorage();
		console.log(
			`[ChatHistoryManager] Message at index ${index} edited and history truncated successfully.`,
		);
		this.postMessageToWebview({
			type: "statusUpdate",
			value: "Message edited. AI response will be regenerated.",
		});
	}

	public async loadChat(): Promise<void> {
		const options: vscode.OpenDialogOptions = {
			canSelectMany: false,
			openLabel: "Load Chat History",
			filters: { "Chat History Files": ["json"], "All Files": ["*"] },
		};
		const fileUris = await vscode.window.showOpenDialog(options);
		if (fileUris && fileUris.length > 0) {
			const fileUri = fileUris[0];
			try {
				const contentBytes = await vscode.workspace.fs.readFile(fileUri);
				const contentString = Buffer.from(contentBytes).toString("utf-8");
				const loadedData = JSON.parse(contentString) as ChatMessage[];

				if (
					Array.isArray(loadedData) &&
					loadedData.every(
						(item) =>
							item &&
							typeof item.sender === "string" &&
							typeof item.text === "string" && // ChatMessage only has 'text', not 'parts'
							(item.sender === "User" ||
								item.sender === "Model" ||
								item.sender === "System") &&
							(item.diffContent === undefined ||
								typeof item.diffContent === "string") &&
							(item.relevantFiles === undefined ||
								(Array.isArray(item.relevantFiles) &&
									item.relevantFiles.every((f) => typeof f === "string"))) &&
							(item.isPlanExplanation === undefined ||
								typeof item.isPlanExplanation === "boolean") &&
							(item.isPlanStepUpdate === undefined ||
								typeof item.isPlanStepUpdate === "boolean"),
					)
				) {
					this._chatHistory = loadedData.map(
						(item: ChatMessage): HistoryEntry => ({
							role: item.sender === "User" ? "user" : "model",
							parts: [{ text: item.text }], // Convert ChatMessage.text back to a single HistoryEntryPart
							diffContent: item.diffContent,
							relevantFiles: item.relevantFiles,
							isRelevantFilesExpanded: item.relevantFiles
								? item.relevantFiles.length <= 3
									? true
									: false
								: undefined,
							isPlanExplanation: item.isPlanExplanation,
							isPlanStepUpdate: item.isPlanStepUpdate,
						}),
					);
					this.restoreChatHistoryToWebview();
					this.saveHistoryToStorage();
					this.postMessageToWebview({
						type: "statusUpdate",
						value: "Chat loaded successfully.",
					});
				} else {
					throw new Error("Invalid chat history file format.");
				}
			} catch (error) {
				console.error("Error loading chat:", error);
				const message = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(`Failed to load chat: ${message}`);
				this.postMessageToWebview({
					type: "statusUpdate",
					value: "Error: Failed to load or parse chat file.",
					isError: true,
				});
			}
		} else {
			this.postMessageToWebview({
				type: "statusUpdate",
				value: "Chat load cancelled.",
			});
		}
	}

	public restoreChatHistoryToWebview(): void {
		// Ensures the entire chat history is rendered in the webview to maintain UI consistency.
		const historyForWebview: (ChatMessage & {
			imageParts?: ImageInlineData[];
		})[] = this._chatHistory.map((entry) => {
			let concatenatedText = "";
			const currentImageParts: ImageInlineData[] = [];

			entry.parts.forEach((part) => {
				if ("text" in part) {
					concatenatedText += part.text;
				} else if ("inlineData" in part) {
					currentImageParts.push(part.inlineData);
				}
			});

			const isContextAgentLog = entry.isContextAgentLog || false;
			const baseChatMessage: ChatMessage & { imageParts?: ImageInlineData[] } =
				{
					sender: isContextAgentLog
						? "Context Agent"
						: entry.role === "user"
							? "User"
							: "Model",
					text: concatenatedText.trim(), // Use the accumulated text
					className: isContextAgentLog
						? "context-agent-log"
						: entry.role === "user"
							? "user-message"
							: "ai-message",
					...(entry.diffContent && { diffContent: entry.diffContent }),
					...(entry.relevantFiles && { relevantFiles: entry.relevantFiles }),
					...(entry.relevantFiles &&
						entry.isRelevantFilesExpanded !== undefined && {
							isRelevantFilesExpanded: entry.isRelevantFilesExpanded,
						}),
					isPlanExplanation: entry.isPlanExplanation,
					isPlanStepUpdate: entry.isPlanStepUpdate,
					isContextAgentLog: isContextAgentLog,
				};

			// Conditionally add imageParts if there are any
			if (currentImageParts.length > 0) {
				// The ChatMessage type (locally extended) now includes imageParts
				baseChatMessage.imageParts = currentImageParts;
			}
			return baseChatMessage;
		});
		this.postMessageToWebview({
			type: "restoreHistory",
			value: historyForWebview,
		});
	}
}
