import {
	HistoryEntry,
	PlanGenerationContext,
} from "../sidebar/common/sidebarTypes";
import { AIRequestService } from "../services/aiRequestService";
import { ProjectConfigContext } from "./configContextProvider";
import {
	ConversationTopicContext,
	extractConversationContext,
} from "./chatHistoryAnalyzer";

/**
 * Result of decomposing a user's request into structured sub-intents.
 * This gives the agentic investigation loop a roadmap instead of a single raw string.
 */
export interface IntentDecomposition {
	/** The primary intent, rephrased for clarity */
	primaryIntent: string;
	/** Actionable sub-intents derived from the primary request */
	subIntents: string[];
	/** Concepts the user didn't explicitly mention but are implied */
	impliedConcepts: string[];
	/** Keywords to search for in the codebase (file names, function names, patterns) */
	searchKeywords: string[];
	/** How ambiguous the request is */
	ambiguityLevel: "low" | "medium" | "high";
	/** Questions to ask the user if ambiguity is high */
	clarifyingQuestions: string[];
	/** Brief domain context summary for the investigator */
	domainContext: string;
	/** Conversation topic context used during decomposition */
	conversationContext?: ConversationTopicContext;
}

/**
 * Decomposes a user request into structured sub-intents using AI.
 *
 * This is the first step before any file searching begins. Instead of
 * jumping straight from "the login flow is broken" to file selection,
 * this function produces a roadmap:
 *
 * Input:  "the login flow is broken"
 * Output: {
 *   primaryIntent: "Debug and fix the login authentication flow",
 *   subIntents: ["Check login endpoint/route handler", "Check auth middleware", "Check session/token management", ...],
 *   impliedConcepts: ["authentication", "session management", "JWT/cookies", "user credentials"],
 *   searchKeywords: ["login", "auth", "session", "token", "credential", "middleware", "passport"],
 *   ...
 * }
 */
export async function decomposeUserIntent(
	userRequest: string,
	projectConfig: ProjectConfigContext | undefined,
	activeEditorContext: PlanGenerationContext["editorContext"] | undefined,
	chatHistory: readonly HistoryEntry[],
	aiRequestService: AIRequestService,
	modelName: string,
	cancellationToken?: import("vscode").CancellationToken,
): Promise<IntentDecomposition> {
	// First, extract conversation context (Enhancement #3)
	const conversationContext = await extractConversationContext(
		chatHistory,
		userRequest,
		aiRequestService,
		cancellationToken,
	);

	// Build the decomposition prompt
	const contextParts: string[] = [];

	if (projectConfig?.frameworkHints?.length) {
		contextParts.push(
			`Project uses: ${projectConfig.frameworkHints.join(", ")}`,
		);
	}
	if (projectConfig?.keyDependencies?.length) {
		contextParts.push(
			`Key dependencies: ${projectConfig.keyDependencies.slice(0, 8).join(", ")}`,
		);
	}
	if (activeEditorContext?.filePath) {
		contextParts.push(
			`User is currently viewing: ${activeEditorContext.filePath}`,
		);
	}
	if (activeEditorContext?.selectedText?.trim()) {
		contextParts.push(
			`Selected text: "${activeEditorContext.selectedText.substring(0, 300)}"`,
		);
	}
	if (conversationContext.recentTopics.length > 0) {
		contextParts.push(
			`Recent conversation topics: ${conversationContext.recentTopics.slice(0, 8).join(", ")}`,
		);
	}
	if (conversationContext.conversationMomentum) {
		contextParts.push(
			`Conversation momentum: ${conversationContext.conversationMomentum}`,
		);
	}
	if (conversationContext.recentlyMentionedFiles.length > 0) {
		contextParts.push(
			`Previously discussed files: ${conversationContext.recentlyMentionedFiles.slice(0, 5).join(", ")}`,
		);
	}

	const projectContext =
		contextParts.length > 0
			? `\nProject & Session Context:\n${contextParts.map((c) => `- ${c}`).join("\n")}\n`
			: "";

	const decompositionPrompt = `Analyze the following user request and decompose it into structured sub-intents for a codebase investigation agent.

User Request: "${userRequest}"
${projectContext}
You must return a JSON object with this exact structure:
{
  "primaryIntent": "A clear, rephrased version of what the user wants",
  "subIntents": ["Specific actionable investigation steps, each checking a different aspect of the request"],
  "impliedConcepts": ["Technical concepts the user didn't explicitly say but are implied by their request"],
  "searchKeywords": ["Specific terms to search for in file names, function names, class names, and code content. Include synonyms and related terms."],
  "ambiguityLevel": "low|medium|high",
  "clarifyingQuestions": ["Questions to ask the user ONLY if the request is genuinely ambiguous. Empty array if the request is clear enough to proceed."],
  "domainContext": "A brief 1-2 sentence summary of the domain this request touches"
}

Rules:
- subIntents should be 3-8 specific investigation actions, not generic
- searchKeywords should include BOTH the user's exact terms AND expanded/synonym terms (e.g., "sidebar" → also include "panel", "drawer", "navigation", "menu")
- ambiguityLevel should be "high" ONLY if the request is truly unclear (e.g., "improve this", "make it better")
- clarifyingQuestions should be empty for most requests — only populated when truly needed
- impliedConcepts should capture what the user ASSUMES the AI will understand
- If conversation context suggests this is a continuation, reflect that in the decomposition

Return ONLY the JSON object.`;

	try {
		const response = await aiRequestService.generateWithRetry(
			[{ text: decompositionPrompt }],
			modelName,
			undefined,
			"intent_decomposition",
			{ responseMimeType: "application/json" },
			undefined,
			cancellationToken,
			false,
			"You are an expert intent decomposition system. Your job is to deeply analyze user requests and break them into structured sub-intents. Think about what the user REALLY needs, not just what they literally said. Output strict JSON.",
		);

		const jsonMatch = response.match(/\{[\s\S]*\}/);
		if (jsonMatch) {
			const parsed = JSON.parse(jsonMatch[0]);

			// Validate and normalize the response
			const decomposition: IntentDecomposition = {
				primaryIntent:
					typeof parsed.primaryIntent === "string"
						? parsed.primaryIntent
						: userRequest,
				subIntents: Array.isArray(parsed.subIntents)
					? parsed.subIntents.filter(
							(s: unknown): s is string => typeof s === "string",
						)
					: [],
				impliedConcepts: Array.isArray(parsed.impliedConcepts)
					? parsed.impliedConcepts.filter(
							(s: unknown): s is string => typeof s === "string",
						)
					: [],
				searchKeywords: Array.isArray(parsed.searchKeywords)
					? parsed.searchKeywords.filter(
							(s: unknown): s is string => typeof s === "string",
						)
					: [],
				ambiguityLevel:
					parsed.ambiguityLevel === "low" ||
					parsed.ambiguityLevel === "medium" ||
					parsed.ambiguityLevel === "high"
						? parsed.ambiguityLevel
						: "medium",
				clarifyingQuestions: Array.isArray(parsed.clarifyingQuestions)
					? parsed.clarifyingQuestions.filter(
							(s: unknown): s is string => typeof s === "string",
						)
					: [],
				domainContext:
					typeof parsed.domainContext === "string" ? parsed.domainContext : "",
				conversationContext,
			};

			console.log(
				`[IntentDecomposer] Decomposed "${userRequest.substring(0, 50)}..." → ` +
					`${decomposition.subIntents.length} sub-intents, ` +
					`${decomposition.searchKeywords.length} keywords, ` +
					`ambiguity: ${decomposition.ambiguityLevel}`,
			);

			return decomposition;
		}
	} catch (error) {
		console.warn(
			`[IntentDecomposer] AI decomposition failed, using heuristic fallback:`,
			error,
		);
	}

	// Heuristic fallback — extract basic keywords from the request
	return buildHeuristicDecomposition(
		userRequest,
		conversationContext,
		activeEditorContext,
	);
}

