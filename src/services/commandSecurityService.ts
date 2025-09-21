import * as path from "path";
import * as vscode from "vscode";

export interface ExecutableConfig {
	allowed: boolean;
	isHighRisk?: boolean;
	strictArgValidation?: boolean;
	allowedArgs?: string[];
	allowedUrlPatterns?: string[];
	requiresExplicitConfirmation?: boolean;
	allowMetaCharacters?: boolean;
}

export interface CommandSecurityConfig {
	default: {
		allowAbsolutePaths: boolean;
		allowMetaCharacters: boolean;
	};
	executables: {
		[key: string]: ExecutableConfig;
	};
}

export class CommandSecurityService {
	private static readonly DEFAULT_COMMAND_SECURITY_SETTINGS: CommandSecurityConfig =
		{
			default: {
				allowAbsolutePaths: false,
				allowMetaCharacters: false,
			},
			executables: {
				git: {
					allowed: true,
					allowedUrlPatterns: [
						"^https://github\\.com/.*",
						"^git@github\\.com:.*",
					],
				},
				npm: {
					allowed: true,
					allowedUrlPatterns: [
						"^https://(registry\\.)?npmjs\\.org/.*",
						"^https://registry\\.yarnpkg\\.com/.*",
					],
				},
				yarn: {
					allowed: true,
					allowedUrlPatterns: [
						"^https://(registry\\.)?npmjs\\.org/.*",
						"^https://registry\\.yarnpkg\\.com/.*",
					],
				},
				node: {
					allowed: true,
					isHighRisk: true,
					strictArgValidation: true,
					allowedArgs: ["^(?!-e).*$"],
				},
				echo: { allowed: true, allowMetaCharacters: true },
				mkdir: { allowed: true },
				rm: { allowed: true },
				cp: { allowed: true },
				mv: { allowed: true },
				ls: { allowed: true },
				cd: { allowed: true },
				pwd: { allowed: true },
				pnpm: { allowed: true },
				npx: {
					allowed: true,
					requiresExplicitConfirmation: true,
					isHighRisk: true,
					strictArgValidation: true,
					allowedArgs: ["^[a-zA-Z0-9-@/.\\\\\\-]+$", "^(?!-c).*$"],
					allowedUrlPatterns: ["^https://.*"],
				},
				python: {
					allowed: false,
					isHighRisk: true,
					strictArgValidation: true,
				},
				bash: { allowed: false, isHighRisk: true, strictArgValidation: true },
				sh: { allowed: false, isHighRisk: true, strictArgValidation: true },
			},
		};

