// src/sidebar/common/sidebarConstants.ts

// Secret storage keys
export const GEMINI_API_KEY_SECRET_KEY = "geminiApiKey";

// Workspace state keys
export const MODEL_SELECTION_STORAGE_KEY = "geminiSelectedModel";

// DONT CHANGE THESE MODELS (NEVER)
export const MODEL_DETAILS = [
	{
		name: "gemini-2.5-pro",
		description: "Freemium | Powerful 🧠🧠",
	},
	{
		name: "gemini-flash-latest",
		description: "Freemium | Everyday Use 🧠⚡",
	},
	{
		name: "gemini-flash-lite-latest",
		description: "Freemium | Simple ⚡",
	},
];

export const AVAILABLE_GEMINI_MODELS = MODEL_DETAILS.map((model) => model.name);

export const DEFAULT_PRO_MODEL = "gemini-2.5-pro";
export const DEFAULT_FLASH_MODEL = "gemini-flash-latest";
export const DEFAULT_FLASH_LITE_MODEL = "gemini-flash-lite-latest";
export const DEFAULT_EMBEDDING_MODEL = "gemini-embedding-001";

export const DEFAULT_MODEL =
	(AVAILABLE_GEMINI_MODELS.length > 0 &&
		AVAILABLE_GEMINI_MODELS.find((model) => model === "gemini-2.5-flash")) ||
	AVAILABLE_GEMINI_MODELS[AVAILABLE_GEMINI_MODELS.length - 1];

export const TEMPERATURE = 2;
export const DEFAULT_SIZE = 1024 * 1024 * 1;

// Minovative commands for the chat input
export const MINOVATIVE_COMMANDS = ["/plan", "/commit"];

// Optimization settings keys (heuristics context)
export const OPTIMIZATION_SETTINGS_KEYS = {
	MAX_HEURISTIC_FILES_TOTAL: "heuristicContext.maxHeuristicFilesTotal",
	MAX_SAME_DIRECTORY_FILES: "heuristicContext.maxSameDirectoryFiles",
	MAX_DIRECT_DEPENDENCIES: "heuristicContext.maxDirectDependencies",
	MAX_REVERSE_DEPENDENCIES: "heuristicContext.maxReverseDependencies",
	MAX_CALL_HIERARCHY_FILES: "heuristicContext.maxCallHierarchyFiles",
};

// Default optimization settings for heuristics context
export const DEFAULT_OPTIMIZATION_SETTINGS = {
	[OPTIMIZATION_SETTINGS_KEYS.MAX_HEURISTIC_FILES_TOTAL]: 30,
	[OPTIMIZATION_SETTINGS_KEYS.MAX_SAME_DIRECTORY_FILES]: 15,
	[OPTIMIZATION_SETTINGS_KEYS.MAX_DIRECT_DEPENDENCIES]: 10,
	[OPTIMIZATION_SETTINGS_KEYS.MAX_REVERSE_DEPENDENCIES]: 10,
	[OPTIMIZATION_SETTINGS_KEYS.MAX_CALL_HIERARCHY_FILES]: 10,
};
