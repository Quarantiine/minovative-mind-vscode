import * as vscode from "vscode";
import { GEMINI_API_KEY_SECRET_KEY } from "../common/sidebarConstants";
import { ApiKeyInfo, KeyUpdateData } from "../common/sidebarTypes";
import { resetClient } from "../../ai/gemini";

/**
 * Represents the structure of the data stored in vscode.SecretStorage.
 */
interface StoredApiKeys {
	keys: string[];
	activeIndex: number;
}

export class ApiKeyManager {
	private _apiKeys: string[] = [];
	private _activeKeyIndex: number = -1;

	constructor(
		private readonly secretStorage: vscode.SecretStorage,
		private readonly postMessageToWebview: (message: any) => void
	) {}

	public async initialize(): Promise<void> {
		await this.loadKeysFromStorage();
	}

	public getActiveApiKey(): string | undefined {
		if (this._activeKeyIndex >= 0 && this._apiKeys[this._activeKeyIndex]) {
			return this._apiKeys[this._activeKeyIndex];
		}
		return undefined;
	}

	/**
	 * Returns the index of the currently active API key.
	 * @returns The active key index, or -1 if no key is active.
	 */
	public getActiveApiKeyIndex(): number {
		return this._activeKeyIndex;
	}

	public async loadKeysFromStorage(): Promise<void> {
		try {
			const storedValue = await this.secretStorage.get(
				GEMINI_API_KEY_SECRET_KEY
			);

			if (storedValue) {
				try {
					// New JSON format
					const parsedData: StoredApiKeys = JSON.parse(storedValue);
					if (
						Array.isArray(parsedData.keys) &&
						typeof parsedData.activeIndex === "number"
					) {
						this._apiKeys = parsedData.keys;
						this._activeKeyIndex = parsedData.activeIndex;
						console.log(
							`Loaded ${this._apiKeys.length} API keys. Active index: ${this._activeKeyIndex}`
						);
					} else {
						throw new Error("Invalid data structure in storage.");
					}
				} catch (e) {
					// Backwards compatibility for old raw string key
					console.log(
						"Could not parse stored keys as JSON, treating as a single legacy API key."
					);
					this._apiKeys = [storedValue];
					this._activeKeyIndex = 0;
					// Immediately save in the new format to migrate
					await this.saveKeysToStorage();
				}
			} else {
				// No keys are stored
				this._apiKeys = [];
				this._activeKeyIndex = -1;
				console.log("No API keys found in storage.");
			}
		} catch (error) {
			console.error("Error loading API keys from storage:", error);
			this._apiKeys = [];
			this._activeKeyIndex = -1;
			vscode.window.showErrorMessage("Failed to load API keys.");
		} finally {
			resetClient();
			this.updateWebviewKeyList();
		}
	}

	public async saveKeysToStorage(): Promise<void> {
		let saveError: any = null;
		try {
			if (this._apiKeys.length > 0) {
				const dataToStore: StoredApiKeys = {
					keys: this._apiKeys,
					activeIndex: this._activeKeyIndex,
				};
				await this.secretStorage.store(
					GEMINI_API_KEY_SECRET_KEY,
					JSON.stringify(dataToStore)
				);
				console.log(
					`Saved ${this._apiKeys.length} API keys. Active index: ${this._activeKeyIndex}`
				);
			} else {
				await this.secretStorage.delete(GEMINI_API_KEY_SECRET_KEY);
				console.log("Deleted all API keys from storage.");
			}
		} catch (error) {
			saveError = error;
			console.error("Error saving API keys to storage:", error);
		}

		resetClient();
		this.updateWebviewKeyList();

		if (saveError) {
			this.postMessageToWebview({
				type: "apiKeyStatus",
				value: "Error: Failed to save key changes.",
				isError: true,
			});
		}
	}

	public async addApiKey(key: string): Promise<void> {
		if (this._apiKeys.includes(key)) {
			this.postMessageToWebview({
				type: "apiKeyStatus",
				value: `Info: Key ...${key.slice(-4)} is already stored.`,
			});
			return;
		}

		if (this._apiKeys.length >= 2) {
			this.postMessageToWebview({
				type: "apiKeyStatus",
				value:
					"Error: A maximum of two API keys can be stored. Please delete one first.",
				isError: true,
			});
			return;
		}

		this._apiKeys.push(key);
		// If this is the first key being added, make it active.
		if (this._activeKeyIndex === -1) {
			this._activeKeyIndex = 0;
		}

		await this.saveKeysToStorage();
		this.postMessageToWebview({
			type: "apiKeyStatus",
			value: `API Key ending in ...${key.slice(-4)} added.`,
		});
	}

	public async deleteApiKey(index: number): Promise<void> {
		if (index < 0 || index >= this._apiKeys.length) {
			this.postMessageToWebview({
				type: "apiKeyStatus",
				value: "Error: Invalid key index provided for deletion.",
				isError: true,
			});
			return;
		}

		const deletedKey = this._apiKeys.splice(index, 1)[0];

		// Adjust active key index
		if (this._apiKeys.length === 0) {
			this._activeKeyIndex = -1;
		} else if (this._activeKeyIndex === index) {
			// If the active key was deleted, default to the first key
			this._activeKeyIndex = 0;
		} else if (this._activeKeyIndex > index) {
			// If a key before the active key was deleted, shift the index down
			this._activeKeyIndex--;
		}

		await this.saveKeysToStorage();
		this.postMessageToWebview({
			type: "apiKeyStatus",
			value: `API Key ...${deletedKey.slice(-4)} deleted.`,
		});
	}

	public async setActiveKey(index: number): Promise<void> {
		if (index < 0 || index >= this._apiKeys.length) {
			this.postMessageToWebview({
				type: "apiKeyStatus",
				value: "Error: Invalid key index provided for activation.",
				isError: true,
			});
			return;
		}

		if (this._activeKeyIndex === index) {
			// Key is already active, no change needed.
			return;
		}

		this._activeKeyIndex = index;
		const activeKey = this._apiKeys[index];

		await this.saveKeysToStorage();
		this.postMessageToWebview({
			type: "apiKeyStatus",
			value: `API Key ...${activeKey.slice(-4)} is now active.`,
		});
	}

	private updateWebviewKeyList(): void {
		const keyInfos: ApiKeyInfo[] = this._apiKeys.map((key, index) => ({
			maskedKey: `Key ...${key.slice(-4)}`,
			index: index,
			isActive: index === this._activeKeyIndex,
		}));

		const updateData: KeyUpdateData = {
			keys: keyInfos,
			activeIndex: this._activeKeyIndex,
			totalKeys: this._apiKeys.length,
		};

		this.postMessageToWebview({ type: "updateKeyList", value: updateData });
	}
}
