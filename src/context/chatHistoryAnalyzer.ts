import { HistoryEntry } from "../sidebar/common/sidebarTypes";
import { AIRequestService } from "../services/aiRequestService";
import { DEFAULT_FLASH_LITE_MODEL } from "../sidebar/common/sidebarConstants";
import {
	Tool,
	SchemaType,
	FunctionCallingMode,
	Content,
} from "@google/generative-ai";

/**
 * Structured context extracted from conversation history.
 * Provides the AI with a rich understanding of the user's working session,
 * not just the raw last-5-turns of text.
 */
export interface ConversationTopicContext {
	/** Dominant topics extracted from recent messages (e.g., "authentication", "login", "JWT") */
	recentTopics: string[];
	/** File paths explicitly mentioned in recent conversation */
	recentlyMentionedFiles: string[];
	/** High-level summary of the user's current working domain */
	workingDomain: string;
	/** Narrative of conversational momentum — what the user has been doing */
	conversationMomentum: string;
	/** Things the user likely assumes the AI knows from prior context */
	implicitAssumptions: string[];
	/** Number of consecutive messages on the same topic */
	topicDepth: number;
}

/**
 * Structured output from AI extraction of conversation entities.
 */
interface ConversationEntityExtraction {
	filePaths: string[];
	codeIdentifiers: string[];
	mainTopics: string[];
}

// Common code-related stop words to filter out during topic extraction
const STOP_WORDS = new Set([
	"the",
	"a",
	"an",
	"is",
	"it",
	"to",
	"in",
	"for",
	"of",
	"and",
	"or",
	"that",
	"this",
	"with",
	"on",
	"at",
	"by",
	"from",
	"as",
	"be",
	"was",
	"are",
	"have",
	"has",
	"had",
	"do",
	"does",
	"did",
	"will",
	"would",
	"could",
	"should",
	"can",
	"may",
	"not",
	"but",
	"if",
	"then",
	"so",
	"just",
	"like",
	"also",
	"how",
	"what",
	"when",
	"where",
	"why",
	"who",
	"which",
	"there",
	"here",
	"all",
	"each",
	"every",
	"some",
	"any",
	"no",
	"more",
	"most",
	"other",
	"into",
	"over",
	"after",
	"before",
	"between",
	"out",
	"up",
	"down",
	"about",
	"above",
	"below",
	"than",
	"very",
	"too",
	"now",
	"only",
	"still",
	"already",
	"my",
	"your",
	"our",
	"its",
	"me",
	"you",
	"we",
	"they",
	"them",
	"i",
	"he",
	"she",
	"us",
	"him",
	"her",
	"please",
	"thanks",
	"thank",
	"hey",
	"hi",
	"hello",
	"sure",
	"okay",
	"ok",
	"make",
	"want",
	"need",
	"use",
	"get",
	"let",
	"try",
	"see",
	"know",
	"think",
	"look",
	"work",
	"going",
	"been",
	"being",
	"much",
	"many",
]);

/**
 * Tool definition for AI-powered entity extraction from conversation text.
 * Replaces brittle regex patterns with structured AI output.
 */
const CONVERSATION_ENTITY_EXTRACTION_TOOL: Tool = {
	functionDeclarations: [
		{
			name: "extractConversationEntities",
			description:
				"Extracts file paths, code identifiers, and main discussion topics from conversation text. " +
				"Identifies specific file references (e.g., 'src/auth/login.ts'), code component names " +
				"(e.g., 'AuthService', 'useLoginHook', 'UserModel'), and key technical topics being discussed.",
			parameters: {
				type: SchemaType.OBJECT,
				properties: {
					filePaths: {
						type: SchemaType.ARRAY,
						description:
							"File paths found in the text. Include relative paths, absolute paths, and filename references. " +
							"Examples: 'src/services/auth.ts', 'package.json', 'components/Login.tsx'.",
						items: { type: SchemaType.STRING },
					},
					codeIdentifiers: {
						type: SchemaType.ARRAY,
						description:
							"Named code entities like classes, interfaces, functions, hooks, services, components, types, " +
							"enums, middleware, etc. Only include specific identifiers (PascalCase/camelCase names), NOT generic words. " +
							"Examples: 'AuthService', 'useLoginHook', 'UserController', 'handleSubmit', 'IUserProfile'.",
						items: { type: SchemaType.STRING },
					},
					mainTopics: {
						type: SchemaType.ARRAY,
						description:
							"The 3-8 main technical topics being discussed. These are domain concepts, not individual words. " +
							"Examples: 'user authentication', 'database migration', 'frontend routing', 'API error handling'.",
						items: { type: SchemaType.STRING },
					},
				},
				required: ["filePaths", "codeIdentifiers", "mainTopics"],
			},
		},
	],
};

