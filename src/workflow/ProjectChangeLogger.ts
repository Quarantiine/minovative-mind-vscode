// src/workflow/ProjectChangeLogger.ts
import { FileChangeEntry } from "../types/workflow";
import { v4 as uuidv4 } from "uuid";
import { createInversePatch } from "../utils/diffingUtils";
import * as path from "path";

export interface RevertibleChangeSet {
	id: string;
	timestamp: number;
	changes: FileChangeEntry[];
	summary?: string; // Optional plan summary
}

export class ProjectChangeLogger {
	private changes: FileChangeEntry[] = [];
	private _completedPlanChangeSets: RevertibleChangeSet[] = [];

	/**
	 * Logs a new file change entry.
	 * If the change is a modification, it creates an inverse patch for reverting
	 * and removes the original content from the log to save space.
	 * @param entry The FileChangeEntry object to log.
	 */
	logChange(entry: FileChangeEntry) {
		if (entry.changeType === "created") {
			const normalizedPath = path.normalize(entry.filePath);
			if (normalizedPath.endsWith("/") || normalizedPath.endsWith(path.sep)) {
				// This is a directory path, but it's being logged as a 'created' file.
				// Remove the trailing separator to prevent potential recursive directory deletion on revert.
				entry.filePath = normalizedPath.replace(
					new RegExp(`[${path.sep}/]$`),
					""
				);
				console.warn(
					`[ProjectChangeLogger] Warning: Normalized created path. Removed trailing separator from '${normalizedPath}' to '${entry.filePath}' to ensure it's treated as a file path.`
				);
			}
		}

		if (
			entry.changeType === "modified" &&
			typeof entry.originalContent === "string" &&
			typeof entry.newContent === "string"
		) {
			const inversePatch = createInversePatch(
				entry.originalContent,
				entry.newContent
			);
			entry.inversePatch = inversePatch;
		}

		this.changes.push(entry);
		console.log(
			`[ProjectChangeLogger] Logged change for ${entry.filePath}: ${
				entry.summary.split("\n")[0]
			}...`
		);
	}

	/**
	 * Returns the current array of logged file changes.
	 * @returns An array of FileChangeEntry objects.
	 */
	getChangeLog(): FileChangeEntry[] {
		return [...this.changes]; // Return a shallow copy to prevent external modification
	}

	/**
	 * Clears all logged changes, typically at the start of a new plan execution.
	 */
	clear(): void {
		this.changes = [];
		console.log("[ProjectChangeLogger] Change log cleared.");
	}

	/**
	 * Creates a new RevertibleChangeSet from the current `this.changes` array,
	 * archives it in `_completedPlanChangeSets`, and then clears `this.changes`.
	 * This is typically called after a plan has been successfully completed
	 * and its changes need to be archived.
	 * @param planSummary An optional summary/description of the plan that was completed.
	 */
	saveChangesAsLastCompletedPlan(planSummary?: string): void {
		if (this.changes.length > 0) {
			const changeSet: RevertibleChangeSet = {
				id: uuidv4(),
				timestamp: Date.now(),
				changes: [...this.changes], // Shallow copy of changes
				summary: planSummary,
			};
			this._completedPlanChangeSets.push(changeSet);
			console.log(
				`[ProjectChangeLogger] Saved ${this.changes.length} changes as completed plan set with ID: ${changeSet.id}`
			);
		} else {
			console.log(
				"[ProjectChangeLogger] No changes to save as completed plan."
			);
		}
		this.changes = []; // Clear current changes regardless of whether anything was saved
	}

	/**
	 * Returns a shallow copy of the changes from the last completed plan set.
	 * @returns An array of FileChangeEntry objects from the last completed plan, or null if none.
	 */
	getLastCompletedPlanChanges(): FileChangeEntry[] | null {
		if (this._completedPlanChangeSets.length === 0) {
			return null;
		}
		// Return a shallow copy of the changes from the last set
		return [
			...this._completedPlanChangeSets[this._completedPlanChangeSets.length - 1]
				.changes,
		];
	}

	/**
	 * Returns a shallow copy of the entire stack of completed plan change sets.
	 * @returns An array of RevertibleChangeSet objects.
	 */
	public getCompletedPlanChangeSets(): RevertibleChangeSet[] {
		return [...this._completedPlanChangeSets]; // Return a shallow copy of the stack
	}

	/**
	 * Removes and returns the last completed plan change set from the stack.
	 * @returns The last RevertibleChangeSet object, or undefined if the stack is empty.
	 */
	public popLastCompletedPlanChanges(): RevertibleChangeSet | undefined {
		const poppedSet = this._completedPlanChangeSets.pop();
		if (poppedSet) {
			console.log(
				`[ProjectChangeLogger] Popped completed plan set with ID: ${poppedSet.id}`
			);
		} else {
			console.log("[ProjectChangeLogger] No completed plan sets to pop.");
		}
		return poppedSet;
	}

	/**
	 * Clears all completed plan change sets from the stack.
	 */
	public clearAllCompletedPlanChanges(): void {
		this._completedPlanChangeSets = [];
		console.log(
			"[ProjectChangeLogger] All completed plan change sets cleared."
		);
	}
}
