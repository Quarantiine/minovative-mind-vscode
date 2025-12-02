// src/utils/codeAnalysisUtils.ts
import * as vscode from "vscode";
import * as path from "path";
import { FileStructureAnalysis } from "../types/codeGenerationTypes";
import { DEFAULT_SIZE } from "../sidebar/common/sidebarConstants";

/**
 * Get language ID from file extension
 */
export function getLanguageId(extension: string): string {
	const languageMap: Record<string, string> = {
		".ts": "typescript",
		".tsx": "typescript",
		".js": "javascript",
		".jsx": "javascript",
		".py": "python",
		".java": "java",
		".cs": "csharp",
		".cpp": "cpp",
		".c": "c",
		".go": "go",
		".rs": "rust",
		".php": "php",
		".rb": "ruby",
		".swift": "swift",
		".kt": "kotlin",
	};

	return languageMap[extension] || "text";
}

/**
 * Extracts a code snippet around a given line number.
 */
export function getCodeSnippet(
	fullContent: string,
	lineNumber: number,
	linesBefore: number = 2,
	linesAfter: number = 2
): string {
	const lines = fullContent.split("\n");
	const zeroBasedLineNumber = lineNumber - 1;

	const start = Math.max(0, zeroBasedLineNumber - linesBefore);
	const end = Math.min(lines.length - 1, zeroBasedLineNumber + linesAfter);

	const snippetLines: string[] = [];
	const maxLineNumLength = String(end + 1).length;

	for (let i = start; i <= end; i++) {
		const currentLineNum = i + 1;
		const paddedLineNum = String(currentLineNum).padStart(
			maxLineNumLength,
			" "
		);
		snippetLines.push(`${paddedLineNum}: ${lines[i]}`);
	}

	return snippetLines.join("\n");
}

/**
 * Analyze file structure for modification context
 */
export async function analyzeFileStructure(
	filePath: string,
	content: string
): Promise<FileStructureAnalysis> {
	const lines = content.split("\n");
	const structure: FileStructureAnalysis = {
		imports: [],
		exports: [],
		functions: [],
		classes: [],
		variables: [],
		comments: [],
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();

		if (line.startsWith("import ")) {
			structure.imports.push({ line: i + 1, content: line });
		} else if (line.startsWith("export ")) {
			structure.exports.push({ line: i + 1, content: line });
		} else if (line.includes("function ") || line.includes("=>")) {
			structure.functions.push({ line: i + 1, content: line });
		} else if (line.includes("class ")) {
			structure.classes.push({ line: i + 1, content: line });
		} else if (
			line.includes("const ") ||
			line.includes("let ") ||
			line.includes("var ")
		) {
			structure.variables.push({ line: i + 1, content: line });
		} else if (line.startsWith("//") || line.startsWith("/*")) {
			structure.comments.push({ line: i + 1, content: line });
		}
	}

	return structure;
}

/**
 * Heuristically determines if the AI's raw text output is likely an error message
 */
export function isAIOutputLikelyErrorMessage(content: string): boolean {
	const lowerContent = content.toLowerCase().trim();
	const errorPhrases = [
		"i am sorry",
		"i'm sorry",
		"i cannot fulfill this request",
		"i encountered an error",
		"i ran into an issue",
		"an error occurred",
		"i am unable to provide",
		"please try again",
		"i couldn't generate",
		"i'm having trouble",
		"error:",
		"failure:",
		"exception:",
		"i can't",
		"i am not able to",
		"as an ai model",
		"i lack the ability to",
		"insufficient information",
		"invalid request",
		"not enough context",
	];
	const systemErrorPhrases = [
		"access denied",
		"file not found",
		"permission denied",
		"timeout",
		"rate limit",
		"quota exceeded",
		"server error",
		"api error",
	];
	const allErrorPhrases = [...errorPhrases, ...systemErrorPhrases];

	if (allErrorPhrases.some((phrase) => lowerContent.includes(phrase))) {
		return true;
	}
	if (
		content.length < 200 &&
		(lowerContent.includes("error") ||
			lowerContent.includes("fail") ||
			lowerContent.includes("issue"))
	) {
		return true;
	}

	const markdownErrorPattern =
		/(?:[a-zA-Z0-9]+)?\s*(error|fail|exception|apology|i am sorry)[\s\S]*?/i;
	return markdownErrorPattern.test(content);
}