/**
 * Uses AI (DEFAULT_FLASH_LITE_MODEL) with function calling to extract
 * file paths, code identifiers, and topics from conversation text.
 * This replaces brittle regex patterns with structured AI extraction.
 */
async function extractConversationEntitiesViaAI(
	conversationText: string,
	aiRequestService: AIRequestService,
	cancellationToken?: import("vscode").CancellationToken,
): Promise<ConversationEntityExtraction> {
	const apiKey = aiRequestService.getActiveApiKey();
	if (!apiKey) {
		console.warn(
			"[ChatHistoryAnalyzer] No API key available for AI extraction, returning empty.",
		);
		return { filePaths: [], codeIdentifiers: [], mainTopics: [] };
	}

	// Truncate input to keep it small for the lite model
	const truncatedText =
		conversationText.length > 8000
			? conversationText.substring(conversationText.length - 8000)
			: conversationText;

	const contents: Content[] = [
		{
			role: "user",
			parts: [
				{
					text: `Extract all file paths, code identifiers, and main discussion topics from the following conversation text.\n\nConversation:\n"""\n${truncatedText}\n"""`,
				},
			],
		},
	];

	try {
		const result = await aiRequestService.generateFunctionCall(
			apiKey,
			DEFAULT_FLASH_LITE_MODEL,
			contents,
			[CONVERSATION_ENTITY_EXTRACTION_TOOL],
			FunctionCallingMode.ANY,
			"You are a precise entity extractor for developer conversation analysis. Extract only clearly identifiable entities — do not guess or hallucinate.",
			undefined,
			cancellationToken,
			"conversation_entity_extraction",
		);

		if (result?.functionCall?.args) {
			const args = result.functionCall.args as any;
			return {
				filePaths: Array.isArray(args.filePaths)
					? args.filePaths.filter(
							(s: unknown): s is string => typeof s === "string",
						)
					: [],
				codeIdentifiers: Array.isArray(args.codeIdentifiers)
					? args.codeIdentifiers.filter(
							(s: unknown): s is string => typeof s === "string",
						)
					: [],
				mainTopics: Array.isArray(args.mainTopics)
					? args.mainTopics.filter(
							(s: unknown): s is string => typeof s === "string",
						)
					: [],
			};
		}
	} catch (error) {
		console.warn(
			"[ChatHistoryAnalyzer] AI entity extraction failed, returning empty:",
			error,
		);
	}

	return { filePaths: [], codeIdentifiers: [], mainTopics: [] };
}

/**
 * Tool definition for AI-powered implicit assumption detection.
 * Analyzes the user's current request for unspoken expectations.
 */
const IMPLICIT_ASSUMPTION_DETECTION_TOOL: Tool = {
	functionDeclarations: [
		{
			name: "detectImplicitAssumptions",
			description:
				"Analyzes a user's current request in the context of their recent conversation topics " +
				"and previously discussed code to determine what the user implicitly assumes the AI already knows. " +
				"Detects continuity signals (e.g., 'the other bug', 'now do X'), familiarity expectations " +
				"(e.g., referring to components discussed earlier), and domain context assumptions.",
			parameters: {
				type: SchemaType.OBJECT,
				properties: {
					assumptions: {
						type: SchemaType.ARRAY,
						description:
							"List of implicit assumptions the user is making. Each should be a clear, " +
							"concise statement. Examples: 'User assumes continuity with previous auth discussion', " +
							"'User expects AI to remember the UserService refactoring', " +
							"'User refers to a bug mentioned earlier without re-explaining it'. " +
							"Return an empty array if the request is fully self-contained with no implicit assumptions.",
						items: { type: SchemaType.STRING },
					},
					hasContinuitySignal: {
						type: SchemaType.BOOLEAN,
						description:
							"True if the request contains language suggesting it continues a previous topic " +
							"(e.g., 'also', 'the other', 'same thing', 'next', 'remaining', 'that bug', etc.)",
					},
				},
				required: ["assumptions", "hasContinuitySignal"],
			},
		},
	],
};

/**
 * Uses AI (DEFAULT_FLASH_LITE_MODEL) to detect implicit assumptions
 * in the user's current request, replacing regex-based continuity detection.
 */
