// src/services/tokenTrackingService.ts
import { FormattedTokenStatistics } from "../sidebar/common/sidebarTypes";

export interface TokenUsage {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	timestamp: number;
	requestType: string;
	modelName: string;
	status: "success" | "failed" | "cancelled";
	context?: string;
}

export interface TokenStatistics {
	totalInputTokens: number;
	totalOutputTokens: number;
	totalTokens: number;
	requestCount: number;
	failedRequestCount: number;
	averageInputTokens: number;
	averageOutputTokens: number;
	byRequestType: Map<
		string,
		{
			count: number;
			inputTokens: number;
			outputTokens: number;
			totalTokens: number;
		}
	>;
	byModel: Map<
		string,
		{
			count: number;
			inputTokens: number;
			outputTokens: number;
			totalTokens: number;
		}
	>;
	modelUsagePercentages: Map<string, number>;
}

export class TokenTrackingService {
	private tokenUsageHistory: TokenUsage[] = [];
	private readonly maxHistorySize = 1000; // Keep last 1000 requests
	private updateCallbacks: Array<(stats: TokenStatistics) => void> = [];

	/**
	 * Track token usage for an AI request
	 */
	public trackTokenUsage(
		inputTokens: number,
		outputTokens: number,
		requestType: string,
		modelName: string,
		context?: string,
		status: "success" | "failed" | "cancelled" = "success",
	): void {
		const usage: TokenUsage = {
			inputTokens,
			outputTokens,
			totalTokens: inputTokens + outputTokens,
			timestamp: Date.now(),
			requestType,
			modelName,
			status,
			context,
		};

		this.tokenUsageHistory.push(usage);

		// Keep only the last maxHistorySize entries
		if (this.tokenUsageHistory.length > this.maxHistorySize) {
			this.tokenUsageHistory = this.tokenUsageHistory.slice(
				-this.maxHistorySize,
			);
		}

		console.log(
			`[TokenTrackingService] Tracked usage: ${inputTokens} input, ${outputTokens} output tokens for ${requestType} (${modelName})`,
		);

		// Trigger real-time updates
		this.notifyUpdateCallbacks();
	}

	/**
	 * Register a callback for real-time token statistics updates
	 */
	public onTokenUpdate(callback: (stats: TokenStatistics) => void): void {
		this.updateCallbacks.push(callback);
	}

	/**
	 * Unregister a callback
	 */
	public offTokenUpdate(callback: (stats: TokenStatistics) => void): void {
		const index = this.updateCallbacks.indexOf(callback);
		if (index > -1) {
			this.updateCallbacks.splice(index, 1);
		}
	}

	/**
	 * Notify all registered callbacks with updated statistics
	 */
	private notifyUpdateCallbacks(): void {
		const stats = this.getTokenStatistics();
		this.updateCallbacks.forEach((callback) => {
			try {
				callback(stats);
			} catch (error) {
				console.error(
					"[TokenTrackingService] Error in update callback:",
					error,
				);
			}
		});
	}

	/**
	 * Trigger real-time update without saving to history
	 */
	public triggerRealTimeUpdate(): void {
		this.notifyUpdateCallbacks();
	}

	/**
	 * Get real-time token estimates for streaming responses
	 */
	public getRealTimeTokenEstimates(
		inputText: string,
		outputText: string,
	): {
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
	} {
		const inputTokens = this.estimateTokens(inputText);
		const outputTokens = this.estimateTokens(outputText);
		return {
			inputTokens,
			outputTokens,
			totalTokens: inputTokens + outputTokens,
		};
	}

	/**
	 * Get current streaming token estimates for display
	 */
	public getCurrentStreamingEstimates(
		inputText: string,
		outputText: string,
	): {
		inputTokens: string;
		outputTokens: string;
		totalTokens: string;
	} {
		const estimates = this.getRealTimeTokenEstimates(inputText, outputText);

		const formatNumber = (num: number): string => {
			if (num >= 1000000) {
				return `${(num / 1000000).toFixed(1)}M`;
			} else if (num >= 1000) {
				return `${(num / 1000).toFixed(1)}K`;
			}
			// For regular numbers, show one decimal place if it's not a whole number
			return Number.isInteger(num) ? num.toString() : num.toFixed(1);
		};

		return {
			inputTokens: formatNumber(estimates.inputTokens),
			outputTokens: formatNumber(estimates.outputTokens),
			totalTokens: formatNumber(estimates.totalTokens),
		};
	}

