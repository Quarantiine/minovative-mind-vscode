import { Tool } from "@google/generative-ai";
import {
	GoogleAICacheManager,
	CachedContent,
} from "@google/generative-ai/server";

const CACHE_TTL_SECONDS = 300; // 5 minutes
const CACHE_DISPLAY_NAME = "minovative-context-agent";

/**
 * Service to manage Gemini Context Caching for the Context Agent.
 * Caches system instructions + tools to reduce token costs during agentic loops.
 */
export class ContextAgentCacheService {
	private cacheManager: GoogleAICacheManager | null = null;
	private cachedContentName: string | null = null;
	private cachedContentHash: string | null = null;
	private currentApiKey: string | null = null;

	constructor(private getApiKey: () => string | undefined) {}

	/**
	 * Get or create a cache for the Context Agent's system instruction + tools.
	 * Returns the cache name to use in generateContent requests, or null if caching fails.
	 */
	async getOrCreateCache(
		modelName: string,
		systemInstruction: string,
		tools: Tool[],
	): Promise<string | null> {
		const apiKey = this.getApiKey();
		if (!apiKey) {
			console.warn("[ContextAgentCacheService] No API key available");
			return null;
		}

		// Create hash of content to detect changes
		const contentHash = this.hashContent(modelName, systemInstruction, tools);

		// Return existing cache if content hasn't changed and we have the same API key
		if (
			this.cachedContentName &&
			contentHash === this.cachedContentHash &&
			apiKey === this.currentApiKey
		) {
			console.log(
				`[ContextAgentCacheService] Reusing existing cache: ${this.cachedContentName}`,
			);
			return this.cachedContentName;
		}

		// Initialize or reinitialize cache manager if API key changed
		if (!this.cacheManager || apiKey !== this.currentApiKey) {
			this.cacheManager = new GoogleAICacheManager(apiKey);
			this.currentApiKey = apiKey;
			// Clear old cache reference since we have a new manager
			this.cachedContentName = null;
			this.cachedContentHash = null;
		}

		// Delete old cache if content changed
		if (this.cachedContentName && contentHash !== this.cachedContentHash) {
			try {
				await this.cacheManager.delete(this.cachedContentName);
				console.log(
					`[ContextAgentCacheService] Deleted stale cache: ${this.cachedContentName}`,
				);
			} catch (error) {
				// Ignore deletion errors - cache may have expired
				console.warn(
					`[ContextAgentCacheService] Failed to delete stale cache:`,
					error,
				);
			}
			this.cachedContentName = null;
		}

		// Create new cache
		try {
			console.log(
				`[ContextAgentCacheService] Creating new cache for model: ${modelName}`,
			);

			const cache: CachedContent = await this.cacheManager.create({
				model: modelName,
				systemInstruction,
				tools,
				contents: [], // Empty - we cache the system config, not conversation
				ttlSeconds: CACHE_TTL_SECONDS,
				displayName: CACHE_DISPLAY_NAME,
			});

			if (!cache.name) {
				console.warn(
					"[ContextAgentCacheService] Cache created but no name returned",
				);
				return null;
			}

			this.cachedContentName = cache.name;
			this.cachedContentHash = contentHash;

			console.log(
				`[ContextAgentCacheService] Created cache: ${cache.name} (TTL: ${CACHE_TTL_SECONDS}s)`,
			);
			return this.cachedContentName;
		} catch (error: any) {
			// Common failure: minimum token count not met
			if (error.message?.includes("minimum")) {
				console.log(
					`[ContextAgentCacheService] Content too small for caching (minimum token requirement not met)`,
				);
			} else {
				console.warn(
					"[ContextAgentCacheService] Failed to create cache:",
					error.message || error,
				);
			}
			return null;
		}
	}

	/**
	 * Creates a hash of the cache content to detect changes.
	 */
	private hashContent(
		modelName: string,
		systemInstruction: string,
		tools: Tool[],
	): string {
		// Simple hash based on content lengths and model - sufficient for cache invalidation
		const toolsString = JSON.stringify(tools);
		return `${modelName}_${systemInstruction.length}_${toolsString.length}_${this.simpleChecksum(systemInstruction)}_${this.simpleChecksum(toolsString)}`;
	}

	/**
	 * Simple checksum for string content.
	 */
	private simpleChecksum(str: string): number {
		let hash = 0;
		for (let i = 0; i < str.length; i++) {
			const char = str.charCodeAt(i);
			hash = (hash << 5) - hash + char;
			hash = hash & hash; // Convert to 32bit integer
		}
		return hash;
	}

	/**
	 * Get the current cached content name, if any.
	 */
	getCachedContentName(): string | null {
		return this.cachedContentName;
	}

	/**
	 * Clean up the cache when done.
	 */
	async dispose(): Promise<void> {
		if (this.cacheManager && this.cachedContentName) {
			try {
				await this.cacheManager.delete(this.cachedContentName);
				console.log(
					`[ContextAgentCacheService] Disposed cache: ${this.cachedContentName}`,
				);
			} catch {
				// Ignore cleanup errors - cache may have already expired
			}
		}
		this.cachedContentName = null;
		this.cachedContentHash = null;
		this.cacheManager = null;
		this.currentApiKey = null;
	}
}