/**
 * Heuristic fallback when AI decomposition fails.
 * Extracts keywords and builds a basic decomposition from the raw request.
 */
function buildHeuristicDecomposition(
	userRequest: string,
	conversationContext: ConversationTopicContext,
	activeEditorContext?: PlanGenerationContext["editorContext"],
): IntentDecomposition {
	// Extract meaningful words as keywords
	const words = userRequest
		.toLowerCase()
		.replace(/[^a-z0-9\s_-]/g, " ")
		.split(/\s+/)
		.filter((w) => w.length >= 3);

	// Extract any CamelCase or PascalCase identifiers
	const identifiers = userRequest.match(/\b[A-Z][a-zA-Z0-9]+\b/g) || [];

	const searchKeywords = [
		...new Set([
			...words.filter(
				(w) =>
					![
						"the",
						"fix",
						"add",
						"make",
						"can",
						"how",
						"does",
						"what",
						"why",
						"this",
						"that",
						"with",
						"from",
						"have",
						"been",
						"not",
						"but",
					].includes(w),
			),
			...identifiers,
			...conversationContext.recentTopics.slice(0, 3),
		]),
	];

	return {
		primaryIntent: userRequest,
		subIntents: [
			`Investigate files related to: ${searchKeywords.slice(0, 5).join(", ")}`,
		],
		impliedConcepts: conversationContext.recentTopics.slice(0, 5),
		searchKeywords,
		ambiguityLevel: searchKeywords.length < 2 ? "high" : "medium",
		clarifyingQuestions: [],
		domainContext: conversationContext.workingDomain || "General",
		conversationContext,
	};
}

/**
 * Formats the intent decomposition into a prompt section for the agentic loop.
 */
export function formatIntentDecompositionForPrompt(
	decomposition: IntentDecomposition,
): string {
	const lines: string[] = ["--- Decomposed User Intent ---"];

	lines.push(`Primary Intent: ${decomposition.primaryIntent}`);

	if (decomposition.subIntents.length > 0) {
		lines.push("Investigation Roadmap:");
		decomposition.subIntents.forEach((intent, i) => {
			lines.push(`  ${i + 1}. ${intent}`);
		});
	}

	if (decomposition.impliedConcepts.length > 0) {
		lines.push(`Implied Concepts: ${decomposition.impliedConcepts.join(", ")}`);
	}

	if (decomposition.searchKeywords.length > 0) {
		lines.push(`Search Keywords: ${decomposition.searchKeywords.join(", ")}`);
	}

	if (decomposition.domainContext) {
		lines.push(`Domain: ${decomposition.domainContext}`);
	}

	if (decomposition.ambiguityLevel === "high") {
		lines.push(
			"⚠ AMBIGUITY: HIGH — Cast a wide net during investigation. Consider multiple interpretations.",
		);
	}

	lines.push("--- End Decomposed Intent ---");

	return lines.join("\n");
}