async function detectImplicitAssumptionsViaAI(
	currentRequest: string,
	recentTopics: string[],
	codeIdentifiers: string[],
	topicDepth: number,
	aiRequestService: AIRequestService,
	cancellationToken?: import("vscode").CancellationToken,
): Promise<string[]> {
	const apiKey = aiRequestService.getActiveApiKey();
	if (!apiKey) {
		return [];
	}

	const contextLines: string[] = [];
	if (recentTopics.length > 0) {
		contextLines.push(
			`Recent discussion topics: ${recentTopics.slice(0, 8).join(", ")}`,
		);
	}
	if (codeIdentifiers.length > 0) {
		contextLines.push(
			`Previously mentioned code: ${codeIdentifiers.slice(0, 8).join(", ")}`,
		);
	}
	if (topicDepth > 0) {
		contextLines.push(
			`The user has discussed the top topic for ${topicDepth} consecutive messages.`,
		);
	}

	const contextBlock =
		contextLines.length > 0
			? `\nConversation context:\n${contextLines.join("\n")}\n`
			: "";

	const contents: Content[] = [
		{
			role: "user",
			parts: [
				{
					text: `Analyze this user request for implicit assumptions — things the user expects the AI to already know from prior conversation.\n${contextBlock}\nUser's current request: "${currentRequest}"`,
				},
			],
		},
	];

	try {
		const result = await aiRequestService.generateFunctionCall(
			apiKey,
			DEFAULT_FLASH_LITE_MODEL,
			contents,
			[IMPLICIT_ASSUMPTION_DETECTION_TOOL],
			FunctionCallingMode.ANY,
			"You are an expert at reading between the lines in developer conversations. Detect what the user implicitly assumes the AI knows. Be precise — only flag genuine assumptions, not obvious statements.",
			undefined,
			cancellationToken,
			"implicit_assumption_detection",
		);

		if (result?.functionCall?.args) {
			const args = result.functionCall.args as any;
			if (Array.isArray(args.assumptions)) {
				return args.assumptions.filter(
					(s: unknown): s is string =>
						typeof s === "string" && (s as string).length > 0,
				);
			}
		}
	} catch (error) {
		console.warn(
			"[ChatHistoryAnalyzer] AI implicit assumption detection failed:",
			error,
		);
	}

	return [];
}

/**
 * Extracts structured topic context from conversation history.
 * Uses AI-powered extraction (via DEFAULT_FLASH_LITE_MODEL function calling)
 * for file paths and code identifiers instead of regex patterns.
 *
 * @param chatHistory - The conversation history entries
 * @param currentRequest - The user's current request text
 * @param aiRequestService - Optional AI service for entity extraction. If not provided, falls back to word frequency only.
 * @param cancellationToken - Optional cancellation token
 */
