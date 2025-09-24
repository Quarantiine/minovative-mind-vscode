// src/sidebar/ui/webviewHelper.ts
import * as vscode from "vscode";
import { getNonce } from "../../utils/nonce";
import { ModelInfo } from "../common/sidebarTypes";

export async function getHtmlForWebview(
	webview: vscode.Webview,
	extensionUri: vscode.Uri,
	availableModels: ModelInfo[],
	selectedModel: string,
	logoUri: vscode.Uri,
	workspaceRootUri: vscode.Uri | undefined
): Promise<string> {
	const scriptUri = webview.asWebviewUri(
		vscode.Uri.joinPath(extensionUri, "dist", "webview.js")
	);
	const stylesUri = webview.asWebviewUri(
		vscode.Uri.joinPath(extensionUri, "src", "sidebar", "webview", "styles.css")
	);
	const nonce = getNonce();

	const modelOptionsHtml = availableModels
		.map(
			(model) =>
				`<option value="${model.name}" ${
					model.name === selectedModel ? "selected" : ""
				}>${model.name} - ${model.description}</option>`
		)
		.join("");

	// Assuming index.html is in src/sidebar/webview/
	const htmlFileUri = vscode.Uri.joinPath(
		extensionUri,
		"src",
		"sidebar",
		"webview",
		"index.html"
	);
	try {
		const fileContentBytes = await vscode.workspace.fs.readFile(htmlFileUri);
		let htmlContent = Buffer.from(fileContentBytes).toString("utf-8");

		// Replace placeholders
		htmlContent = htmlContent.replace(/__CSP_SOURCE__/g, webview.cspSource);
		htmlContent = htmlContent.replace(/__NONCE__/g, nonce);
		htmlContent = htmlContent.replace(/__STYLES_URI__/g, stylesUri.toString());
		htmlContent = htmlContent.replace(
			/__LOGO_URI__/g,
			webview.asWebviewUri(logoUri).toString()
		); // Use the passed logoUri
		htmlContent = htmlContent.replace(
			/__MODEL_OPTIONS_HTML__/g,
			modelOptionsHtml
		);
		htmlContent = htmlContent.replace(/__SCRIPT_URI__/g, scriptUri.toString());

		// Add the new "Open File List" button within a div just before chat-input-controls-wrapper
		const openFileListButtonHtml = `
            <div class="input-actions-above">
                <button id="openFileListButton" title="Open File List">
                    <i class="fas fa-fw fa-folder-tree"></i>
                </button>
            </div>
        `;
		htmlContent = htmlContent.replace(
			'<div class="chat-input-controls-wrapper">',
			`${openFileListButtonHtml}<div class="chat-input-controls-wrapper">`
		);

		// Extract project folder name
		let projectName: string;
		if (workspaceRootUri) {
			const pathSegments = workspaceRootUri.path.split("/");
			projectName = pathSegments[pathSegments.length - 1] || "No Folder Open";
		} else {
			projectName = "No Folder Open";
		}

		// Replace __PROJECT_NAME__ placeholder
		htmlContent = htmlContent.replace(/__PROJECT_NAME__/g, projectName);

		return htmlContent;
	} catch (e) {
		console.error("Error reading webview HTML file:", e);
		return `<html><body>Error loading webview: ${e}</body></html>`;
	}
}