/**
 * Heuristically determines if the user's prompt indicates an intent for a major rewrite.
 */
export function isRewriteIntentDetected(
	prompt: string,
	filePath?: string
): boolean {
	const lowerPrompt = prompt.toLowerCase();
	const rewriteKeywords = [
		"rewrite",
		"replace entirely",
		"generate from scratch",
		"completely change",
		"full overhaul",
		"start fresh",
		"reimplement",
		"rebuild",
		"design from scratch",
		"new implementation",
		"complete refactor",
	];

	if (rewriteKeywords.some((keyword) => lowerPrompt.includes(keyword))) {
		return true;
	}

	if (filePath) {
		const fileBaseName = path.basename(filePath).toLowerCase();
		if (
			lowerPrompt.includes(`completely change file ${fileBaseName}`) ||
			lowerPrompt.includes(`completely change this file`) ||
			lowerPrompt.includes(`rewrite file ${fileBaseName}`) ||
			lowerPrompt.includes(`rewrite this file`)
		) {
			return true;
		}
	}

	return false;
}

/**
 * Formats contents of selected file URIs into Markdown fenced code blocks.
 */
export async function formatSelectedFilesIntoSnippets(
	fileUris: vscode.Uri[],
	workspaceRoot: vscode.Uri,
	token: vscode.CancellationToken
): Promise<string> {
	if (!fileUris || fileUris.length === 0) {
		return "";
	}

	const formattedSnippets: string[] = [];
	const maxFileSizeForSnippet = DEFAULT_SIZE;

	for (const fileUri of fileUris) {
		if (token.isCancellationRequested) {
			break;
		}

		const relativePath = path
			.relative(workspaceRoot.fsPath, fileUri.fsPath)
			.replace(/\\/g, "/");
		let languageId =
			path.extname(fileUri.fsPath).substring(1) ||
			path.basename(fileUri.fsPath).toLowerCase();

		const langMap: { [key: string]: string } = {
			makefile: "makefile",
			dockerfile: "dockerfile",
			jsonc: "json",
			eslintignore: "ignore",
			prettierignore: "ignore",
			gitignore: "ignore",
			license: "plaintext",
		};
		languageId = langMap[languageId] || languageId;

		try {
			const fileStat = await vscode.workspace.fs.stat(fileUri);
			if (fileStat.type === vscode.FileType.Directory) {
				continue;
			}

			if (fileStat.size > maxFileSizeForSnippet) {
				formattedSnippets.push(
					`--- Relevant File: ${relativePath} ---\n\`\`\`plaintext\n[File skipped: too large]\n\`\`\`\n`
				);
				continue;
			}

			const contentBuffer = await vscode.workspace.fs.readFile(fileUri);
			const content = Buffer.from(contentBuffer).toString("utf8");

			if (content.includes("\0")) {
				formattedSnippets.push(
					`--- Relevant File: ${relativePath} ---\n\`\`\`plaintext\n[File skipped: appears to be binary]\n\`\`\`\n`
				);
				continue;
			}

			formattedSnippets.push(
				`--- Relevant File: ${relativePath} ---\n\`\`\`${languageId}\n${content}\n\`\`\`\n`
			);
		} catch (error: any) {
			formattedSnippets.push(
				`--- Relevant File: ${relativePath} ---\n\`\`\`plaintext\n[File skipped: could not be read: ${error.message}]\n\`\`\`\n`
			);
		}
	}

	return formattedSnippets.join("\n");
}