	/**
	 * Get current token statistics
	 */
	public getTokenStatistics(): TokenStatistics {
		if (this.tokenUsageHistory.length === 0) {
			return {
				totalInputTokens: 0,
				totalOutputTokens: 0,
				totalTokens: 0,
				requestCount: 0,
				failedRequestCount: 0,
				averageInputTokens: 0,
				averageOutputTokens: 0,
				byRequestType: new Map(),
				byModel: new Map(),
				modelUsagePercentages: new Map(),
			};
		}

		const totalInputTokens = this.tokenUsageHistory.reduce(
			(sum, usage) => sum + usage.inputTokens,
			0,
		);
		const totalOutputTokens = this.tokenUsageHistory.reduce(
			(sum, usage) => sum + usage.outputTokens,
			0,
		);
		const totalTokens = totalInputTokens + totalOutputTokens;
		const requestCount = this.tokenUsageHistory.length;
		const failedRequestCount = this.tokenUsageHistory.filter(
			(u) => u.status === "failed",
		).length;

		// Calculate averages
		const averageInputTokens = totalInputTokens / requestCount;
		const averageOutputTokens = totalOutputTokens / requestCount;

		// Group by request type
		const byRequestType = new Map<
			string,
			{
				count: number;
				inputTokens: number;
				outputTokens: number;
				totalTokens: number;
			}
		>();
		for (const usage of this.tokenUsageHistory) {
			const existing = byRequestType.get(usage.requestType) || {
				count: 0,
				inputTokens: 0,
				outputTokens: 0,
				totalTokens: 0,
			};
			existing.count++;
			existing.inputTokens += usage.inputTokens;
			existing.outputTokens += usage.outputTokens;
			existing.totalTokens += usage.totalTokens;
			byRequestType.set(usage.requestType, existing);
		}

		// Group by model
		const byModel = new Map<
			string,
			{
				count: number;
				inputTokens: number;
				outputTokens: number;
				totalTokens: number;
			}
		>();
		for (const usage of this.tokenUsageHistory) {
			const existing = byModel.get(usage.modelName) || {
				count: 0,
				inputTokens: 0,
				outputTokens: 0,
				totalTokens: 0,
			};
			existing.count++;
			existing.inputTokens += usage.inputTokens;
			existing.outputTokens += usage.outputTokens;
			existing.totalTokens += usage.totalTokens;
			byModel.set(usage.modelName, existing);
		}

		// Calculate model usage percentages
		const modelUsagePercentages = new Map<string, number>();
		let grandTotalModelTokens = 0;
		for (const data of byModel.values()) {
			grandTotalModelTokens += data.totalTokens;
		}

		if (grandTotalModelTokens > 0) {
			for (const [modelName, data] of byModel.entries()) {
				const percentage = (data.totalTokens / grandTotalModelTokens) * 100;
				modelUsagePercentages.set(modelName, percentage);
			}
		} else {
			// If no tokens consumed, all percentages are 0
			for (const modelName of byModel.keys()) {
				modelUsagePercentages.set(modelName, 0);
			}
		}

		return {
			totalInputTokens,
			totalOutputTokens,
			totalTokens,
			requestCount,
			failedRequestCount,
			averageInputTokens,
			averageOutputTokens,
			byRequestType,
			byModel,
			modelUsagePercentages,
		};
	}

	/**
	 * Get token usage for a specific time period
	 */
	public getTokenUsageForPeriod(
		startTime: number,
		endTime: number,
	): TokenUsage[] {
		return this.tokenUsageHistory.filter(
			(usage) => usage.timestamp >= startTime && usage.timestamp <= endTime,
		);
	}

	/**
	 * Get recent token usage (last N requests)
	 */
	public getRecentTokenUsage(count: number = 10): TokenUsage[] {
		return this.tokenUsageHistory.slice(-count);
	}

	/**
	 * Clear token usage history
	 */
	public clearTokenHistory(): void {
		this.tokenUsageHistory = [];
		console.log("[TokenTrackingService] Token usage history cleared");
	}

