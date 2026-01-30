// src/ai/workflowPlanner.ts
import * as vscode from "vscode";
import * as path from "path";
import { loadGitIgnoreMatcher } from "../utils/ignoreUtils";

/**
 * Defines the possible actions within an execution plan step.
 */
export enum PlanStepAction {
	CreateDirectory = "create_directory",
	CreateFile = "create_file",
	ModifyFile = "modify_file",
	RunCommand = "run_command",
}

// --- Nested Detail Interfaces for Plan Steps ---

interface CreateDirectoryStepDetails {
	action: PlanStepAction.CreateDirectory;
	path: string;
	description?: string;
}

interface CreateFileStepDetails {
	action: PlanStepAction.CreateFile;
	path: string;
	content?: string;
	generate_prompt?: string;
	description?: string;
	use_context_agent?: boolean;
}

interface ModifyFileStepDetails {
	action: PlanStepAction.ModifyFile;
	path: string;
	modification_prompt: string;
	description?: string;
	use_context_agent?: boolean;
}

interface RunCommandStepDetails {
	action: PlanStepAction.RunCommand;
	command: string;
	description?: string;
}

// --- Wrapper Interfaces for each step type ---

export interface CreateDirectoryStep {
	step: CreateDirectoryStepDetails;
}
export interface CreateFileStep {
	step: CreateFileStepDetails;
}
export interface ModifyFileStep {
	step: ModifyFileStepDetails;
}
export interface RunCommandStep {
	step: RunCommandStepDetails;
}

/**
 * A union type representing any possible step in a plan.
 * The structure is nested to group all step details under the 'step' property.
 */
export type PlanStep =
	| CreateDirectoryStep
	| CreateFileStep
	| ModifyFileStep
	| RunCommandStep;

/**
 * Represents the overall structure of the execution plan.
 */
export interface ExecutionPlan {
	planDescription: string;
	steps: PlanStep[];
}

// --- Type Guards (Updated for Nested Structure) ---

export function isCreateDirectoryStep(step: any): step is CreateDirectoryStep {
	return (
		step?.step?.action === PlanStepAction.CreateDirectory &&
		typeof step.step.path === "string" &&
		step.step.path.trim() !== ""
	);
}

export function isCreateFileStep(step: any): step is CreateFileStep {
	const details = step?.step;
	if (!details || details.action !== PlanStepAction.CreateFile) {
		return false;
	}
	const hasPath =
		typeof details.path === "string" && details.path.trim() !== "";
	const hasContent = typeof details.content === "string";
	const hasGeneratePrompt = typeof details.generate_prompt === "string";

	// A create file step must have a path and EITHER content OR a generate_prompt, but not both.
	return hasPath && hasContent !== hasGeneratePrompt;
}

export function isModifyFileStep(step: any): step is ModifyFileStep {
	return (
		step?.step?.action === PlanStepAction.ModifyFile &&
		typeof step.step.path === "string" &&
		step.step.path.trim() !== "" &&
		typeof step.step.modification_prompt === "string" &&
		step.step.modification_prompt.trim() !== ""
	);
}

export function isRunCommandStep(step: any): step is RunCommandStep {
	return (
		step?.step?.action === PlanStepAction.RunCommand &&
		typeof step.step.command === "string" &&
		step.step.command.trim() !== ""
	);
}

/**
 * Represents the result of parsing and validating an execution plan.
 */
export interface ParsedPlanResult {
	plan: ExecutionPlan | null;
	error?: string;
}

/**
 * Parses a JSON string or object into an ExecutionPlan and performs validation and sanitization.
 * This function now transforms the flat step structure from the AI into the nested structure used internally.
 *
 * @param source The raw JSON string received from the AI, or a direct plan object.
 * @param workspaceRootUri The URI of the workspace root.
 * @returns An object containing the validated ExecutionPlan or an error message.
 */
