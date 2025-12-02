const STOP_WORDS = new Set([
	"a",
	"about",
	"above",
	"after",
	"again",
	"against",
	"all",
	"am",
	"an",
	"and",
	"any",
	"are",
	"aren't",
	"as",
	"at",
	"be",
	"because",
	"been",
	"before",
	"being",
	"below",
	"between",
	"both",
	"but",
	"by",
	"can't",
	"cannot",
	"could",
	"couldn't",
	"did",
	"didn't",
	"do",
	"does",
	"doesn't",
	"doing",
	"don't",
	"down",
	"during",
	"each",
	"few",
	"for",
	"from",
	"further",
	"had",
	"hadn't",
	"has",
	"hasn't",
	"have",
	"haven't",
	"having",
	"he",
	"he'd",
	"he'll",
	"he's",
	"her",
	"here",
	"here's",
	"hers",
	"herself",
	"him",
	"himself",
	"his",
	"how",
	"how's",
	"i",
	"i'd",
	"i'll",
	"i'm",
	"i've",
	"if",
	"in",
	"into",
	"is",
	"isn't",
	"it",
	"it's",
	"its",
	"itself",
	"let's",
	"me",
	"more",
	"most",
	"mustn't",
	"my",
	"myself",
	"no",
	"nor",
	"not",
	"of",
	"off",
	"on",
	"once",
	"only",
	"or",
	"other",
	"ought",
	"our",
	"ours",
	"ourselves",
	"out",
	"over",
	"own",
	"same",
	"shan't",
	"she",
	"she'd",
	"she'll",
	"she's",
	"should",
	"shouldn't",
	"so",
	"some",
	"such",
	"than",
	"that",
	"that's",
	"the",
	"their",
	"theirs",
	"them",
	"themselves",
	"then",
	"there",
	"there's",
	"these",
	"they",
	"they'd",
	"they'll",
	"they're",
	"they've",
	"this",
	"those",
	"through",
	"to",
	"too",
	"under",
	"until",
	"up",
	"very",
	"was",
	"wasn't",
	"we",
	"we'd",
	"we'll",
	"we're",
	"we've",
	"were",
	"weren't",
	"what",
	"what's",
	"when",
	"when's",
	"where",
	"where's",
	"which",
	"while",
	"who",
	"who's",
	"whom",
	"why",
	"why's",
	"with",
	"won't",
	"would",
	"wouldn't",
	"you",
	"you'd",
	"you'll",
	"you're",
	"you've",
	"your",
	"yours",
	"yourself",
	"yourselves",
	"file",
	"code",
	"function",
	"class",
	"method",
	"variable",
	"parameter",
	"return",
	"import",
	"export",
	"const",
	"let",
	"var",
	"interface",
	"type",
	"public",
	"private",
	"protected",
	"static",
	"async",
	"await",
	"new",
	"this",
	"super",
	"extends",
	"implements",
	"from",
	"module",
]);

/**
 * Represents a semantic link between two files, with a score indicating similarity.
 */
export interface SemanticLink {
	relatedPath: string;
	score: number;
}

/**
 * A graph structure where each key is a file path and the value is an array of
 * semantic links to other files.
 */
export type SemanticGraph = Map<string, SemanticLink[]>;

/**
 * Calculates the cosine similarity between two TF-IDF vectors.
 * @param vectorA The first TF-IDF vector (Map<term, score>).
 * @param vectorB The second TF-IDF vector (Map<term, score>).
 * @returns The cosine similarity score between 0 and 1.
 */
function calculateCosineSimilarity(
	vectorA: Map<string, number>,
	vectorB: Map<string, number>
): number {
	let dotProduct = 0;
	let magnitudeA = 0;
	let magnitudeB = 0;

	const termsA = new Set(vectorA.keys());
	const termsB = new Set(vectorB.keys());
	const allTerms = new Set([...termsA, ...termsB]);

	for (const term of allTerms) {
		const scoreA = vectorA.get(term) || 0;
		const scoreB = vectorB.get(term) || 0;
		dotProduct += scoreA * scoreB;
		magnitudeA += scoreA * scoreA;
		magnitudeB += scoreB * scoreB;
	}

	if (magnitudeA === 0 || magnitudeB === 0) {
		return 0;
	}

	return dotProduct / (Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB));
}

/**
 * Builds a weighted graph representing the conceptual similarity between files.
 * It uses a TF-IDF algorithm on AI-generated summaries to score relationships.
 *
 * @param fileSummaries A map where keys are file paths and values are their summaries.
 * @returns A SemanticGraph where each file is linked to conceptually similar files.
 */
export function buildSemanticGraph(
	fileSummaries: Map<string, string>
): SemanticGraph {
	const filePaths = Array.from(fileSummaries.keys());
	if (filePaths.length < 2) {
		return new Map();
	}

	const tfMaps = new Map<string, Map<string, number>>();
	const dfMap = new Map<string, number>();
	const totalDocs = filePaths.length;

	// 1. Calculate Term Frequencies (TF) and Document Frequencies (DF)
	for (const filePath of filePaths) {
		const summary = fileSummaries.get(filePath) || "";
		const tokens = (summary.match(/\b\w+\b/g) || []).map((t) =>
			t.toLowerCase()
		);
		const termFrequencies = new Map<string, number>();

		for (const token of tokens) {
			if (!STOP_WORDS.has(token) && token.length > 1) {
				termFrequencies.set(token, (termFrequencies.get(token) || 0) + 1);
			}
		}
		tfMaps.set(filePath, termFrequencies);

		const uniqueTokens = new Set(termFrequencies.keys());
		for (const token of uniqueTokens) {
			dfMap.set(token, (dfMap.get(token) || 0) + 1);
		}
	}

	// 2. Calculate TF-IDF vectors for each file
	const tfidfVectors = new Map<string, Map<string, number>>();
	for (const filePath of filePaths) {
		const termFrequencies = tfMaps.get(filePath);
		if (!termFrequencies) {
			continue;
		}

		const tfidfVector = new Map<string, number>();
		for (const [term, tf] of termFrequencies.entries()) {
			const df = dfMap.get(term) || 1;
			const idf = Math.log(totalDocs / df);
			const tfidf = tf * idf;
			tfidfVector.set(term, tfidf);
		}
		tfidfVectors.set(filePath, tfidfVector);
	}

	// 3. Calculate cosine similarity and build the graph
	const semanticGraph: SemanticGraph = new Map();
	for (let i = 0; i < filePaths.length; i++) {
		for (let j = i + 1; j < filePaths.length; j++) {
			const pathA = filePaths[i];
			const pathB = filePaths[j];

			const vectorA = tfidfVectors.get(pathA);
			const vectorB = tfidfVectors.get(pathB);

			if (!vectorA || !vectorB) {
				continue;
			}

			const similarity = calculateCosineSimilarity(vectorA, vectorB);

			if (similarity > 0.01) {
				// Threshold to avoid noise
				if (!semanticGraph.has(pathA)) {
					semanticGraph.set(pathA, []);
				}
				semanticGraph
					.get(pathA)!
					.push({ relatedPath: pathB, score: similarity });

				if (!semanticGraph.has(pathB)) {
					semanticGraph.set(pathB, []);
				}
				semanticGraph
					.get(pathB)!
					.push({ relatedPath: pathA, score: similarity });
			}
		}
	}

	// 4. Sort links by score for each file
	for (const links of semanticGraph.values()) {
		links.sort((a, b) => b.score - a.score);
	}

	return semanticGraph;
}