	/**
	 * Estimate tokens from text with high accuracy
	 * Uses a more sophisticated algorithm based on GPT tokenization patterns
	 */
	public estimateTokens(text: string): number {
		if (!text) {
			return 0;
		}

		let tokenCount = 0;
		let i = 0;

		while (i < text.length) {
			// Handle whitespace
			if (/\s/.test(text[i])) {
				tokenCount++;
				i++;
				continue;
			}

			// Handle common English words and patterns
			const wordMatch = text.slice(i).match(/^[a-zA-Z]+/);
			if (wordMatch) {
				const word = wordMatch[0];
				// Common words are often single tokens
				if (this.isCommonWord(word)) {
					tokenCount++;
				} else {
					// Longer words are split into multiple tokens
					tokenCount += Math.ceil(word.length / 3);
				}
				i += word.length;
				continue;
			}

			// Handle numbers
			const numberMatch = text.slice(i).match(/^\d+/);
			if (numberMatch) {
				const number = numberMatch[0];
				tokenCount += Math.ceil(number.length / 2);
				i += number.length;
				continue;
			}

			// Handle punctuation and special characters
			const punctMatch = text.slice(i).match(/^[^\w\s]+/);
			if (punctMatch) {
				const punct = punctMatch[0];
				// Each punctuation mark is typically a separate token
				tokenCount += punct.length;
				i += punct.length;
				continue;
			}

			// Handle code blocks and special content
			if (text.slice(i, i + 3) === "```") {
				tokenCount += 2; // ``` is typically 2 tokens
				i += 3;
				continue;
			}

			// Handle markdown and formatting
			if (text[i] === "*" || text[i] === "_" || text[i] === "`") {
				tokenCount++;
				i++;
				continue;
			}

			// Default: treat as individual character
			tokenCount++;
			i++;
		}

		return tokenCount;
	}

	/**
	 * Check if a word is common (likely to be a single token)
	 */
	private isCommonWord(word: string): boolean {
		const commonWords = new Set([
			"the",
			"a",
			"an",
			"and",
			"or",
			"but",
			"in",
			"on",
			"at",
			"to",
			"for",
			"of",
			"with",
			"by",
			"is",
			"are",
			"was",
			"were",
			"be",
			"been",
			"being",
			"have",
			"has",
			"had",
			"do",
			"does",
			"did",
			"will",
			"would",
			"could",
			"should",
			"may",
			"might",
			"can",
			"this",
			"that",
			"these",
			"those",
			"i",
			"you",
			"he",
			"she",
			"it",
			"we",
			"they",
			"me",
			"him",
			"her",
			"us",
			"them",
			"my",
			"your",
			"his",
			"her",
			"its",
			"our",
			"their",
			"mine",
			"yours",
			"his",
			"hers",
			"ours",
			"theirs",
			"what",
			"when",
			"where",
			"why",
			"how",
			"who",
			"which",
			"whom",
			"whose",
			"if",
			"then",
			"else",
			"while",
			"for",
			"against",
			"between",
			"among",
			"during",
			"before",
			"after",
			"since",
			"until",
			"from",
			"into",
			"through",
			"during",
			"before",
			"after",
			"above",
			"below",
			"up",
			"down",
			"out",
			"off",
			"over",
			"under",
			"again",
			"further",
			"then",
			"once",
			"here",
			"there",
			"when",
			"where",
			"why",
			"how",
			"all",
			"any",
			"both",
			"each",
			"few",
			"more",
			"most",
			"other",
			"some",
			"such",
			"no",
			"nor",
			"not",
			"only",
			"own",
			"same",
			"so",
			"than",
			"too",
			"very",
			"s",
			"t",
			"can",
			"will",
			"just",
			"don",
			"should",
			"now",
			"d",
			"ll",
			"m",
			"o",
			"re",
			"ve",
			"y",
			"ain",
			"aren",
			"couldn",
			"didn",
			"doesn",
			"hadn",
			"hasn",
			"haven",
			"isn",
			"ma",
			"mightn",
			"mustn",
			"needn",
			"shan",
			"shouldn",
			"wasn",
			"weren",
			"won",
			"wouldn",
		]);

		return commonWords.has(word.toLowerCase());
	}

	/**
	 * Get formatted token statistics for display
	 */
	public getFormattedStatistics(): FormattedTokenStatistics {
		const stats = this.getTokenStatistics();

		const formatNumber = (num: number): string => {
			if (num >= 1000000) {
				return `${(num / 1000000).toFixed(1)}M`;
			} else if (num >= 1000) {
				return `${(num / 1000).toFixed(1)}K`;
			}
			// For regular numbers, show one decimal place if it's not a whole number
			return Number.isInteger(num) ? num.toString() : num.toFixed(1);
		};

		return {
			totalInput: formatNumber(stats.totalInputTokens),
			totalOutput: formatNumber(stats.totalOutputTokens),
			total: formatNumber(stats.totalTokens),
			requestCount: stats.requestCount.toString(),
			failedRequestCount: stats.failedRequestCount.toString(),
			averageInput: formatNumber(stats.averageInputTokens),
			averageOutput: formatNumber(stats.averageOutputTokens),
			modelUsagePercentages: Array.from(stats.modelUsagePercentages.entries()),
		};
	}
}
