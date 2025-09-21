import { z } from "zod";

// Define schema for image part data (adjust based on actual type if different)
const imageInlineDataSchema = z.object({
	inlineData: z.object({
		data: z.string(), // Base64 encoded image data
		mimeType: z.string(), // e.g., 'image/png'
	}),
});

// Schemas for specific message types
const planRequestSchema = z.object({
	type: z.literal("planRequest"),
	value: z.string().nonempty("Plan description cannot be empty."),
});

const chatMessageSchema = z.object({
	type: z.literal("chatMessage"),
	value: z.string(), // User message text
	groundingEnabled: z.boolean().optional(),
	imageParts: z.array(imageInlineDataSchema).optional(),
});

const editChatMessageSchema = z.object({
	type: z.literal("editChatMessage"),
	messageIndex: z
		.number()
		.int()
		.nonnegative("Message index must be non-negative."),
	newContent: z.string().nonempty("New content cannot be empty."),
});

const openFileSchema = z.object({
	type: z.literal("openFile"),
	value: z
		.string()
		.nonempty("File path cannot be empty.")
		.refine((val) => val.trim() !== "", {
			message: "File path cannot be empty or whitespace only.",
		}),
});

const universalCancelSchema = z.object({ type: z.literal("universalCancel") });
const webviewReadySchema = z.object({ type: z.literal("webviewReady") });
const confirmPlanExecutionSchema = z.object({
	type: z.literal("confirmPlanExecution"),
});
const retryStructuredPlanGenerationSchema = z.object({
	type: z.literal("retryStructuredPlanGeneration"),
});
const revertRequestSchema = z.object({ type: z.literal("revertRequest") });
const commitRequestSchema = z.object({ type: z.literal("commitRequest") });
const confirmCommitSchema = z.object({
	type: z.literal("confirmCommit"),
	value: z.string(),
}); // Assuming value for confirmCommit
const cancelCommitSchema = z.object({ type: z.literal("cancelCommit") });
const getTokenStatisticsSchema = z.object({
	type: z.literal("getTokenStatistics"),
});
const getCurrentTokenEstimatesSchema = z.object({
	type: z.literal("getCurrentTokenEstimates"),
	value: z.object({
		inputText: z.string().optional(),
		outputText: z.string().optional(),
	}),
}); // Based on usage in existing code
const openSidebarSchema = z.object({ type: z.literal("openSidebar") });
const addApiKeySchema = z.object({
	type: z.literal("addApiKey"),
	value: z.string(),
}); // Based on usage
const requestDeleteConfirmationSchema = z.object({
	type: z.literal("requestDeleteConfirmation"),
});
const switchToNextKeySchema = z.object({ type: z.literal("switchToNextKey") });
const switchToPrevKeySchema = z.object({ type: z.literal("switchToPrevKey") });
const requestClearChatConfirmationSchema = z.object({
	type: z.literal("requestClearChatConfirmation"),
});
const confirmClearChatAndRevertSchema = z.object({
	type: z.literal("confirmClearChatAndRevert"),
});
const cancelClearChatSchema = z.object({ type: z.literal("cancelClearChat") });
const saveChatRequestSchema = z.object({ type: z.literal("saveChatRequest") });
const loadChatRequestSchema = z.object({ type: z.literal("loadChatRequest") });
const deleteSpecificMessageSchema = z.object({
	type: z.literal("deleteSpecificMessage"),
	messageIndex: z.number(),
}); // Based on usage
const toggleRelevantFilesDisplaySchema = z.object({
	type: z.literal("toggleRelevantFilesDisplay"),
	messageIndex: z.number(),
	isExpanded: z.boolean(),
}); // Based on usage
const selectModelSchema = z.object({
	type: z.literal("selectModel"),
	value: z.string(),
}); // Based on usage
const openExternalLinkSchema = z.object({
	type: z.literal("openExternalLink"),
	url: z.string(),
}); // Based on usage
const openSettingsPanelSchema = z.object({
	type: z.literal("openSettingsPanel"),
	panelId: z.string().optional(),
}); // Based on usage
const generatePlanPromptFromAIMessageSchema = z.object({
	type: z.literal("generatePlanPromptFromAIMessage"),
	payload: z.object({ messageIndex: z.number() }),
}); // Based on usage
const aiResponseEndSchema = z.object({
	type: z.literal("aiResponseEnd"),
	success: z.boolean(),
	isPlanResponse: z.boolean().optional(),
	requiresConfirmation: z.boolean().optional(),
}); // Based on usage
const structuredPlanParseFailedSchema = z.object({
	type: z.literal("structuredPlanParseFailed"),
	value: z.object({ error: z.any(), failedJson: z.any() }),
}); // Based on usage
const commitReviewSchema = z.object({
	type: z.literal("commitReview"),
	value: z.object({
		commitMessage: z.string(),
		stagedFiles: z.array(z.string()),
		fileChangeSummaries: z.array(z.string()).optional(),
	}),
}); // Based on usage

const requestWorkspaceFilesSchema = z.object({
	type: z.literal("requestWorkspaceFiles"),
});

// Schema for a new feature request message
const newFeatureRequestSchema = z.object({
	type: z.literal("newFeatureRequest"), // Unique discriminator
	featureName: z.string().nonempty("Feature name cannot be empty."),
	description: z.string().nonempty("Feature description cannot be empty."),
});

const operationCancelledConfirmationSchema = z.object({
	type: z.literal("operationCancelledConfirmation"),
});

const copyContextMessageSchema = z.object({
	type: z.literal("copyContextMessage"),
	payload: z.object({
		messageIndex: z.number().int().nonnegative(),
	}),
});

export const allMessageSchemas = z.discriminatedUnion("type", [
	planRequestSchema,
	chatMessageSchema,
	editChatMessageSchema,
	openFileSchema,
	universalCancelSchema,
	webviewReadySchema,
	confirmPlanExecutionSchema,
	retryStructuredPlanGenerationSchema,
	revertRequestSchema,
	commitRequestSchema,
	confirmCommitSchema,
	cancelCommitSchema,
	getTokenStatisticsSchema,
	getCurrentTokenEstimatesSchema,
	openSidebarSchema,
	addApiKeySchema,
	requestDeleteConfirmationSchema,
	switchToNextKeySchema,
	switchToPrevKeySchema,
	requestClearChatConfirmationSchema,
	confirmClearChatAndRevertSchema,
	cancelClearChatSchema,
	saveChatRequestSchema,
	loadChatRequestSchema,
	deleteSpecificMessageSchema,
	toggleRelevantFilesDisplaySchema,
	selectModelSchema,
	openExternalLinkSchema,
	openSettingsPanelSchema,
	generatePlanPromptFromAIMessageSchema,
	aiResponseEndSchema,
	structuredPlanParseFailedSchema,
	commitReviewSchema,
	operationCancelledConfirmationSchema, // Integrated new schema here
	requestWorkspaceFilesSchema, // Added here, before the final schema
	newFeatureRequestSchema,
	copyContextMessageSchema, // New schema added here
]);

// Export individual schemas if they are needed for more granular error reporting
export {
	planRequestSchema,
	chatMessageSchema,
	editChatMessageSchema,
	openFileSchema,
	newFeatureRequestSchema,
	copyContextMessageSchema,
	commitReviewSchema,
};
