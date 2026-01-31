import * as cp from "child_process";

export class SafeCommandExecutor {
	private static readonly ALLOWED_COMMANDS = new Set([
		"ls",
		"find",
		"grep",
		"cat",
		"git",
		"sed",
		"head",
		"tail",
		"wc",
		"file",
		"xargs",
		// Read-only additions
		"less",
		"more",
		"nl",
		"stat",
		"du",
		"df",
		"diff",
		"pwd",
		"id",
		"whoami",
		"strings",
		"date",
		"sha256sum",
		"md5sum",
	]);

	private static readonly BLOCKED_FLAGS = new Set([
		">",
		">>",
		"<",
		//"|", // Pipe is now allowed
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
						// Handle maxBuffer exceeded error by returning truncated output
						if (
							error.message.includes("maxBuffer") ||
							(error as any).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
						) {
							resolve(
								stdout +
									"\n... [Output truncated by Context Agent due to size limit (2MB)]",
							);
							return;
						}

						reject(new Error(stderr || error.message));
						return;
					}
					resolve(stdout);
				},
			);
		});
	}

	/**
	 * Checks if a specific tool is available in the system PATH.
	 * @param tool The name of the tool to check (e.g., "rg", "git").
	 * @returns Promise<boolean> true if available, false otherwise.
	 */
	public static async checkToolAvailability(tool: string): Promise<boolean> {
		if (!this.ALLOWED_COMMANDS.has(tool)) {
			return false; // Don't even check for forbidden tools
		}
		return new Promise((resolve) => {
			cp.exec(`which ${tool}`, (error) => {
				resolve(!error);
			});
		});
	}

	private static isSafe(command: string): boolean {
		const trimmed = command.trim();
		if (!trimmed) {
			return false;
		}

		// Check for blocked characters (excluding pipe which is now handled separately)
		// We still block > >> & && ; ` $(
		if (
			[...this.BLOCKED_FLAGS].some((flag) => trimmed.includes(flag)) ||
			trimmed.includes("\n")
		) {
			return false;
		}

		// Split by pipe to handle pipelines, respecting quotes
		const segments = this.splitByPipeRespectingQuotes(trimmed);

		for (const segment of segments) {
			const segmentTrimmed = segment.trim();
			if (!segmentTrimmed) {
				return false; // Empty segment (e.g. "ls | | grep")
			}

			if (!this.isSafeSingleCommand(segmentTrimmed)) {
				return false;
			}
		}

		return true;
	}

	private static splitByPipeRespectingQuotes(command: string): string[] {
		const segments: string[] = [];
		let currentSegment = "";
		let inSingleQuote = false;
		let inDoubleQuote = false;

		for (let i = 0; i < command.length; i++) {
			const char = command[i];

			if (char === "'" && !inDoubleQuote) {
				inSingleQuote = !inSingleQuote;
				currentSegment += char;
			} else if (char === '"' && !inSingleQuote) {
				inDoubleQuote = !inDoubleQuote;
				currentSegment += char;
			} else if (char === "|" && !inSingleQuote && !inDoubleQuote) {
				segments.push(currentSegment);
				currentSegment = "";
			} else {
				currentSegment += char;
			}
		}
		segments.push(currentSegment);
		return segments;
	}

	private static isSafeSingleCommand(command: string): boolean {
		// Remove quoted strings before checking for dangerous operators
		const withoutQuotes = command
			.replace(/'[^']*'/g, "") // Remove single-quoted strings
			.replace(/"[^"]*"/g, ""); // Remove double-quoted strings

		const parts = command.trim().split(/\s+/);
		const baseCommand = parts[0];

		if (!this.ALLOWED_COMMANDS.has(baseCommand)) {
			return false;
		}

		// --- Specific Security Checks ---

		// 1. Git: Allow only read-only subcommands
		if (baseCommand === "git") {
			const allowedGitSubcommands = new Set([
				"status",
				"log",
				"diff",
				"show",
				"grep",
				"ls-files",
			]);
			const subCommand = parts[1];
			if (!subCommand || !allowedGitSubcommands.has(subCommand)) {
				return false; // Block checkout, commit, push, etc.
			}
		}

		// 2. Sed: Block -i (in-place edit)
		if (baseCommand === "sed") {
			// Check if any part implies -i
			// We check 'withoutQuotes' to avoid flagging strings like "sed -e 's/-i/x/'" (though rare)
			// But for safety, checking the raw command args is better, iterating over parts
			for (const part of parts) {
				if (part === "-i" || part.startsWith("-i")) {
					return false;
				}
			}
		}

		// 3. Xargs: Recursively check the executed command
		if (baseCommand === "xargs") {
			// Find the start of the actual command.
			// Xargs can have flags (like -n 1, -0). Parsing them completely is hard.
			// Heuristic: Scan args until we find a token that IS an allowed command.
			// Everything before it is assumed to be xargs flags/args.
			let subCommandIndex = -1;
			for (let i = 1; i < parts.length; i++) {
				if (this.ALLOWED_COMMANDS.has(parts[i])) {
					subCommandIndex = i;
					break;
				}
			}

			if (subCommandIndex === -1) {
				return false; // No allowed command found in xargs arguments
			}

			const subCommand = parts.slice(subCommandIndex).join(" ");
			return this.isSafeSingleCommand(subCommand);
		}

		return true;
	}
}