export async function extractConversationContext(
	chatHistory: readonly HistoryEntry[],
	currentRequest: string,
	aiRequestService?: AIRequestService,
	cancellationToken?: import("vscode").CancellationToken,
): Promise<ConversationTopicContext> {
	if (!chatHistory || chatHistory.length === 0) {
		return {
			recentTopics: [],
			recentlyMentionedFiles: [],
			workingDomain: "No prior conversation context",
			conversationMomentum: "Fresh conversation",
			implicitAssumptions: [],
			topicDepth: 0,
		};
	}

	// Only analyze non-agent-log entries (user + model)
	const relevantHistory = chatHistory.filter(
		(entry) => !entry.isContextAgentLog,
	);
	// Take the last 10 turns for richer analysis (vs. the previous 5)
	const recentHistory = relevantHistory.slice(-10);

	// 1. Extract topics via word frequency analysis
	const wordFrequency = new Map<string, number>();
	const allUserText: string[] = [];
	const allModelText: string[] = [];

	for (const entry of recentHistory) {
		const text = entry.parts
			.filter((p): p is { text: string } => "text" in p)
			.map((p) => p.text)
			.join(" ");

		if (entry.role === "user") {
			allUserText.push(text);
		} else {
			allModelText.push(text);
		}

		// Extract meaningful words (3+ chars, not stop words, not pure numbers)
		const words = text
			.toLowerCase()
			.replace(/[^a-z0-9\s_-]/g, " ")
			.split(/\s+/)
			.filter((w) => w.length >= 3 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));

		for (const word of words) {
			wordFrequency.set(word, (wordFrequency.get(word) || 0) + 1);
		}
	}

	// Sort by frequency and take top topics
	const recentTopics = Array.from(wordFrequency.entries())
		.sort((a, b) => b[1] - a[1])
		.slice(0, 15)
		.map(([word]) => word);

	// 2. Extract mentioned file paths and code identifiers via AI
	const mentionedFiles = new Set<string>();
	const codeIdentifiers = new Set<string>();

	const fullText = [...allUserText, ...allModelText].join("\n");

	if (aiRequestService && fullText.length > 0) {
		const extraction = await extractConversationEntitiesViaAI(
			fullText,
			aiRequestService,
			cancellationToken,
		);

		for (const fp of extraction.filePaths) {
			mentionedFiles.add(fp);
		}
		for (const id of extraction.codeIdentifiers) {
			codeIdentifiers.add(id);
		}

		// Merge AI-extracted topics with word frequency topics
		if (extraction.mainTopics.length > 0) {
			// AI topics get top priority — prepend them
			const aiTopicsLower = extraction.mainTopics.map((t) => t.toLowerCase());
			const mergedTopics = [
				...aiTopicsLower,
				...recentTopics.filter(
					(t) => !aiTopicsLower.some((at) => at.includes(t) || t.includes(at)),
				),
			];
			recentTopics.length = 0;
			recentTopics.push(...mergedTopics.slice(0, 15));
		}
	}

	// 3. Calculate topic depth — how many consecutive messages share the same topic
	let topicDepth = 0;
	if (recentTopics.length > 0) {
		const topTopic = recentTopics[0];
		// Count consecutive messages from the end that mention the top topic
		for (let i = recentHistory.length - 1; i >= 0; i--) {
			const entryText = recentHistory[i].parts
				.filter((p): p is { text: string } => "text" in p)
				.map((p) => p.text)
				.join(" ")
				.toLowerCase();
			if (entryText.includes(topTopic)) {
				topicDepth++;
			} else {
				break;
			}
		}
	}

	// 4. Build working domain summary
	const domainHints: string[] = [];
	if (recentTopics.length > 0) {
		domainHints.push(`Key topics: ${recentTopics.slice(0, 5).join(", ")}`);
	}
	if (codeIdentifiers.size > 0) {
		domainHints.push(
			`Referenced components: ${Array.from(codeIdentifiers).slice(0, 5).join(", ")}`,
		);
	}
	const workingDomain =
		domainHints.length > 0 ? domainHints.join(". ") : "General discussion";

	// 5. Build conversational momentum
	let conversationMomentum: string;
	if (topicDepth >= 3) {
		conversationMomentum = `User has been deeply focused on "${recentTopics[0]}" for ${topicDepth} consecutive messages. This is likely a continuing investigation.`;
	} else if (topicDepth >= 1) {
		conversationMomentum = `User recently discussed "${recentTopics[0]}". This may be a continuation or a related topic.`;
	} else {
		conversationMomentum =
			"This appears to be a new topic or direction change.";
	}

	// 6. Derive implicit assumptions via AI (or graceful fallback)
	const implicitAssumptions: string[] = [];

	if (aiRequestService) {
		const assumptionResults = await detectImplicitAssumptionsViaAI(
			currentRequest,
			recentTopics,
			Array.from(codeIdentifiers),
			topicDepth,
			aiRequestService,
			cancellationToken,
		);
		implicitAssumptions.push(...assumptionResults);
	}

	// Fallback: if AI didn't return anything useful, use topic-depth heuristic
	if (implicitAssumptions.length === 0) {
		if (topicDepth >= 2) {
			implicitAssumptions.push(
				`User likely assumes AI remembers details from the ongoing "${recentTopics[0]}" discussion (${topicDepth} messages deep)`,
			);
		} else if (recentHistory.length > 2) {
			implicitAssumptions.push(
				"User may assume AI has context from the conversation above",
			);
		}
	}

	return {
		recentTopics,
		recentlyMentionedFiles: Array.from(mentionedFiles),
		workingDomain,
		conversationMomentum,
		implicitAssumptions,
		topicDepth,
	};
}

/**
 * Formats the conversation topic context into a prompt-friendly string
 * for injection into the context agent's system prompt.
 */
export function formatConversationContextForPrompt(
	context: ConversationTopicContext,
): string {
	if (
		context.recentTopics.length === 0 &&
		context.recentlyMentionedFiles.length === 0
	) {
		return "";
	}

	const lines: string[] = ["--- Conversation Intelligence ---"];

	lines.push(`Momentum: ${context.conversationMomentum}`);

	if (context.recentTopics.length > 0) {
		lines.push(
			`Recurring Topics: ${context.recentTopics.slice(0, 8).join(", ")}`,
		);
	}

	if (context.recentlyMentionedFiles.length > 0) {
		lines.push(
			`Previously Discussed Files: ${context.recentlyMentionedFiles.slice(0, 10).join(", ")}`,
		);
	}

	if (context.implicitAssumptions.length > 0) {
		lines.push(`Implicit Assumptions:`);
		for (const assumption of context.implicitAssumptions) {
			lines.push(`  - ${assumption}`);
		}
	}

	lines.push("--- End Conversation Intelligence ---");

	return lines.join("\n");
}
