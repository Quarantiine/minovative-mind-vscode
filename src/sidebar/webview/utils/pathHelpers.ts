/**
 * Extracts the file name (basename) from a full file path string.
 * This function is designed for client-side webview use and does not rely on Node.js 'path' module.
 * It handles both forward slashes (/) and backward slashes (\).
 *
 * @param filePath The full file path (e.g., 'path/to/file.txt' or 'C:\\path\\to\\file.txt').
 * @returns The file name (e.g., 'file.txt').
 */
export function getFileNameFromPath(filePath: string): string {
	if (!filePath) {
		return "";
	}

	// Normalize path separators to forward slash for easier splitting
	const normalizedPath = filePath.replace(/\\/g, "/");

	// Split the path by the separator
	const parts = normalizedPath.split("/");

	// Return the last part, which is the file name
	const fileName = parts.pop();

	// Handle potential trailing slash/empty part
	if (fileName) {
		return fileName;
	}

	// If pop() returned an empty string, it means the path ended with a separator.
	// Try to get the segment before the last empty one, or return empty.
	return parts.pop() || "";
}
