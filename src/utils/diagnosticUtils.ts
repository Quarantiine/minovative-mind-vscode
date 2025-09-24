import * as vscode from "vscode";
import * as path from "path";

/**
 * Options for formatting contextual diagnostics.
 */
export interface FormatDiagnosticsOptions {
	fileContent: string;
	enableEnhancedDiagnosticContext: boolean;
	includeSeverities: vscode.DiagnosticSeverity[];
	// Changed from "full" | "selection" to "full" | "hint_only" to resolve type incompatibility.
	requestType: "full" | "hint_only";
	token?: vscode.CancellationToken;
	selection?: vscode.Range;
	maxTotalChars?: number;
	maxPerSeverity?: number;
	snippetContextLines?: SnippetContextLines;
}

async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getSeverityName(severity: vscode.DiagnosticSeverity): string {
	switch (severity) {
		case vscode.DiagnosticSeverity.Error:
			return "Error";
		case vscode.DiagnosticSeverity.Warning:
			return "Warning";
		case vscode.DiagnosticSeverity.Information:
			return "Info";
		case vscode.DiagnosticSeverity.Hint:
			return "Hint";
		default:
			return "Unknown";
	}
}

/**
 * Defines the context lines for code snippets.
 */
export interface SnippetContextLines {
	before: number;
	after: number;
}

export class DiagnosticService {
	/**
	 * Retrieves all diagnostics for a given URI.
	 * @param uri The URI of the document.
	 * @returns An array of vscode.Diagnostic objects.
	 */
	public static getDiagnosticsForUri(uri: vscode.Uri): vscode.Diagnostic[] {
		return vscode.languages.getDiagnostics(uri);
	}

