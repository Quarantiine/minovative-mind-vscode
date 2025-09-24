import * as vscode from "vscode";
import { sanitizeErrorMessagePaths } from "./pathUtils";
import {
	ERROR_OPERATION_CANCELLED,
	ERROR_STREAM_PARSING_FAILED,
	ERROR_SERVICE_UNAVAILABLE,
	ERROR_QUOTA_EXCEEDED, // Added ERROR_QUOTA_EXCEEDED
} from "../ai/gemini";

/**
 * Formats a raw error into a user-friendly, readable message.
 * Attempts to provide context and actionable advice where possible.
 *
 * @param error The raw error object (can be Error, string, or unknown).
 * @param defaultMessage A fallback message if the error cannot be parsed meaningfully.
 * @param contextPrefix Optional context string to prepend (e.g., "Failed to open file: ").
 * @param workspaceRootUri Optional workspace root URI for path sanitization.
 * @returns A formatted, readable error message string.
 */
export function formatUserFacingErrorMessage(
	error: any,
	defaultMessage: string = "An unexpected error occurred. Please try again or contact support.",
	contextPrefix: string = "",
	workspaceRootUri?: vscode.Uri
): string {
	let message: string;

	if (typeof error === "string") {
		message = error;
	} else if (error instanceof Error) {
		message = error.message;
	} else {
		message = String(error);
	}

	// Handle cancellation specifically, as it's a known user-initiated action
	if (message.includes(ERROR_OPERATION_CANCELLED)) {
		return `${contextPrefix}Operation cancelled by user.`;
	}

	// Map common technical errors to more user-friendly and actionable messages
	if (
		message.includes("EACCES: permission denied") ||
		message.includes("permission denied")
	) {
		message =
			"Permission denied: You do not have the necessary permissions to perform this operation. Please check file/directory permissions or try running VS Code as administrator.";
	} else if (
		message.includes("ENOENT: no such file or directory") ||
		message.includes("not found")
	) {
		message =
			"File or directory not found: The specified file or directory does not exist or is inaccessible. Please verify the path and ensure the file/directory exists.";
	} else if (
		message.includes("ETIMEDOUT") ||
		message.includes("network error") ||
		message.includes("Failed to fetch") ||
		message.includes("timed out")
	) {
		message =
			"Network issue or timeout: Could not connect to the AI service. Please check your internet connection or try again in a few moments.";
	} else if (message.includes("No workspace folder open")) {
		message =
			"No VS Code workspace folder is currently open. Please open a project folder to proceed with this operation.";
	}
	// Add new AI-specific error mappings here, after 'No workspace folder open' and before 'HTTP 401'
	else if (message.includes(ERROR_STREAM_PARSING_FAILED)) {
		message =
			"AI streaming parsing error: The AI returned an unexpected or malformed response (parsing failed) - Please wait...AI Retrying again.";
	} else if (message.includes(ERROR_SERVICE_UNAVAILABLE)) {
		message =
			"AI service temporarily overloaded: The AI service is currently experiencing high load (overloaded) - Please wait...AI Retrying again.";
	} else if (message.includes(ERROR_QUOTA_EXCEEDED)) {
		message = "API Quota Exceeded. Retrying automatically.";
	} else if (
		message.includes("SAFETY") ||
		message.includes("safety policy") ||
		message.includes("blocked due to safety") ||
		message.includes("content moderation")
	) {
		message =
			"Content generation stopped: The AI response was blocked due to a safety policy. Please try rephrasing your request or adjusting the input.";
	} else if (
		message.includes("resource exhausted") ||
		message.includes("prompt too long") ||
		message.includes("token limit exceeded")
	) {
		message =
			"Input too long: Your request or chat history exceeded the AI's maximum length. Please try a shorter message or clear the chat history.";
	} else if (
		message.includes("model not found") ||
		message.includes("invalid model name") ||
		message.includes("model does not exist")
	) {
		message =
			"AI Model Error: The selected AI model is unavailable or invalid. Please check your settings or try a different model.";
	} else if (
		message.includes("invalid argument") ||
		message.includes("bad request") ||
		message.includes("Malformed request")
	) {
		message =
			"Invalid Request: The AI service received a malformed request. This might be a temporary issue, please try again.";
	} else if (message.includes("API Key Initialization Failed")) {
		message =
			"API Key Initialization Failed: Unable to set up the AI service. Please ensure your API key is correct and has the necessary permissions.";
	}
	// Existing HTTP 401 check and subsequent conditions
	else if (
		message.includes("HTTP 401") ||
		message.includes("HTTP 403") ||
		message.includes("Unauthorized") ||
		message.includes("Forbidden") ||
		message.includes("invalid authentication")
	) {
		message =
			"Authentication required: Your API key might be invalid or unauthorized. Please verify your API key in the Minovative Mind settings or ensure you are signed in.";
	} else if (
		message.includes("HTTP 429") ||
		message.includes("quota exceeded") ||
		message.includes("rate limit exceeded")
	) {
		message =
			"Usage limit exceeded: You have exceeded your API usage quota or rate limit. Please wait and try again later, or consider upgrading your plan.";
	} else if (message.includes("HTTP 50")) {
		// Covers 500, 502, 503, 504 etc. for server-side issues
		message =
			"AI service unavailable: The AI service is temporarily unavailable due to a server error. Please wait...Retrying again.";
	} else if (message.toLowerCase().startsWith("error: ")) {
		// If the message already starts with "Error: ", it might be a more specific AI-generated error.
		// We can keep it but still sanitize paths if available.
		message = message.substring("Error: ".length); // Remove the redundant "Error: " prefix
	} else if (message.includes("Security Alert")) {
		// Keep existing security alerts but ensure consistent phrasing if passed raw
	} else if (message.includes("Expected JSON response, but got text")) {
		message =
			"Invalid AI response: The AI did not return a valid JSON plan. This might be due to a model issue or an unexpected response format. Please try again.";
	}

	// Sanitize paths in the message if a workspace root is provided
	if (workspaceRootUri) {
		message = sanitizeErrorMessagePaths(message, workspaceRootUri);
	}

	// Final check and fallback
	if (message.trim() === "" || message === "[object Object]") {
		message = defaultMessage;
	}

	return `${contextPrefix}${
		message.charAt(0).toUpperCase() + message.slice(1)
	}`;
}
