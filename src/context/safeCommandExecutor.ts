import * as cp from "child_process";

export class SafeCommandExecutor {
	private static readonly ALLOWED_COMMANDS = new Set([
		"ls",
		"find",
		"grep",
		"cat",
		"git", // specifically git grep or git ls-files
	]);

	private static readonly BLOCKED_FLAGS = new Set([
		">",
		">>",
		"|",
		"&",
		"&&",
		";",
		"`",
		"$(",
	]);

	/**
	 * executing a command if it is deemed safe.
	 * @param command The command string to execute
	 * @param cwd The current working directory
	 */
	public static async execute(command: string, cwd: string): Promise<string> {
		if (!this.isSafe(command)) {
			throw new Error("Command denied by SafeCommandExecutor: " + command);
		}

		return new Promise((resolve, reject) => {
			cp.exec(
				command,
				{ cwd, maxBuffer: 1024 * 1024 * 2 },
				(error, stdout, stderr) => {
					// 2MB buffer
					if (error) {
						reject(new Error(stderr || error.message));
						return;
					}
					resolve(stdout);
				}
			);
		});
	}

	private static isSafe(command: string): boolean {
		const trimmed = command.trim();
		if (!trimmed) return false;

		// Check for chaining operators or redirection which might indicate shell injection or unwanted complexity
		if (this.BLOCKED_FLAGS.has(trimmed) || /([;&|]|\n)/.test(trimmed)) {
			// Basic check against multiple commands. Smart splitting is hard, so we whitelist simple structures.
			// We allow pipes if they are just piping to grep maybe? For now, STRICT NO PIPES to be safe.
			return false;
		}

		const parts = trimmed.split(/\s+/);
		const baseCommand = parts[0];

		if (!this.ALLOWED_COMMANDS.has(baseCommand)) {
			return false;
		}

		// Specific checks
		if (baseCommand === "git") {
			const subCommand = parts[1];
			if (subCommand !== "grep" && subCommand !== "ls-files") {
				return false;
			}
		}

		return true;
	}
}
