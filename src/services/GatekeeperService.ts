import * as vscode from "vscode";
import { SidebarProvider } from "../sidebar/SidebarProvider";
import { detectProjectType } from "./projectTypeDetector";
import { exec } from "child_process";
import { promisify } from "util";
import { DEFAULT_FLASH_LITE_MODEL } from "../sidebar/common/sidebarConstants";

const execAsync = promisify(exec);

export interface GatekeeperDecision {
	runVerification: boolean;
	reason: string;
	suggestedCommand?: string;
}

export class GatekeeperService {
	private readonly projectRoot: vscode.Uri;
	private readonly provider: SidebarProvider;
	private _abortController: AbortController | null = null;

	constructor(
		provider: SidebarProvider,
		context: vscode.ExtensionContext,
		projectRoot: vscode.Uri,
	) {
		this.provider = provider;
		this.projectRoot = projectRoot;
	}

	public cancelVerification() {
		if (this._abortController) {
			this._abortController.abort();
			this._abortController = null;
		}
	}

	private getSignal(): AbortSignal {
		this.cancelVerification();
		this._abortController = new AbortController();
		return this._abortController.signal;
	}

	/**
	 * INTELLIGENT GATEKEEPER
	 * Uses AI to decide if the changes are risky enough to warrant a verification run.
	 */
	public async assessRiskWithAI(
		changeSummary: string,
		signal?: AbortSignal,
	): Promise<GatekeeperDecision> {
		const actualSignal = signal || this.getSignal();
		if (actualSignal.aborted) throw new Error("Operation cancelled");

		// Gather files for detection (ignoring common build/dependency folders for performance)
		const allScannedFiles = await vscode.workspace.findFiles(
			"**/*",
			"**/{node_modules,.git,dist,out,build,.vscode}/**",
		);

		const projectProfile = await detectProjectType(
			this.projectRoot,
			allScannedFiles,
		);
		if (!projectProfile) {
			return {
				runVerification: false,
				reason: "Could not detect project type.",
			};
		}

		const testCommand = this.getTestCommand(projectProfile.type);

		if (!testCommand) {
			return {
				runVerification: false,
				reason: "No verification command found for this project type.",
			};
		}

		const prompt = `
        You are a Senior DevOps Engineer. You need to decide if we should run the extensive (and slow) verification suite based on the code changes.
        
        Project Type: ${projectProfile.type}
        Verification Command: \`${testCommand}\`
        
        Change Summary:
        ${changeSummary}
        
        Rules:
        1. Low Risk (Typo fixes, comments, documentation, tooltip changes) -> SKIP verification.
        2. Medium/High Risk (Logic changes, refactoring, dependency updates, new features) -> RUN verification.
        
        Return a JSON object: { "runVerification": boolean, "reason": "string" }
        `;

		try {
			const response = await this.provider.aiRequestService.generateWithRetry(
				[{ text: prompt }],
				DEFAULT_FLASH_LITE_MODEL,
				undefined,
				"gatekeeper assessment",
			);

			if (actualSignal.aborted) throw new Error("Operation cancelled");

			// Basic JSON parsing from AI response
			const jsonMatch = response.match(/\{[\s\S]*\}/);
			if (jsonMatch) {
				const decision = JSON.parse(jsonMatch[0]);
				return {
					runVerification: decision.runVerification,
					reason: decision.reason,
					suggestedCommand: testCommand,
				};
			}

			// Fallback if AI response is malformed
			return {
				runVerification: true,
				reason: "AI response unclear, defaulting to safety.",
				suggestedCommand: testCommand,
			};
		} catch (error) {
			console.error("Gatekeeper AI check failed:", error);
			// Fail safe: If AI check fails, we assume we SHOULD verify (unless cancelled)
			if (actualSignal.aborted) throw new Error("Operation cancelled");
			return {
				runVerification: true,
				reason: "AI check failed, defaulting to safety.",
				suggestedCommand: testCommand,
			};
		}
	}

	public async verifyChange(
		command: string,
		signal?: AbortSignal,
	): Promise<boolean> {
		const actualSignal = signal || this.getSignal();
		if (actualSignal.aborted) throw new Error("Operation cancelled");

		console.log(`[Gatekeeper] Running verification: ${command}`);

		try {
			const { stdout, stderr } = await execAsync(command, {
				cwd: this.projectRoot.fsPath,
				signal: actualSignal,
			});

			// Simple heuristic: If exit code is 0 (execAsync throws on non-0), we passed.
			// But we can also check stdout for specific "FAILED" strings if exit code is unreliable in some tools.
			return true;
		} catch (error: any) {
			if (error.name === "AbortError" || actualSignal.aborted) {
				throw new Error("Operation cancelled");
			}

			console.warn(`[Gatekeeper] Verification failed: ${error.message}`);
			return false;
		}
	}

	private getTestCommand(projectType: string): string | undefined {
		// This should align with ProjectTypeDetector's output types
		switch (projectType.toLowerCase()) {
			case "node":
			case "typescript":
			case "javascript":
				return "npm test"; // Or check package.json for 'test' script availability
			case "python":
				return "pytest";
			case "rust":
				return "cargo check"; // 'check' is faster than 'test' for quick verification
			case "go":
				return "go test ./...";
			default:
				return undefined;
		}
	}
}