	/**
	 * Filters, prioritizes, and formats diagnostics into a string for AI context.
	 *
	 * @param documentUri The URI of the document to get diagnostics for.
	 * @param workspaceRoot The root URI of the workspace for relative paths.
	 * @param options Configuration for diagnostic formatting.
	 * @returns A formatted string of diagnostics, or undefined if no relevant diagnostics.
	 */
	public static async formatContextualDiagnostics(
		documentUri: vscode.Uri,
		workspaceRoot: vscode.Uri,
		options: FormatDiagnosticsOptions
	): Promise<string | undefined> {
		const allDiagnostics = DiagnosticService.getDiagnosticsForUri(documentUri);
		if (!allDiagnostics || allDiagnostics.length === 0) {
			return undefined;
		}

		const fileContentLines = options.fileContent.split(/\r?\n/);

		const actualMaxTotalChars = options.maxTotalChars ?? 25000;
		const actualMaxPerSeverity = options.maxPerSeverity ?? 25;
		const actualSnippetContextLines = options.snippetContextLines ?? {
			before: 3,
			after: 3,
		};

		// Determine effective filtering and limits based on options.requestType
		let effectiveIncludeSeverities = new Set(options.includeSeverities);
		let effectiveMaxPerSeverity = actualMaxPerSeverity;
		let effectiveMaxPerSeverityInfo = actualMaxPerSeverity / 2;
		let effectiveMaxPerSeverityHint = actualMaxPerSeverity / 4;

		if (options.requestType === "hint_only") {
			// Focus on Information and Hints, potentially with higher limits for them.
			effectiveIncludeSeverities = new Set([
				...(options.includeSeverities.includes(
					vscode.DiagnosticSeverity.Information
				)
					? [vscode.DiagnosticSeverity.Information]
					: []),
				...(options.includeSeverities.includes(vscode.DiagnosticSeverity.Hint)
					? [vscode.DiagnosticSeverity.Hint]
					: []),
			]);
			effectiveMaxPerSeverity = Math.max(actualMaxPerSeverity, 30);
			effectiveMaxPerSeverityInfo = Math.max(effectiveMaxPerSeverityInfo, 15);
			effectiveMaxPerSeverityHint = Math.max(effectiveMaxPerSeverityHint, 10);
		} else if (options.requestType === "full") {
			// This is the comprehensive mode, similar to 'general' or 'explain' previously.
			// The defaults or explicit options.includeSeverities apply.
			effectiveMaxPerSeverity = Math.max(actualMaxPerSeverity, 30);
			effectiveMaxPerSeverityInfo = Math.max(effectiveMaxPerSeverityInfo, 10);
			effectiveMaxPerSeverityHint = Math.max(effectiveMaxPerSeverityHint, 5);
		}

		let filteredDiagnostics: vscode.Diagnostic[] = [];

		if (options.selection) {
			// Scenario 1: User has a selection - prioritize diagnostics within selection
			filteredDiagnostics = allDiagnostics.filter(
				(d) =>
					options.selection?.intersection(d.range) &&
					effectiveIncludeSeverities.has(d.severity)
			);
		} else {
			// Scenario 2: No selection (whole file) - filter by effectiveIncludeSeverities
			const relevantDiagnostics = allDiagnostics.filter((d) =>
				effectiveIncludeSeverities.has(d.severity)
			);

			const errors = relevantDiagnostics.filter(
				(d) => d.severity === vscode.DiagnosticSeverity.Error
			);
			const warnings = relevantDiagnostics.filter(
				(d) => d.severity === vscode.DiagnosticSeverity.Warning
			);
			const infos = relevantDiagnostics.filter(
				(d) => d.severity === vscode.DiagnosticSeverity.Information
			);
			const hints = relevantDiagnostics.filter(
				(d) => d.severity === vscode.DiagnosticSeverity.Hint
			);

			// Sort each group by line number, then character position
			const sortFn = (a: vscode.Diagnostic, b: vscode.Diagnostic) => {
				const lineDiff = a.range.start.line - b.range.start.line;
				if (lineDiff !== 0) {
					return lineDiff;
				}
				return a.range.start.character - b.range.start.character;
			};
			errors.sort(sortFn);
			warnings.sort(sortFn);
			infos.sort(sortFn);
			hints.sort(sortFn);

			// Combine: All errors, then limited warnings, then limited infos, etc.
			filteredDiagnostics.push(...errors);
			if (effectiveIncludeSeverities.has(vscode.DiagnosticSeverity.Warning)) {
				filteredDiagnostics.push(...warnings.slice(0, effectiveMaxPerSeverity));
			}
			if (
				effectiveIncludeSeverities.has(vscode.DiagnosticSeverity.Information)
			) {
				filteredDiagnostics.push(
					...infos.slice(0, effectiveMaxPerSeverityInfo)
				);
			}
			if (effectiveIncludeSeverities.has(vscode.DiagnosticSeverity.Hint)) {
				filteredDiagnostics.push(
					...hints.slice(0, effectiveMaxPerSeverityHint)
				);
			}
		}

		if (filteredDiagnostics.length === 0) {
			return undefined;
		}

		// Final sorting of combined diagnostics: severity (Error > Warning > Info > Hint), then line, then character
		filteredDiagnostics.sort((a, b) => {
			if (a.severity !== b.severity) {
				return a.severity - b.severity; // Lower severity value means higher priority (Error=0, Warning=1...)
			}
			const lineDiff = a.range.start.line - b.range.start.line;
			if (lineDiff !== 0) {
				return lineDiff;
			}
			return a.range.start.character - b.range.start.character;
		});

		let diagnosticsString = "--- Relevant Diagnostics ---\n";
		let currentLength = diagnosticsString.length;
		const relativePath = path
			.relative(workspaceRoot.fsPath, documentUri.fsPath)
			.replace(/\\/g, "/");

		for (const diag of filteredDiagnostics) {
			if (options.token?.isCancellationRequested) {
				diagnosticsString += `... (${
					filteredDiagnostics.length - filteredDiagnostics.indexOf(diag)
				} more diagnostics truncated due to cancellation)\n`;
				break;
			}

			let diagLine = `- [${getSeverityName(diag.severity)}] ${relativePath}:${
				diag.range.start.line + 1
			}:${diag.range.start.character + 1} - ${diag.message}`;

			if (diag.code) {
				diagLine += ` (Code: ${
					typeof diag.code === "object" ? diag.code.value : diag.code
				})`;
			}
			if (diag.source) {
				diagLine += ` (Source: ${diag.source})`;
			}
			diagLine += "\n"; // Add newline for the diagnostic message itself

			let codeSnippetString = "";
			if (fileContentLines && fileContentLines.length > 0) {
				const diagnosticSpan = diag.range.end.line - diag.range.start.line;

				// Dynamically adjust snippet context based on span
				let linesBefore = actualSnippetContextLines.before;
				let linesAfter = actualSnippetContextLines.after;

				// If it's a multi-line issue, ensure we capture the full span plus a buffer
				if (diagnosticSpan > 0) {
					linesBefore = Math.max(linesBefore, 1); // At least 1 line before
					linesAfter = Math.max(linesAfter, 1); // At least 1 line after
				}

				const snippetStartLine = Math.max(
					0,
					diag.range.start.line - linesBefore
				);
				const snippetEndLine = Math.min(
					fileContentLines.length - 1,
					diag.range.end.line + linesAfter
				);

				const actualSnippetEndLine = Math.max(snippetStartLine, snippetEndLine);

				const snippetLines = fileContentLines.slice(
					snippetStartLine,
					actualSnippetEndLine + 1
				);

				let languageId = path
					.extname(documentUri.fsPath)
					.substring(1)
					.toLowerCase();
				if (!languageId) {
					languageId = path.basename(documentUri.fsPath).toLowerCase();
				}

				const languageMap: { [key: string]: string } = {
					ts: "typescript",
					js: "javascript",
					jsx: "javascript",
					tsx: "typescript",
					py: "python",
					java: "java",
					cs: "csharp",
					go: "go",
					rb: "ruby",
					php: "php",
					cpp: "cpp",
					c: "c",
					html: "html",
					css: "css",
					json: "json",
					xml: "xml",
					yml: "yaml",
					yaml: "yaml",
					sh: "bash",
					bat: "batchfile",
					ps1: "powershell",
					md: "markdown",
					sql: "sql",
					dockerfile: "dockerfile",
					makefile: "makefile",
					gitignore: "ignore",
					eslintignore: "ignore",
					prettierignore: "ignore",
					npmrc: "properties",
					yarnrc: "properties",
					bowerrc: "json",
					license: "plaintext",
					changelog: "plaintext",
					readme: "markdown",
					txt: "plaintext",
					log: "plaintext",
					env: "plaintext",
					conf: "plaintext",
					toml: "toml",
					ini: "ini",
				};
				languageId = languageMap[languageId] || "plaintext";

				const maxLineNumLength = String(actualSnippetEndLine + 1).length;
				const formattedSnippetLines: string[] = [];

				for (let i = 0; i < snippetLines.length; i++) {
					const currentFileContentLineNum = snippetStartLine + i; // 0-indexed line number in original file
					const displayLineNum = currentFileContentLineNum + 1; // 1-indexed for display
					const lineContent = snippetLines[i];
					const paddedLineNum = String(displayLineNum).padStart(
						maxLineNumLength,
						" "
					);

					let highlightedLine = `${paddedLineNum}: ${lineContent}`;
					let markerLine = "";

					const isDiagnosticLine =
						currentFileContentLineNum >= diag.range.start.line &&
						currentFileContentLineNum <= diag.range.end.line;

					if (isDiagnosticLine) {
						let startChar = 0;
						let endChar = lineContent.length;

						if (currentFileContentLineNum === diag.range.start.line) {
							startChar = diag.range.start.character;
						}
						if (currentFileContentLineNum === diag.range.end.line) {
							endChar = diag.range.end.character;
						}

						// If startChar is beyond endChar (e.g., empty diagnostic range), adjust
						if (startChar > endChar) {
							startChar = endChar;
						}

						// Create a marker line if there's an actual range to highlight on this line
						if (endChar > startChar) {
							const markerPadding = " ".repeat(
								maxLineNumLength + 2 + startChar
							); // +2 for ": "
							const marker = "^".repeat(endChar - startChar);
							markerLine = `${markerPadding}${marker} <-- ISSUE\n`;
						}
					}
					formattedSnippetLines.push(highlightedLine);
					if (markerLine) {
						formattedSnippetLines.push(markerLine);
					}
				}

				codeSnippetString = `Code snippet (${relativePath}, Line ${
					snippetStartLine + 1
				}):\n\`\`\`${languageId}\n${formattedSnippetLines.join("")}\n\`\`\`\n`; // Join with empty string because newlines are already in `formattedSnippetLines`
			}

			diagLine += codeSnippetString;

			if (currentLength + diagLine.length > actualMaxTotalChars) {
				diagnosticsString += `... (${
					filteredDiagnostics.length - filteredDiagnostics.indexOf(diag)
				} more diagnostics truncated)\n`;
				break;
			}
			diagnosticsString += diagLine;
			currentLength += diagLine.length;
		}

		diagnosticsString += "--- End Relevant Diagnostics ---\n";
		return diagnosticsString;
	}

