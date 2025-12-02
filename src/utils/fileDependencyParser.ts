import * as ts from "typescript";
import * as vscode from "vscode";
import * as path from "path";
import { TextDecoder } from "util";
import { DependencyRelation } from "../context/dependencyGraphBuilder";

export async function parseFileImports(
	filePath: string,
	projectRoot: vscode.Uri,
	compilerOptions: ts.CompilerOptions,
	compilerHost: ts.CompilerHost,
	moduleResolutionCache: ts.ModuleResolutionCache
): Promise<DependencyRelation[]> {
	const importedRelationsMap = new Map<string, "runtime" | "type">();

	try {
		// Read the file content
		const fileContentUint8 = await vscode.workspace.fs.readFile(
			vscode.Uri.file(filePath)
		);
		const fileContent = new TextDecoder("utf-8").decode(fileContentUint8);

		// Parse the file into an AST
		const sourceFile = ts.createSourceFile(
			filePath,
			fileContent,
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TS
		);

		const projectRootFsPath = projectRoot.fsPath;

		// Traverse the AST
		ts.forEachChild(sourceFile, (node) => {
			let moduleSpecifierText: string | undefined;
			let relationType: "runtime" | "type" = "runtime";

			// Check for ImportDeclaration nodes
			if (ts.isImportDeclaration(node) && node.moduleSpecifier) {
				if (ts.isStringLiteral(node.moduleSpecifier)) {
					moduleSpecifierText = node.moduleSpecifier.text;
					if (node.importClause?.isTypeOnly) {
						relationType = "type";
					}
				}
			}
			// Check for ExportDeclaration nodes (e.g., `export { A } from './B';`)
			else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
				if (ts.isStringLiteral(node.moduleSpecifier)) {
					moduleSpecifierText = node.moduleSpecifier.text;
				}
			}

			if (moduleSpecifierText) {
				// Use ts.resolveModuleName for robust module resolution
				const resolvedModule = ts.resolveModuleName(
					moduleSpecifierText,
					filePath,
					compilerOptions,
					compilerHost,
					moduleResolutionCache
				);

				if (
					!resolvedModule ||
					!resolvedModule.resolvedModule ||
					typeof resolvedModule.resolvedModule.resolvedFileName !== "string"
				) {
					return;
				}

				if (resolvedModule.resolvedModule.isExternalLibraryImport) {
					return;
				}

				try {
					let relativeToProjectRoot = path.relative(
						projectRootFsPath,
						resolvedModule.resolvedModule.resolvedFileName
					);

					// Normalize the resulting relative path to use forward slashes (`/`) consistently
					relativeToProjectRoot = relativeToProjectRoot.replace(/\\/g, "/");

					const existingRelation = importedRelationsMap.get(
						relativeToProjectRoot
					);
					// If it's already a runtime import, don't downgrade it to a type import.
					if (existingRelation !== "runtime") {
						importedRelationsMap.set(relativeToProjectRoot, relationType);
					}
				} catch (pathResolutionError) {
					// Log error if path conversion to relative fails for a specific specifier
					console.error(
						`Failed to make resolved path relative for specifier '${moduleSpecifierText}' in file '${filePath}':`,
						pathResolutionError
					);
				}
			}
		});
	} catch (error) {
		// Robust error handling for file reading or AST parsing
		console.error(`Error processing file ${filePath}:`, error);
		// Return an empty array on error as per instructions
		return [];
	}

	return Array.from(importedRelationsMap.entries()).map(
		([path, relationType]) => ({
			path,
			relationType,
		})
	);
}
