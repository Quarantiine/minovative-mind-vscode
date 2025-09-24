import * as vscode from "vscode";
import * as path from "path";
import { ContextService } from "./contextService";
import { ProjectChangeLogger } from "../workflow/ProjectChangeLogger";
import {
	EnhancedGenerationContext,
	CodeIssue,
} from "../types/codeGenerationTypes";
import {
	DiagnosticService,
	FormatDiagnosticsOptions,
} from "../utils/diagnosticUtils"; // Updated import to include FormatDiagnosticsOptions

export class ContextRefresherService {
	constructor(
		private contextService: ContextService,
		private changeLogger: ProjectChangeLogger,
		private workspaceRoot: vscode.Uri
	) {}

	public async refreshErrorFocusedContext(
		filePath: string,
		currentContent: string, // Parameter kept for signature compatibility, no longer used internally
		currentIssues: CodeIssue[], // Parameter kept for signature compatibility, no longer used internally
		currentContext: EnhancedGenerationContext,
		token?: vscode.CancellationToken
	): Promise<EnhancedGenerationContext> {
		// The original `if (currentIssues.length === 0)` check is now implicitly handled
		// by `DiagnosticService.formatContextualDiagnostics`, which returns `undefined`
		// if no diagnostics are found for the file.

		try {
			const fileUri = vscode.Uri.file(filePath);

			// Asynchronously read the content of fileUri
			const fileContentBytes = await vscode.workspace.fs.readFile(fileUri);
			const fileContent = Buffer.from(fileContentBytes).toString("utf8");

			// Construct a FormatDiagnosticsOptions object
			const formatOptions: FormatDiagnosticsOptions = {
				fileContent: fileContent,
				enableEnhancedDiagnosticContext: true,
				includeSeverities: [
					vscode.DiagnosticSeverity.Error,
					vscode.DiagnosticSeverity.Warning,
					vscode.DiagnosticSeverity.Information,
					vscode.DiagnosticSeverity.Hint,
				],
				requestType: "full", // Changed from "fix" to "full" to resolve type mismatch
				token: token, // Use the existing token parameter
				selection: undefined,
				maxTotalChars: undefined,
				snippetContextLines: undefined,
				maxPerSeverity: 25, // Set maxPerSeverity to 25 as per instructions
			};

			const formattedDiagnostics =
				await DiagnosticService.formatContextualDiagnostics(
					fileUri,
					this.workspaceRoot,
					formatOptions // Pass the newly constructed formatOptions object
				);

			if (!formattedDiagnostics) {
				// If no diagnostics were found or formatted by the DiagnosticService,
				// return the current context without changes to projectContext.
				return currentContext;
			}

			return {
				...currentContext,
				projectContext: formattedDiagnostics,
			};
		} catch (error: any) {
			console.error(
				`Error refreshing error-focused context for ${filePath}:`,
				error
			);
			return currentContext;
		}
	}
}
