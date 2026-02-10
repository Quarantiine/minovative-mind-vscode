import { FunctionDeclaration, SchemaType } from "@google/generative-ai";

/**
 * Defines the 'think' tool, which allows the AI to express its reasoning process.
 * This tool should be used for planning, analyzing, and self-correction.
 */
export const thinkingTool: FunctionDeclaration = {
	name: "think",
	description:
		"Use this tool to think about the problem, analyze context, and plan your next steps. The user will see your thoughts. This helps you make better decisions and debug issues. You can use this tool multiple times before taking a final action.",
	parameters: {
		type: SchemaType.OBJECT,
		properties: {
			thought: {
				type: SchemaType.STRING,
				description: "Your detailed thoughts and reasoning.",
			},
		},
		required: ["thought"],
	},
};

export const suggestFixTool: FunctionDeclaration = {
	name: "suggest_fix",
	description: "Provides an analysis of the error and a suggested fix.",
	parameters: {
		type: SchemaType.OBJECT,
		properties: {
			analysis: {
				type: SchemaType.STRING,
				description: "Brief analysis of why the error occurred.",
			},
			suggestion: {
				type: SchemaType.STRING,
				description:
					"Concrete actionable suggestion (e.g., 'Create the missing directory', 'Fix the syntax error').",
			},
		},
		required: ["analysis", "suggestion"],
	},
};