	/**
	 * Waits for diagnostics for a given URI to stabilize.
	 * Diagnostics are considered stable if they don't change for a specified duration.
	 * @param uri The URI of the document to monitor.
	 * @param token A CancellationToken to abort the waiting.
	 * @param timeoutMs The maximum time to wait in milliseconds. Defaults to 10000ms (10 seconds).
	 * @param checkIntervalMs The base interval between checks in milliseconds. Defaults to 500ms.
	 * @param requiredStableChecks The number of consecutive checks without change required for stability. Defaults to 10.
	 * @returns A Promise that resolves when diagnostics stabilize or timeout/cancellation occurs.
	 */
	public static async waitForDiagnosticsToStabilize(
		uri: vscode.Uri,
		token?: vscode.CancellationToken,
		timeoutMs: number = 10000,
		checkIntervalMs: number = 500,
		requiredStableChecks: number = 10
	): Promise<void> {
		console.log(
			`[DiagnosticService] Waiting for diagnostics to stabilize for ${uri.fsPath} ` +
				`with timeoutMs=${timeoutMs}, baseCheckIntervalMs=${checkIntervalMs}, ` +
				`requiredStableChecks=${requiredStableChecks}...`
		);
		const startTime = Date.now();
		let lastDiagnosticsString: string | undefined;
		let stableCount = 0;
		let consecutiveUnstableChecks = 0;
		const maxJitter = checkIntervalMs * 0.2; // 20% jitter
		const maxBackoffDelay = 5000; // Max 5 seconds additional backoff per unstable check

		while (Date.now() - startTime < timeoutMs) {
			if (token?.isCancellationRequested) {
				console.log(
					`[DiagnosticService] Waiting for diagnostics cancelled for ${uri.fsPath}.`
				);
				return;
			}

			const currentDiagnostics = vscode.languages.getDiagnostics(uri);

			currentDiagnostics.sort((a, b) => {
				const cmpSeverity = a.severity - b.severity;
				if (cmpSeverity !== 0) {
					return cmpSeverity;
				}
				const cmpLine = a.range.start.line - b.range.start.line;
				if (cmpLine !== 0) {
					return cmpLine;
				}
				const cmpChar = a.range.start.character - b.range.start.character;
				if (cmpChar !== 0) {
					return cmpChar;
				}
				return a.message.localeCompare(b.message);
			});

			const currentDiagnosticsString = JSON.stringify(
				currentDiagnostics.map((d) => ({
					severity: d.severity,
					message: d.message,
					range: d.range,
					code: d.code,
					source: d.source, // Include source for more robust comparison
				}))
			);

			if (lastDiagnosticsString === currentDiagnosticsString) {
				stableCount++;
				console.log(
					`[DiagnosticService] Diagnostics stable (${stableCount}/${requiredStableChecks}) for ${uri.fsPath}.`
				);
				if (stableCount >= requiredStableChecks) {
					console.log(
						`[DiagnosticService] Diagnostics stabilized for ${
							uri.fsPath
						} after ${Date.now() - startTime}ms.`
					);
					return;
				}
				consecutiveUnstableChecks = 0; // Reset unstable counter on stability
			} else {
				console.log(
					`[DiagnosticService] Diagnostics changed for ${uri.fsPath}. Resetting stability counter.`
				);
				stableCount = 0;
				consecutiveUnstableChecks++;
			}

			lastDiagnosticsString = currentDiagnosticsString;

			let actualCheckInterval = checkIntervalMs;

			// Implement exponential backoff with jitter
			if (consecutiveUnstableChecks > 0) {
				const backoffFactor = Math.pow(1.2, consecutiveUnstableChecks - 1); // Exponential increase
				const jitter = Math.random() * maxJitter;
				actualCheckInterval = Math.min(
					checkIntervalMs * backoffFactor + jitter,
					checkIntervalMs + maxBackoffDelay // Cap the total backoff
				);
			}

			console.log(
				`[DiagnosticService] Next check for ${
					uri.fsPath
				} in ${actualCheckInterval.toFixed(0)}ms.`
			);
			await sleep(actualCheckInterval);
		}

		console.warn(
			`[DiagnosticService] Timeout (${timeoutMs}ms) waiting for diagnostics to stabilize for ${uri.fsPath}. Diagnostics might not be fully up-to-date.`
		);
	}
}