export async function parseAndValidatePlan(
	source: string | object, // Updated parameter type
	workspaceRootUri: vscode.Uri,
): Promise<ParsedPlanResult> {
	console.log("Attempting to parse and validate plan source:", source);

	let potentialPlan: any;

	try {
		if (typeof source === "object" && source !== null) {
			potentialPlan = source;
			console.log("Using direct object as potential plan.");
		} else if (typeof source === "string") {
			const jsonString = source;
			console.log("Parsing plan from string JSON:", jsonString);

			let cleanedString = jsonString
				.replace(/```(json|typescript)?/g, "")
				.replace(/```/g, "");
			cleanedString = cleanedString.trim();

			const firstBraceIndex = cleanedString.indexOf("{");
			const lastBraceIndex = cleanedString.lastIndexOf("}");

			if (
				firstBraceIndex === -1 ||
				lastBraceIndex === -1 ||
				lastBraceIndex < firstBraceIndex
			) {
				const errorMsg =
					"Error parsing plan JSON: Could not find a valid JSON object within the response.";
				console.error(errorMsg, jsonString);
				return { plan: null, error: errorMsg };
			}

			let extractedJsonString = cleanedString.substring(
				firstBraceIndex,
				lastBraceIndex + 1,
			);

			const stringLiteralRegex = /"((?:\\.|[^"\\])*)"/g;
			const charToEscape: { [key: string]: string } = {
				"\b": "\\b",
				"\f": "\\f",
				"\n": "\\n",
				"\r": "\\r",
				"\t": "\\t",
			};

			const sanitizedJsonString = extractedJsonString.replace(
				stringLiteralRegex,
				(match, contentInsideQuotes: string) => {
					let processedContent = "";
					for (let i = 0; i < contentInsideQuotes.length; i++) {
						const char = contentInsideQuotes[i];
						const charCode = char.charCodeAt(0);

						if (charToEscape[char]) {
							processedContent += charToEscape[char];
						} else if (charCode >= 0 && charCode <= 0x1f) {
							processedContent += `\\u${charCode
								.toString(16)
								.padStart(4, "0")}`;
						} else {
							processedContent += char;
						}
					}
					return `"${processedContent}"`;
				},
			);

			potentialPlan = JSON.parse(sanitizedJsonString);
		} else {
			const errorMsg =
				"Invalid source provided for plan parsing. Must be a string or a non-null object.";
			console.error(errorMsg, source);
			return { plan: null, error: errorMsg };
		}

		if (
			typeof potentialPlan !== "object" ||
			potentialPlan === null ||
			typeof potentialPlan.planDescription !== "string" ||
			!Array.isArray(potentialPlan.steps)
		) {
			const errorMsg =
				"Plan validation failed: The source must represent an object with 'planDescription' (string) and 'steps' (array).";
			console.error(errorMsg, potentialPlan);
			return { plan: null, error: errorMsg };
		}

		if (potentialPlan.steps.length === 0) {
			const errorMsg =
				"Plan validation failed: The generated plan contains an empty steps array. It must contain at least one step.";
			console.error(`[workflowPlanner] ${errorMsg}`);
			return { plan: null, error: errorMsg };
		}

		const ig = await loadGitIgnoreMatcher(workspaceRootUri);
		const finalSteps: PlanStep[] = [];

		for (let i = 0; i < potentialPlan.steps.length; i++) {
			const flatStep = potentialPlan.steps[i];

			if (
				typeof flatStep !== "object" ||
				flatStep === null ||
				typeof flatStep.step !== "number" ||
				!flatStep.action ||
				!Object.values(PlanStepAction).includes(flatStep.action)
			) {
				const errorMsg = `Plan validation failed: Step ${
					i + 1
				} has an invalid structure or is missing required fields (step number, action).`;
				console.error(errorMsg, flatStep);
				return { plan: null, error: errorMsg };
			}

			const actionsRequiringPath = [
				PlanStepAction.CreateDirectory,
				PlanStepAction.CreateFile,
				PlanStepAction.ModifyFile,
			];
			if (actionsRequiringPath.includes(flatStep.action)) {
				if (typeof flatStep.path !== "string" || flatStep.path.trim() === "") {
					const errorMsg = `Plan validation failed: Step ${flatStep.step} (${flatStep.action}) requires a non-empty 'path'.`;
					return { plan: null, error: errorMsg };
				}
				if (path.isAbsolute(flatStep.path) || flatStep.path.includes("..")) {
					const errorMsg = `Plan validation failed: Path for step ${flatStep.step} must be relative and cannot contain '..'.`;
					return { plan: null, error: errorMsg };
				}

				const relativePath = flatStep.path.replace(/\\/g, "/");
				if (
					ig.ignores(relativePath) ||
					(flatStep.action === PlanStepAction.CreateDirectory &&
						ig.ignores(relativePath + "/"))
				) {
					console.warn(
						`Skipping step ${flatStep.step} because its path '${flatStep.path}' is ignored by .gitignore.`,
					);
					continue;
				}
			}

			let actionSpecificError: string | null = null;
			switch (flatStep.action) {
				case PlanStepAction.CreateDirectory:
					break;
				case PlanStepAction.CreateFile:
					const hasContent = typeof flatStep.content === "string";
					const hasPrompt = typeof flatStep.generate_prompt === "string";
					if (hasContent === hasPrompt) {
						actionSpecificError =
							"Invalid 'create_file' step. Must have either 'content' or 'generate_prompt', but not both or neither.";
					}
					break;
				case PlanStepAction.ModifyFile:
					if (
						typeof flatStep.modification_prompt !== "string" ||
						flatStep.modification_prompt.trim() === ""
					) {
						actionSpecificError =
							"Invalid 'modify_file' step. Must have a non-empty 'modification_prompt'.";
					}
					break;
				case PlanStepAction.RunCommand:
					if (
						typeof flatStep.command !== "string" ||
						flatStep.command.trim() === ""
					) {
						actionSpecificError =
							"Invalid 'run_command' step. Must have a non-empty 'command'.";
					}
					break;
			}

			if (actionSpecificError) {
				const errorMsg = `Plan validation failed at step ${flatStep.step}: ${actionSpecificError}`;
				console.error(errorMsg, flatStep);
				return { plan: null, error: errorMsg };
			}

			// Transform the validated flat step into the nested structure used by the application
			const { step: stepNumber, ...stepDetails } = flatStep;

			// Explicitly optional checks for boolean flag use_context_agent to ensure it passes through
			if (typeof (stepDetails as any).use_context_agent !== "undefined") {
				if (typeof (stepDetails as any).use_context_agent !== "boolean") {
					// Fallback: if somehow not boolean, ignore or try to coerce? simpler to just ignore or let it be if it's potentially truthy/falsy
					// But let's strictly validate if present to be safe, or just allow it.
					// Since flatStep is 'any' (implicitly from JSON), we should check.
					// If invalid type, maybe just skip assigning it or warn?
					// Let's assume validation is loose for optional fields, but we want to ensure cleaner types.
					if (
						(stepDetails as any).use_context_agent !== true &&
						(stepDetails as any).use_context_agent !== false
					) {
						delete (stepDetails as any).use_context_agent;
					}
				}
			}

			finalSteps.push({ step: stepDetails as any });
		}

		potentialPlan.steps = finalSteps;

		console.log(`Plan validation successful. ${finalSteps.length} steps.`);
		return { plan: potentialPlan as ExecutionPlan };
	} catch (error: any) {
		const errorMsg = `Error parsing plan source: ${
			error.message || "An unknown error occurred"
		}. Please ensure the source provides valid JSON or a plan object.`;
		console.error(errorMsg, error);
		return { plan: null, error: errorMsg };
	}
}
