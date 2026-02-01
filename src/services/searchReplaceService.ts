import { ProjectChangeLogger } from "../workflow/ProjectChangeLogger";

export interface SearchReplaceBlock {
	search: string;
	replace: string;
}

export class SearchReplaceService {
	constructor(private changeLogger?: ProjectChangeLogger) {}

	/**
	 * Parses the LLM output to extract search and replace blocks.
	 * Expected format:
	 * <<<<<<< SEARCH
	 * ... content to find ...
	 * =======
	 * ... content to replace with ...
	 * >>>>>>> REPLACE
	 */
	public parseBlocks(llmOutput: string): SearchReplaceBlock[] {
		const blocks: SearchReplaceBlock[] = [];
		// Relaxed regex to be more permissive with whitespace and newlines
		const regex =
			/<<<<<<<\s*SEARCH\s*\n([\s\S]*?)\n=======\s*\n([\s\S]*?)\n>>>>>>>\s*REPLACE/g;
		let match;

		while ((match = regex.exec(llmOutput)) !== null) {
			blocks.push({
				search: match[1],
				replace: match[2],
			});
		}

		return blocks;
	}

	/**
	 * Validates if the output contains any potential marker artifacts that were not parsed.
	 * Returns true if the output seems to contain potential unparsed markers.
	 */
	public hasUnparsedMarkers(llmOutput: string): boolean {
		// stricter check for markers that might have been missed by the main regex
		// checking for the presence of the start marker keyword
		return llmOutput.includes("<<<<<<< SEARCH");
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
					const errorMsg = `Ambiguous match for SEARCH block (Exact Match): found multiple occurrences.\nBlock:\n${block.search}`;
					if (this.changeLogger) {
						console.error(`[SearchReplaceService] ${errorMsg}`);
					}
					throw new Error(errorMsg);
				}
				newContent = newContent.replace(block.search, block.replace);
				continue;
			}

			// 2. Line-by-line matched (ignoring leading/trailing whitespace on lines)
			// This is expensive but helps when indentation is slightly off in the LLM output.
			const lines = newContent.split("\n");
			const searchLines = block.search.split("\n");

			const matchIndices = this.findFuzzyMatch(lines, searchLines);

			if (matchIndices.length === 0) {
				const errorMsg = `SEARCH block not found in file using fuzzy matching.\nBlock:\n${block.search}`;
				if (this.changeLogger) {
					console.error(`[SearchReplaceService] ${errorMsg}`);
				}
				throw new Error(errorMsg);
			}

			if (matchIndices.length > 1) {
				const errorMsg = `Ambiguous match for SEARCH block (Fuzzy Match): found ${matchIndices.length} potential locations.\nBlock:\n${block.search}`;
				if (this.changeLogger) {
					console.error(`[SearchReplaceService] ${errorMsg}`);
				}
				throw new Error(errorMsg);
			}

			const matchIndex = matchIndices[0];

			// Replace lines
			// We need to reconstruct the content with the replacement
			// We replace lines [matchIndex, matchIndex + searchLines.length) with block.replace
			// Note: block.replace is a string, we might want to split it into lines to insert it properly,
			// OR just join the `lines` array before and after.

			const before = lines.slice(0, matchIndex).join("\n");
			const after = lines.slice(matchIndex + searchLines.length).join("\n");

			// Verify if we need to handle newlines between parts
			// The simple join('\n') adds newlines between items.
			// If matchIndex is 0, 'before' is empty string.

			let result = "";
			if (matchIndex > 0) result += before + "\n";
			result += block.replace;
			if (matchIndex + searchLines.length < lines.length)
				result += "\n" + after;

			newContent = result;
		}

		return newContent;
	}

	private findFuzzyMatch(fileLines: string[], searchLines: string[]): number[] {
		// Simple sliding window
		// Returns all start indices in fileLines where a match occurs
		const matches: number[] = [];

		for (let i = 0; i <= fileLines.length - searchLines.length; i++) {
			let match = true;
			for (let j = 0; j < searchLines.length; j++) {
				if (fileLines[i + j].trim() !== searchLines[j].trim()) {
					match = false;
					break;
				}
			}
			if (match) {
				matches.push(i);
			}
		}
		return matches;
	}
}
