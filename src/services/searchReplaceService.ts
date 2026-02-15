import { ProjectChangeLogger } from "../workflow/ProjectChangeLogger";

export interface SearchReplaceBlock {
	search: string;
	replace: string;
}

export class AmbiguousMatchError extends Error {
	constructor(
		message: string,
		public readonly ambiguousBlock: string,
	) {
		super(message);
		this.name = "AmbiguousMatchError";
	}
}

export class SearchBlockNotFoundError extends Error {
	constructor(
		message: string,
		public readonly missingBlock: string,
	) {
		super(message);
		this.name = "SearchBlockNotFoundError";
	}
}

export class SearchReplaceService {
	constructor(private changeLogger?: ProjectChangeLogger) {}

	/**
	 * Parses the raw AI output to extract search/replace blocks.
	 * Expected format:
	 * <<<<<<< SEARCH
	 * ... content to search ...
	 * =======
	 * ... content to replace ...
	 * >>>>>>> REPLACE
	 */
	public parseBlocks(rawOutput: string): SearchReplaceBlock[] {
		const blocks: SearchReplaceBlock[] = [];
		const lines = rawOutput.split(/\r?\n/);
		let currentSearch: string[] | null = null;
		let currentReplace: string[] | null = null;
		let state: "NONE" | "SEARCH" | "REPLACE" = "NONE";

		for (const line of lines) {
			const trimmedLine = line.trim();
			// Robust check for markers: allow leading/trailing whitespace and optional multiple characters
			if (trimmedLine.match(/^<{5,}\s*SEARCH/i)) {
				if (state !== "NONE") {
					// recursive or broken block, ignore or reset?
					// Let's reset for robustness
				}
				state = "SEARCH";
				currentSearch = [];
				currentReplace = null;
			} else if (trimmedLine.match(/^={5,}/)) {
				if (state === "SEARCH") {
					state = "REPLACE";
					currentReplace = [];
				}
			} else if (trimmedLine.match(/^>{5,}\s*REPLACE/i)) {
				if (state === "REPLACE" && currentSearch && currentReplace) {
					blocks.push({
						search: currentSearch.join("\n"),
						replace: currentReplace.join("\n"),
					});
				}
				state = "NONE";
				currentSearch = null;
				currentReplace = null;
			} else {
				if (state === "SEARCH") {
					currentSearch?.push(line);
				} else if (state === "REPLACE") {
					currentReplace?.push(line);
				}
			}
		}

		return blocks;
	}

	/**
	 * Checks if the content contains strings that look like markers but are malformed.
	 * This helps detect if the AI tried but failed to produce a valid block.
	 */
	public containsDeformedMarkers(content: string): boolean {
		// Look for fragments of markers that are NOT valid markers
		const patterns = [
			/SEARCH\s*$/m,
			/^=======/m,
			/REPLACE\s*$/m,
			/<<<<<[^<]/,
			/>>>>>[^>]/,
			/SEARCH\n.*={5,}\n.*REPLACE/s, // marker names without enough arrows
		];

		// First check if any VALID blocks exist. If they do, we don't necessarily flag as "deformed"
		// unless there are OTHER things that look like broken markers.
		if (this.parseBlocks(content).length > 0) {
			// If we found valid blocks, we only care if there are OTHER broken things.
			// But for simplicity, if it has markers it's usually good.
		}

		// A more robust check: does it have "SEARCH" or "REPLACE" or "=======" but NO valid blocks?
		const hasKeywords =
			content.includes("SEARCH") ||
			content.includes("REPLACE") ||
			content.includes("=======");
		if (hasKeywords && this.parseBlocks(content).length === 0) {
			return true;
		}

		return false;
	}

	/**
	 * Heuristic to determine if the content is likely a partial code snippet rather than a full file.
	 * Used to prevent accidental full-file rewrites with fragments.
	 */
	public isLikelyPartialSnippet(
		content: string,
		originalContent?: string,
	): boolean {
		const trimmed = content.trim();

		// Too short to be a meaningful full file (heuristic)
		if (trimmed.length < 20 && trimmed.length > 0) {
			return true;
		}

		// Starts with comment or import but ends abruptly? (Hard to tell)

		// If we have original content, we can compare sizes
		if (originalContent && originalContent.length > 500) {
			// If original is large and new is tiny (and not explicitly a deletion?)
			if (trimmed.length < originalContent.length * 0.1) {
				// 90% reduction in size without markers might be suspicious
				// BUT some tasks are deletions. However, deletions of 90% are rare without blocks.
				return true;
			}
		}

		// Look for common "fragment" signs:
		// 1. Starts with "..." or has "..." in a way that suggests omitted code (outside of strings)
		if (trimmed.startsWith("...") || trimmed.endsWith("...")) {
			return true;
		}

		// 2. Contains common AI placeholders like "// ... rest of code"
		const placeholders = [
			/\/\/ \.\.\./,
			/\* \.\.\./,
			/\/\/ rest of (the )?code/i,
			/\/\* rest of (the )?code/i,
		];
		if (placeholders.some((p) => p.test(content))) {
			return true;
		}

		return false;
	}