/**
 * A utility to safely extract string content given a `vscode.Range`.
 * Handles multiline ranges correctly.
 * @param fullContent The entire file content as a single string.
 * @param range The VS Code Range object specifying the start and end of the desired content.
 * @returns The extracted string content for the given range.
 */
export function extractContentForRange(
	fullContent: string,
	range: vscode.Range
): string {
	const lines = fullContent.split("\n");
	const startLine = range.start.line;
	const endLine = range.end.line;

	if (startLine < 0 || endLine >= lines.length || startLine > endLine) {
		return ""; // Invalid range
	}

	let contentLines: string[] = [];
	// Iterate through lines within the range
	for (let i = startLine; i <= endLine; i++) {
		let line = lines[i];
		if (i === startLine && i === endLine) {
			// Single line range
			line = line.substring(range.start.character, range.end.character);
		} else if (i === startLine) {
			line = line.substring(range.start.character);
		} else if (i === endLine) {
			line = line.substring(0, range.end.character);
		}
		contentLines.push(line);
	}
	return contentLines.join("\n");
}

/**
 * Extracts the range of the symbol's declaration (signature), excluding the function/class body
 * by searching for the opening brace `{`. For non-block symbols (Interface, TypeAlias),
 * it defaults to the selection range.
 */
export function getDeclarationRange(
	fullContent: string,
	symbol: vscode.DocumentSymbol
): vscode.Range {
	const lines = fullContent.split("\n");
	const startLine = symbol.range.start.line;
	const endLine = symbol.range.end.line;

	const isBlockKind = [
		vscode.SymbolKind.Class,
		vscode.SymbolKind.Function,
		vscode.SymbolKind.Method,
		vscode.SymbolKind.Constructor,
		vscode.SymbolKind.Module,
		vscode.SymbolKind.Namespace,
		vscode.SymbolKind.Enum,
	].includes(symbol.kind);

	if (isBlockKind) {
		// Search for the opening brace '{'
		for (let i = startLine; i <= endLine; i++) {
			const line = lines[i];
			const searchStartChar =
				i === startLine ? symbol.range.start.character : 0;

			let braceIndex = line.indexOf("{", searchStartChar);

			if (braceIndex !== -1) {
				// Success: Declaration ends right before the brace
				return new vscode.Range(
					symbol.range.start,
					new vscode.Position(i, braceIndex)
				);
			}
		}
	}

	// Fallback for:
	// 1. TypeAlias/Interface (explicitly default to selection range)
	// 2. Block symbols where no brace was found (e.g., abstract methods, ambient declarations)
	if (
		symbol.kind === vscode.SymbolKind.Interface ||
		symbol.kind === 25 || // TypeAlias
		isBlockKind
	) {
		return symbol.selectionRange;
	}

	// Default: Return the full range for things like variables, constants, parameters.
	return symbol.range;
}

/**
 * Parses backwards from a symbol's declaration to find the contiguous,
 * immediately preceding JSDoc/TSDoc or block comment (`/** * /` or `/* * /`) block and returns its range, or null.
 */
