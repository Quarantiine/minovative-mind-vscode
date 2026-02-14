import MarkdownIt from "markdown-it";
import hljs from "highlight.js";

const faCopySvg = `<svg class="fa-icon" aria-hidden="true" focusable="false" data-prefix="fas" data-icon="copy" role="img" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path fill="currentColor" d="M384 336H192c-8.8 0-16-7.2-16-16V64c0-8.8 7.2-16 16-16h149.2c1.7 0 3.3.7 4.5 1.9l49.2 49.2c1.2 1.2 1.9 2.9 1.9 4.5V320c0 8.8-7.2 16-16 16zM288 64V.9c0-.4.2-.7.5-.9l49.2-49.2c.2-.2.5-.3.9-.3H416c8.8 0 16 7.2 16 16v304c0 8.8-7.2 16-16 16H288v-64h96c8.8 0 16-7.2 16-16V80h-96c-8.8 0-16-7.2-16-16zM128 128H32c-8.8 0-16 7.2-16 16v320c0 8.8 7.2 16 16 16h256c8.8 0 16-7.2 16-16V352h-64v96H48V160h80v-32z"></path></svg>`;
const copyButtonHtml = `\n    <button class="code-copy-button" title="Copy code">\n        ${faCopySvg}\n    </button>\n`;

/**
 * Sanitizes AI response text by stripping out agentic control sequences
 * and tool call markers that may have leaked into the text stream.
 *
 * Specifically targets:
 * - <ctrlXX> patterns (agentic control sequences)
 * - call:default_api:...{...} patterns (traditional/hidden tool calls)
 * - Hidden control characters (x00-x1F, x7F-x9F) except whitespace.
 * - <span class="tool-call">...</span> markers.
 * - Internal function calls like finish_selection(...).
 * - Raw HTML tags.
 */
export function sanitizeAiResponse(text: string): string {
	if (!text) return text;

	// 1. Remove agentic control sequences like <ctrl95>, <ctrl42>
	// Matches <ctrl followed by 1 or more digits and a closing >
	let sanitized = text.replace(/<ctrl\d+>/g, "");

	// 2. Remove traditionally leaked tool call patterns
	// Matches "call:default_api:" followed by identifier and a braced block
	// Note: This is a heuristic for text-leaked tool calls.
	sanitized = sanitized.replace(/call:default_api:[a-zA-Z0-9_-]+\{.*?\}/gs, "");

	// 3. Remove raw control characters that might cause glitches, except \n, \r, \t
	// eslint-disable-next-line no-control-regex
	sanitized = sanitized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, "");

	// 4. Remove tool call span markers and their content
	sanitized = sanitized.replace(/<span class="tool-call">.*?<\/span>/gs, "");

	// 5. Remove leaked internal function calls (like finish_selection)
	// Matches finish_selection(...) optionally wrapped in backticks
	sanitized = sanitized.replace(/`?finish_selection\(.*?\)`?/gs, "");

	// 6. General HTML cleanup to prevent injection or leaks
	sanitized = sanitized.replace(/<[^>]*>/g, "");

	return sanitized;
}

/**
 * Configured MarkdownIt instance for rendering markdown content.
 * It includes support for HTML, linkification, typography, and syntax highlighting
 * using highlight.js.
 */
export const md: MarkdownIt = new MarkdownIt({
	html: true, // Allow HTML tags in Markdown output
	linkify: true, // Automatically convert URLs to links
	typographer: true, // Enable some smart typography replacements
	highlight: function (str: string, lang: string): string {
		// If a language is specified and highlight.js supports it
		if (lang && hljs.getLanguage(lang)) {
			try {
				// Highlight the string and return the HTML value with language data attribute
				const highlightedCode = hljs.highlight(str, {
					language: lang,
					ignoreIllegals: true,
				}).value;
				return `<pre class="hljs has-copy-button" data-language="${lang}">${copyButtonHtml}<code>${highlightedCode}</code></pre>`;
			} catch (__) {
				// Fallback in case of highlighting error
				console.warn(`[MarkdownIt] Highlight.js failed for language ${lang}.`);
			}
		}
		// Fallback for unsupported language or no language specified:
		// Render as a basic preformatted code block with escaped HTML.
		// This uses md.utils.escapeHtml, which is part of the MarkdownIt instance itself,
		// ensuring it remains self-contained.
		const languageAttr = lang ? ` data-language="${lang}"` : "";
		return `<pre class="hljs has-copy-button"${languageAttr}>${copyButtonHtml}<code>${md.utils.escapeHtml(
			str,
		)}</code></pre>`;
	},
});
