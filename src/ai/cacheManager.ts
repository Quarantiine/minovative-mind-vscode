import {
	GoogleAIFileManager,
	GoogleAICacheManager,
} from "@google/generative-ai/server";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { geminiLogger } from "../utils/logger";
import { ApiKeyManager } from "../sidebar/managers/apiKeyManager";

export class GeminiCacheManager {
	private static instance: GeminiCacheManager;
	private fileManager: GoogleAIFileManager | null = null;
	private _apiKeyManager: ApiKeyManager | null = null;
	private cacheMap = new Map<
		string,
		{ name: string; expirationTime: number }
	>();

	private constructor() {}

	public static getInstance(): GeminiCacheManager {
		if (!GeminiCacheManager.instance) {
			GeminiCacheManager.instance = new GeminiCacheManager();
		}
		return GeminiCacheManager.instance;
	}

	public setApiKeyManager(manager: ApiKeyManager) {
		this._apiKeyManager = manager;
	}

	private initializeFileManager() {
		if (!this._apiKeyManager) {
			throw new Error("ApiKeyManager not initialized in GeminiCacheManager");
		}
		const apiKey = this._apiKeyManager.getActiveApiKey();
		if (!apiKey) {
			throw new Error("API Key not found for Cache Manager");
		}
		if (!this.fileManager) {
			this.fileManager = new GoogleAIFileManager(apiKey);
		}
		return apiKey;
	}

	/**
	 * Generates a SHA-256 hash of the content to use as a cache key.
	 */
	public generateCacheKey(content: string): string {
		return crypto.createHash("sha256").update(content).digest("hex");
	}

	/**
	 * Gets or creates a cached content resource.
	 * @param content The text content to cache (system instructions + project context).
	 * @param splitContext Function to split content into system instruction and user content (not used yet, simpler approach first).
	 * @param ttlSeconds Time to live in seconds (default 5 minutes to allow reuse across immediate turns).
	 */
	public async getOrCreateCache(
		content: string,
		modelName: string,
		ttlSeconds: number = 600,
	): Promise<{ cacheName: string; isNew: boolean } | null> {
		try {
			const apiKey = this.initializeFileManager();
			if (!this.fileManager) return null;

			const cacheKey = this.generateCacheKey(content);
			const cachedItem = this.cacheMap.get(cacheKey);

			// Check if local tracking thinks it's valid
			if (cachedItem) {
				if (Date.now() < cachedItem.expirationTime) {
					geminiLogger.log(
						"CacheManager",
						`Using local cache hit: ${cachedItem.name}`,
					);
					return { cacheName: cachedItem.name, isNew: false };
				} else {
					this.cacheMap.delete(cacheKey); // Expired
				}
			}

			// Note: In a real production environment, we should check the server list too,
			// but for now, we rely on local map + creating new ones.
			// Google's SDK doesn't easy expose "check if hash exists" without managing it ourselves.

			// Use the GoogleAICacheManager to create the cache
			// We need to write content to a temporary file first because fileManager uploads files
			const tempFilePath = path.join(
				os.tmpdir(),
				`gemini_cache_${cacheKey}.txt`,
			);
			fs.writeFileSync(tempFilePath, content);

			try {
				geminiLogger.log(
					"CacheManager",
					`Uploading cache content (${content.length} chars) to Gemini...`,
				);
				const uploadResult = await this.fileManager.uploadFile(tempFilePath, {
					mimeType: "text/plain",
					displayName: `Context Cache ${cacheKey.substring(0, 8)}`,
				});

				// Wait for file to be active? Usually small text files are instant.
				// But let's check state if needed.

				// Now create the cache
				const cacheManager = new GoogleAICacheManager(apiKey);

				geminiLogger.log("CacheManager", "Creating cache resource...");
				const cacheResult = await cacheManager.create({
					model: modelName,
					contents: [
						{
							role: "user",
							parts: [
								{
									fileData: {
										mimeType: uploadResult.file.mimeType!,
										fileUri: uploadResult.file.uri!,
									},
								},
							],
						},
					],
					ttlSeconds: ttlSeconds,
				});

				if (!cacheResult.name) {
					throw new Error("Created cache resource is missing a name.");
				}

				geminiLogger.log("CacheManager", `Cache created: ${cacheResult.name}`);

				// Update local map
				this.cacheMap.set(cacheKey, {
					name: cacheResult.name,
					expirationTime: Date.now() + ttlSeconds * 1000,
				});

				return { cacheName: cacheResult.name, isNew: true };
			} finally {
				// Cleanup temp file
				if (fs.existsSync(tempFilePath)) {
					fs.unlinkSync(tempFilePath);
				}
			}
		} catch (error) {
			geminiLogger.error("CacheManager", "Failed to get/create cache", error);
			return null;
		}
	}
}