export function getDocumentationRange(
	fullContent: string,
	symbol: vscode.DocumentSymbol
): vscode.Range | null {
	const lines = fullContent.split("\n");
	let currentLine = symbol.range.start.line - 1;

	let endDocLine = -1;
	let startDocLine = -1;

	// 1. Find the first non-empty line before the symbol (This is the end of the doc block)
	while (currentLine >= 0 && lines[currentLine].trim() === "") {
		currentLine--;
	}

	if (currentLine < 0) {
		return null;
	}

	endDocLine = currentLine;

	// 2. Iterate backwards from endDocLine to find the start of the contiguous block
	for (let i = endDocLine; i >= 0; i--) {
		const line = lines[i];
		const trimmed = line.trim();

		// Acceptable documentation lines: empty line, lines starting with /*, *, /**, or //
		if (trimmed === "") {
			// Only continue if we have already established part of the documentation block (i.e., startDocLine != -1)
			if (startDocLine !== -1) {
				continue;
			} else {
				// We hit a blank line before hitting a comment block. Break.
				break;
			}
		}

		if (
			trimmed.startsWith("//") ||
			trimmed.startsWith("/*") ||
			trimmed.startsWith("*")
		) {
			startDocLine = i;

			// If it's the start of a single-line comment block (//) and the line before it wasn't
			// a valid doc line (comment or blank), we stop.
			if (trimmed.startsWith("//") && i > 0) {
				const prevTrimmed = lines[i - 1].trim();
				if (
					prevTrimmed !== "" &&
					!prevTrimmed.startsWith("//") &&
					!prevTrimmed.startsWith("/*") &&
					!prevTrimmed.startsWith("*")
				) {
					// The contiguous comment block is broken. Stop here (at line i).
					break;
				}
			}

			if (i === 0) {
				break;
			}
		} else {
			// Found code or non-comment line, documentation block ends right after this line (i + 1)
			startDocLine = i + 1;
			break;
		}
	}

	if (startDocLine === -1 || startDocLine > endDocLine) {
		return null;
	}

	// Final cleanup: If we ended up capturing leading blank lines before the documentation really started,
	// trim the start line up to the first non-blank line.
	let finalStartLine = startDocLine;
	while (finalStartLine < endDocLine && lines[finalStartLine].trim() === "") {
		finalStartLine++;
	}

	if (finalStartLine > endDocLine) {
		return null; // The entire captured range was just whitespace
	}

	return new vscode.Range(
		finalStartLine,
		0,
		endDocLine,
		lines[endDocLine].length
	);
}

/**
 * For Interface and TypeAlias symbols, this function extracts the declaration line and then
 * explicitly lists its children (properties/methods) with their types in a concise, structured format.
 * It relies on extractContentForRange internally and returns null for other symbol kinds.
 */
export function formatSymbolStructure(
	symbol: vscode.DocumentSymbol,
	fullContent: string
): string | null {
	if (
		symbol.kind !== vscode.SymbolKind.Interface &&
		symbol.kind !== 25 // TypeAlias
	) {
		return null;
	}

	// 1. Get the declaration signature (name and basic type assignment)
	const declarationRange = getDeclarationRange(fullContent, symbol);
	let structure = extractContentForRange(fullContent, declarationRange).trim();

	// Clean up potential trailing brace/semicolon if the declaration range includes it
	if (structure.endsWith("{")) {
		structure = structure.substring(0, structure.length - 1).trim();
	}

	const formattedParts: string[] = [];
	formattedParts.push(`// ${vscode.SymbolKind[symbol.kind]}: ${symbol.name}`);
	formattedParts.push(structure);

	// 2. Format children (properties/methods)
	if (symbol.children.length > 0) {
		const childrenList: string[] = [];
		for (const child of symbol.children) {
			if (
				child.kind === vscode.SymbolKind.Property ||
				child.kind === vscode.SymbolKind.Method ||
				child.kind === vscode.SymbolKind.Field ||
				child.kind === vscode.SymbolKind.Event
			) {
				// Extract the child declaration line/signature
				const childDeclarationRange = getDeclarationRange(fullContent, child);
				const childContent = extractContentForRange(
					fullContent,
					childDeclarationRange
				);

				// Take the first line for conciseness, clean up
				const contentLine = childContent
					.split("\n")[0]
					.trim()
					.replace(/\s+/g, " ");

				const detail = child.detail ? ` (${child.detail})` : "";

				childrenList.push(`  - ${contentLine}${detail}`);
			}
		}

		if (childrenList.length > 0) {
			formattedParts.push(`{`);
			formattedParts.push(...childrenList);
			formattedParts.push(`}`);
		}
	}

	return formattedParts.join("\n");
}