	/**
	 * Applies the search and replace blocks to the original content.
	 * Throws an error if a block cannot be found or matches multiple times (ambiguous).
	 */
	public applyBlocks(
		originalContent: string,
		blocks: SearchReplaceBlock[],
	): string {
		let newContent = originalContent;

		for (const block of blocks) {
			const searchTrimmed = block.search.trim();
			// We try to find the block in the current content
			// Strategy:
			// 1. Exact match (preferred)
			// 2. Trimmed match (if exact fails)
			// 3. Line-by-line whitespace flexible match (most robust)

			if (block.search === "") {
				// If search block is empty, maybe they want to append?
				// But for now, let's assume it's an error or insertion point needs to be defined.
				// If the user strictly follows regex, empty search might be weird unless it's a specific insertion syntax we define later.
				// Let's skip empty search blocks to avoid replacing "nothing" everywhere.
				continue;
			}

			// 1. Exact match
			if (newContent.includes(block.search)) {
				// check for multiple occurrences
				const firstIndex = newContent.indexOf(block.search);
				const secondIndex = newContent.indexOf(block.search, firstIndex + 1);
				if (secondIndex !== -1) {
					// AMBIGUITY RESOLUTION:
					// Instead of throwing, we now default to the First Match.
					// This allows sequential blocks to work (Block 1 replaces Occurrence 1, Block 2 replaces Occurrence 2).
					const warningMsg = `Ambiguous match for SEARCH block (Exact Match): found multiple occurrences. Using the first one.\nBlock:\n${block.search}`;
					if (this.changeLogger) {
						console.warn(`[SearchReplaceService] ${warningMsg}`);
					}
				}
				newContent = newContent.replace(block.search, block.replace);
				continue;
			}

			// 2. Line-by-line matched (ignoring leading/trailing whitespace on lines)
			// This is expensive but helps when indentation is slightly off in the LLM output.
			const lines = newContent.split("\n");
			const searchLines = block.search.split("\n");

			// Check for wildcards
			let matchRange: { start: number; end: number } | null = null;
			if (searchLines.some((l) => l.trim() === "...")) {
				matchRange = this.findWildcardMatch(lines, searchLines);
			} else {
				matchRange = this.findFuzzyMatch(lines, searchLines);
			}

			if (!matchRange) {
				const errorMsg = `SEARCH block not found in file using fuzzy matching.\nBlock:\n${block.search}`;
				if (this.changeLogger) {
					console.error(`[SearchReplaceService] ${errorMsg}`);
				}
				throw new SearchBlockNotFoundError(errorMsg, block.search);
			}

			// AMBIGUITY RESOLUTION:
			// findFuzzyMatch/findWildcardMatch now returns the FIRST match found.
			// If there were multiple, the first one is picked.

			const matchIndex = matchRange.start;
			const matchEndIndex = matchRange.end;

			// Replace lines
			// We need to reconstruct the content with the replacement
			// We replace lines [matchIndex, matchEndIndex) with block.replace
			// Note: block.replace is a string, we might want to split it into lines to insert it properly,
			// OR just join the `lines` array before and after.

			const before = lines.slice(0, matchIndex).join("\n");
			const after = lines.slice(matchEndIndex).join("\n");

			// Verify if we need to handle newlines between parts
			// The simple join('\n') adds newlines between items.
			// If matchIndex is 0, 'before' is empty string.

			let result = "";
			if (matchIndex > 0) {
				result += before + "\n";
			}
			result += block.replace;
			if (matchEndIndex < lines.length) {
				result += "\n" + after;
			}

			newContent = result;
		}

		return newContent;
	}

	private findFuzzyMatch(
		fileLines: string[],
		searchLines: string[],
	): { start: number; end: number } | null {
		// Normalization helper
		const normalize = (s: string) => s.trim().replace(/\s+/g, " ");
		const normalizedSearch = searchLines.map(normalize);

		// Simple sliding window
		// Returns the FIRST match found
		for (let i = 0; i <= fileLines.length - searchLines.length; i++) {
			let match = true;
			for (let j = 0; j < searchLines.length; j++) {
				if (normalize(fileLines[i + j]) !== normalizedSearch[j]) {
					match = false;
					break;
				}
			}
			if (match) {
				return { start: i, end: i + searchLines.length };
			}
		}
		return null;
	}

	private findWildcardMatch(
		fileLines: string[],
		searchLines: string[],
	): { start: number; end: number } | null {
		const normalize = (s: string) => s.trim().replace(/\s+/g, " ");

		// Split searchLines by "..."
		const segments: string[][] = [];
		let currentSegment: string[] = [];
		for (const line of searchLines) {
			if (line.trim() === "...") {
				if (currentSegment.length > 0) {
					segments.push(currentSegment);
					currentSegment = [];
				}
			} else {
				currentSegment.push(line);
			}
		}
		if (currentSegment.length > 0) {
			segments.push(currentSegment);
		}

		let currentLineIdx = 0;
		let matchStartIdx = -1;

		for (let segIdx = 0; segIdx < segments.length; segIdx++) {
			const segment = segments[segIdx];
			const normalizedSegment = segment.map(normalize);

			let segmentFound = false;
			// Search for this segment starting from currentLineIdx
			for (
				let i = currentLineIdx;
				i <= fileLines.length - segment.length;
				i++
			) {
				let match = true;
				for (let j = 0; j < segment.length; j++) {
					if (normalize(fileLines[i + j]) !== normalizedSegment[j]) {
						match = false;
						break;
					}
				}
				if (match) {
					if (segIdx === 0) {
						matchStartIdx = i;
					}
					currentLineIdx = i + segment.length;
					segmentFound = true;
					break; // Move to next segment
				}
			}

			if (!segmentFound) {
				return null;
			}
		}

		return { start: matchStartIdx, end: currentLineIdx };
	}
}
