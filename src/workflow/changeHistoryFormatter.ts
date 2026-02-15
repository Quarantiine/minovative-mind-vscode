// src/workflow/changeHistoryFormatter.ts
import { RevertibleChangeSet } from "../types/workflow";

/**
 * Formats successful change sets into a concise string for AI prompts.
 */
export function formatSuccessfulChangesForPrompt(
	changeSets: RevertibleChangeSet[],
): string {
	if (!changeSets || changeSets.length === 0) {
		return "";
	}

	const recentChangeSets = changeSets.slice(-3);
	let formattedHistory =
		"--- Recent Successful Project Changes (Context for AI) ---\n";

	for (const changeSet of recentChangeSets) {
		const date = new Date(changeSet.timestamp).toLocaleString();
		formattedHistory += `\n**Plan Executed on ${date} (ID: ${changeSet.id.substring(
			0,
			8,
		)})**\n`;
		if (changeSet.planSummary) {
			formattedHistory += `Summary: ${changeSet.planSummary}\n`;
		}
		formattedHistory += `Changes:\n`;
		const limitedChanges = changeSet.changes.slice(0, 3);
		for (const change of limitedChanges) {
			formattedHistory += `- **${change.changeType.toUpperCase()}**: \`${
				change.filePath
			}\` - ${change.summary.split("\n")[0]}\n`;
		}
		if (changeSet.changes.length > 3) {
			formattedHistory += `  ...and ${
				changeSet.changes.length - 3
			} more changes.\n`;
		}
	}
	formattedHistory += "\n--- End Recent Successful Project Changes ---\n";
	return formattedHistory;
}