	/**
	 * Parses a command line string into an executable and an array of arguments,
	 * respecting single and double quotes.
	 * @param commandLine The full command string.
	 * @returns An object containing the executable and arguments.
	 */
	public static parseCommandArguments(commandLine: string): {
		executable: string;
		args: string[];
	} {
		const tokens: string[] = [];
		const commandRegex = /"([^"]*)"|'([^']*)'|[^\s"']+/g;
		let match;
		while ((match = commandRegex.exec(commandLine)) !== null) {
			tokens.push(match[1] || match[2] || match[0]);
		}
		const executable = tokens.length > 0 ? tokens[0] : "";
		const args = tokens.slice(1);
		return { executable, args };
	}

	/**
	 * Formats an argument for human-readable display in a prompt.
	 * Encloses arguments with spaces or quotes in single quotes, escaping internal single quotes.
	 * @param arg The argument string.
	 * @returns The display-ready argument string.
	 */
	public static sanitizeArgumentForDisplay(arg: string): string {
		if (arg.includes(" ") || arg.includes("'") || arg.includes('"')) {
			return `'${arg.replace(/'/g, "'\\''")}'`;
		}
		return arg;
	}

	/**
	 * Performs deeper, stricter argument validation for commands marked with `strictArgValidation`.
	 * Checks for path traversal, URL safety using allowed patterns, and dangerous argument characters.
	 * @param executable The command executable.
	 * @param args The arguments to validate.
	 * @param effectiveExecConfig The resolved ExecutableConfig for the command.
	 */
	private _validateArgumentsStrictly(
		executable: string,
		args: string[],
		effectiveExecConfig: ExecutableConfig
	): void {
		for (const arg of args) {
			if (arg.includes("../") || arg.includes("/..")) {
				throw new Error(
					`Command security violation: Path traversal detected in argument '${arg}' for '${executable}'.`
				);
			}

			// URL validation block
			if (arg.match(/^(http|https):\/\/[^\s$.?#].[^\s]*$/i)) {
				if (
					effectiveExecConfig.allowedUrlPatterns &&
					effectiveExecConfig.allowedUrlPatterns.length > 0
				) {
					const isUrlAllowed = effectiveExecConfig.allowedUrlPatterns.some(
						(pattern) => new RegExp(pattern).test(arg)
					);
					if (!isUrlAllowed) {
						throw new Error(
							`Command security violation: URL '${arg}' is not permitted for '${executable}'.`
						);
					}
				} else {
					// If allowedUrlPatterns is not defined or empty
					if (effectiveExecConfig.strictArgValidation === true) {
						throw new Error(
							`Command security violation: URLs are not explicitly allowed for '${executable}' under strict validation.`
						);
					} else {
						console.warn(
							`Command security warning: URL '${arg}' detected in arguments for '${executable}'. ` +
								`Ensure this URL is trusted for this command.`
						);
					}
				}
			}

			// Existing allowedArgs validation
			if (
				effectiveExecConfig.allowedArgs &&
				effectiveExecConfig.allowedArgs.length > 0
			) {
				const isArgAllowed = effectiveExecConfig.allowedArgs.some((pattern) =>
					new RegExp(pattern).test(arg)
				);
				if (!isArgAllowed) {
					throw new Error(
						`Command security violation: Argument '${arg}' for '${executable}' does not match any allowed patterns.`
					);
				}
			}

			const dangerousArgChars = [`\``, `"$("`];
			if (dangerousArgChars.some((char) => arg.includes(char))) {
				throw new Error(
					`Command security violation: Potentially dangerous command substitution character in argument '${arg}' for '${executable}'.`
				);
			}
		}
	}

	/**
	 * Performs strict validation and allowlisting on the command and its arguments.
	 * Throws an error if the command is deemed unsafe or violates policy.
	 * @param executable The main command executable.
	 * @param args The arguments to the command.
	 * @param originalCommandString The full, original command string as provided by the AI.
	 * @returns The effective ExecutableConfig for the given executable.
	 */
	public async isCommandSafe(
		executable: string,
		args: string[],
		originalCommandString: string
	): Promise<ExecutableConfig> {
		const config = CommandSecurityService.DEFAULT_COMMAND_SECURITY_SETTINGS;

		if (!executable) {
			throw new Error(
				"Command security violation: Executable cannot be empty."
			);
		}

		const lowerExecutable = executable.toLowerCase();
		const defaultExecConfig: ExecutableConfig = { allowed: false };
		const executableConfig = config.executables[lowerExecutable];
		const effectiveExecConfig = executableConfig || defaultExecConfig;

		if (!effectiveExecConfig.allowed) {
			throw new Error(
				`Command security violation: Executable '${executable}' is explicitly disallowed or not in the allowlist.`
			);
		}

		// Absolute Path Handling: Disallow if default doesn't allow
		const isAbsolutePath = path.isAbsolute(executable);
		if (isAbsolutePath) {
			if (!config.default.allowAbsolutePaths) {
				throw new Error(
					`Command security violation: Absolute path executable '${executable}' is disallowed by default for security reasons.`
				);
			}
		}

		// Check for dangerous shell meta-characters
		const allowsMetaChars =
			effectiveExecConfig.allowMetaCharacters ||
			config.default.allowMetaCharacters;
		if (!allowsMetaChars) {
			const dangerousShellMetaChars = [
				"&&",
				"||",
				";",
				"`",
				"$(",
				">",
				"<",
				"|",
				"&",
				"\\",
			];

			const containsDangerousChars = dangerousShellMetaChars.some((char) =>
				originalCommandString.includes(char)
			);
			if (containsDangerousChars) {
				throw new Error(
					`Command security violation: Detected potentially dangerous shell meta-characters ` +
						`('${dangerousShellMetaChars
							.filter((c) => originalCommandString.includes(c))
							.join("', '")}') ` +
						`in the command string. For safety, complex shell scripting or injection attempts via plan commands are prohibited. ` +
						`If this is a legitimate command, ensure all special characters are properly quoted or escaped.`
				);
			}
		}

		// Specific checks for dangerous commands/arguments (like rm, git)
		if (lowerExecutable === "rm") {
			if (
				args.some(
					(arg) =>
						arg.toLowerCase().includes("-rf") ||
						arg === "/" ||
						arg === "/*" ||
						arg === "./*" ||
						arg === "*"
				)
			) {
				throw new Error(
					`Command security violation: Potentially dangerous 'rm' operation detected (e.g., -rf, /, /*, *). Full system deletion commands are prohibited.`
				);
			}
		} else if (lowerExecutable === "git") {
			if (
				(args.includes("reset") &&
					(args.includes("--hard") || args.includes("--force"))) ||
				(args.includes("clean") &&
					(args.includes("-f") || args.includes("--force")))
			) {
				throw new Error(
					`Command security violation: Potentially dangerous 'git reset --hard' or 'git clean --force' detected. This can lead to irreversible data loss.`
				);
			}
		} else if (["npm", "yarn", "pnpm"].includes(lowerExecutable)) {
			if (args.includes("exec") || args.includes("dlx")) {
				if (lowerExecutable !== "npx") {
					throw new Error(
						`Command security violation: '${executable} exec/dlx' can run arbitrary code and is not allowed.`
					);
				}
			}
		}

		// Enhanced Argument Validation for high-risk commands or those with strictArgValidation
		if (effectiveExecConfig.strictArgValidation) {
			this._validateArgumentsStrictly(
				lowerExecutable,
				args,
				effectiveExecConfig
			);
		} else if (
			effectiveExecConfig.allowedArgs &&
			effectiveExecConfig.allowedArgs.length > 0
		) {
			for (const arg of args) {
				const isArgAllowed = effectiveExecConfig.allowedArgs.some((pattern) =>
					new RegExp(pattern).test(arg)
				);
				if (!isArgAllowed) {
					throw new Error(
						`Command security violation: Argument '${arg}' for '${executable}' does not match any allowed patterns.`
					);
				}
			}
		}

		return effectiveExecConfig;
	}
}
