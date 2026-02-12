import * as cp from "child_process";

/**
 * Comprehensive list of directories excluded from context agent searches.
 * Covers all major languages, frameworks, and toolchains to prevent the agent
 * from wasting time and context tokens on dependency, build, cache, and
 * generated content. Aligned with DEFAULT_IGNORE_PATTERNS in ignoreUtils.ts.
 */
const EXCLUDED_DIRS = [
	// --- Universal Build/Output ---
	"node_modules",
	".git",
	"dist",
	"out",
	"build",
	"target",
	"bin",
	"obj",
	"packages",
	"tmp",
	"temp",
	"logs",
	"log",
	"coverage",
	"report",
	"reports",
	"test-results",
	"TestResults",
	"lcov-report",

	// --- IDE/Editor Settings ---
	".vscode",
	".vscode-insiders",
	".idea",
	".settings",
	".history",
	".ionide",

	// --- OS/System ---
	".DS_Store",

	// --- JavaScript/TypeScript Frameworks & Tooling ---
	".next",
	".nuxt",
	".output",
	".svelte-kit",
	".parcel-cache",
	".vite",
	".cache",
	".turbo",
	".var",
	".yarn",
	".npm",
	"storybook-static",
	"_astro",
	".nyc_output",
	"typings",
	"elm-stuff",
	"jspm_packages",
	"cypress",

	// --- Python ---
	"__pycache__",
	".venv",
	"venv",
	"env",
	".eggs",
	".pytest_cache",
	".mypy_cache",
	".ruff_cache",
	".ipynb_checkpoints",
	"htmlcov",
	"__debug_bin",

	// --- Java/Kotlin/Gradle/Maven ---
	".gradle",

	// --- Go ---
	"pkg",
	"vendor",

	// --- Ruby ---
	".bundle",

	// --- PHP ---
	"storage",

	// --- C/C++ ---
	"CMakeFiles",
	"ipch",
	"Debug",
	"Release",
	"x64",
	"Win32",

	// --- iOS/macOS ---
	"DerivedData",
	"Pods",
	"Carthage",

	// --- Terraform ---
	".terraform",

	// --- Misc ---
	".vagrant",
	".github",
	".gitlab",
];

/**
 * Comprehensive list of binary/generated file extensions that grep should skip.
 * Covers images, video, audio, fonts, archives, documents, compiled artifacts,
 * IDE files, and tool-specific generated files across all major languages.
 */
const EXCLUDED_EXTENSIONS = [
	// --- Images ---
	"*.png",
	"*.jpg",
	"*.jpeg",
	"*.gif",
	"*.bmp",
	"*.ico",
	"*.webp",
	"*.svg",
	"*.tiff",
	// --- Video ---
	"*.mp4",
	"*.webm",
	"*.avi",
	"*.mov",
	"*.mkv",
	"*.wmv",
	"*.flv",
	// --- Audio ---
	"*.mp3",
	"*.wav",
	"*.ogg",
	"*.aac",
	// --- Fonts ---
	"*.woff",
	"*.woff2",
	"*.ttf",
	"*.otf",
	"*.eot",
	// --- Archives ---
	"*.zip",
	"*.rar",
	"*.7z",
	"*.tar",
	"*.gz",
	"*.tgz",
	// --- Documents ---
	"*.pdf",
	"*.doc",
	"*.docx",
	"*.ppt",
	"*.pptx",
	"*.xls",
	"*.xlsx",

	// --- Compiled/Binary Artifacts (C/C++/.NET/Go) ---
	"*.exe",
	"*.dll",
	"*.so",
	"*.dylib",
	"*.o",
	"*.a",
	"*.obj",
	"*.lib",
	"*.exp",
	"*.ilk",
	"*.pch",
	"*.gch",
	"*.d",
	"*.pdb",
	"*.aps",
	"*.ncb",
	"*.opensdf",
	"*.sdf",

	// --- Java/Kotlin ---
	"*.class",
	"*.jar",
	"*.war",
	"*.ear",

	// --- Python ---
	"*.pyc",
	"*.pyo",
	"*.pyd",
	"*.spec",

	// --- Go ---
	"*.test",

	// --- Ruby ---
	"*.gem",

	// --- iOS/macOS ---
	"*.ipa",
	"*.app",
	"*.dSYM",
	"*.xcuserdatad",

	// --- .NET/Visual Studio ---
	"*.user",
	"*.filters",
	"*.suo",

	// --- IDE/Editor Files ---
	"*.iml",
	"*.ipr",
	"*.iws",
	"*.swp",
	"*.swo",
	"*.swn",
	"*.elc",
	"*.sublime-project",
	"*.sublime-workspace",

	// --- Terraform ---
	"*.tfstate",

	// --- TypeScript ---
	"*.tsbuildinfo",

	// --- Database ---
	"*.vsix",
	"*.db",
	"*.sqlite",
	"*.sqlite3",

	// --- Source Maps / Logs / Locks ---
	"*.log",
	"*.lock",
	"*.map",

	// --- Misc Generated/Temp ---
	"*.tmp",
	"*.bak",
	"*.orig",
	"*.rej",
	"*.patch",
	"*.diff",
];

/**
 * Comprehensive list of specific filenames that should be excluded from searches.
 * Lock files, OS metadata, cache files, and tool-generated artifacts.
 */
const EXCLUDED_FILES = [
	// --- Lock Files ---
	"package-lock.json",
	"yarn.lock",
	"pnpm-lock.yaml",
	"composer.lock",
	"Gemfile.lock",
	"Pipfile.lock",
	"poetry.lock",
	"Cargo.lock",
	"bun.lockb",

	// --- OS Metadata ---
	".DS_Store",
	"Thumbs.db",
	"ehthumbs.db",
	"Desktop.ini",

	// --- Build Artifacts ---
	"CMakeCache.txt",
	"cmake_install.cmake",
	"dependency-reduced-pom.xml",
	"composer.phar",

	// --- Tool Caches ---
	".eslintcache",
	".phpunit.result.cache",
	".byebug_history",

	// --- Terraform ---
	"tfplan",

	// --- Editor ---
	"Session.vim",
	"tags",
	"cscope.out",
	"GTAGS",
	"GRTAGS",
	"GSYMS",
	"GPATH",

	// --- Config (often not useful for code context) ---
	"pnpm-workspace.yaml",
];

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
		"sort",
		"uniq",
		"realpath",
		"readlink",
		"tr",
		"awk",
	]);

	public static getAllowedCommands(): string[] {
		return Array.from(this.ALLOWED_COMMANDS);
	}

	private static readonly BLOCKED_FLAGS = new Set([
		">",
		">>",
		"<",
		"&",
		"&&",
		";",
		"`",
		"$(",
	]);

	// ----------------------------------------------------------------
	// Workspace-aware command transformation
	// ----------------------------------------------------------------

	/**
	 * Builds grep --exclude-dir and --exclude flags from the curated exclusion lists.
	 * Also adds --binary-files=without-match to silently skip binary files.
	 */
	private static buildGrepExcludeFlags(): string {
		const dirFlags = EXCLUDED_DIRS.map((d) => `--exclude-dir='${d}'`).join(" ");
		const extFlags = EXCLUDED_EXTENSIONS.map((e) => `--exclude='${e}'`).join(
			" ",
		);
		const fileFlags = EXCLUDED_FILES.map((f) => `--exclude='${f}'`).join(" ");
		return `--binary-files=without-match ${dirFlags} ${extFlags} ${fileFlags}`;
	}

	/**
	 * Builds find -not -path pruning clauses from the curated exclusion lists.
	 */
	private static buildFindPruneClauses(): string {
		// Build a combined prune expression: ( -path '*/node_modules/*' -o -path '*/.git/*' ... ) -prune -o
		const pathClauses = EXCLUDED_DIRS.map((d) => `-path '*/${d}/*'`);
		return `\\( ${pathClauses.join(" -o ")} \\) -prune -o`;
	}

	/**
	 * Transforms a command to respect workspace boundaries by injecting
	 * gitignore-aligned exclusion flags. Operates on individual pipeline segments.
	 *
	 * Transformations:
	 * - `grep -r ...` → inject --exclude-dir, --exclude, --binary-files=without-match
	 * - `find ...` → inject -not -path prune clauses (if no explicit prune already exists)
	 * - `ls -R` or `ls -lR` → rewrite to `git ls-files` for gitignore awareness
	 */
	private static transformCommandForWorkspace(command: string): string {
		const segments = this.splitByPipeRespectingQuotes(command);
		const transformedSegments = segments.map((segment) => {
			const trimmed = segment.trim();
			if (!trimmed) {
				return segment;
			}

			const parts = trimmed.split(/\s+/);
			const baseCmd = parts[0];

			// --- grep: inject exclusion flags ---
			if (baseCmd === "grep") {
				const isRecursive = parts.some(
					(p) => /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(p) && !p.startsWith("--"),
				);

				if (isRecursive && !trimmed.includes("--exclude-dir")) {
					// Inject exclusion flags right after "grep"
					const excludeFlags = this.buildGrepExcludeFlags();
					return `${parts[0]} ${excludeFlags} ${parts.slice(1).join(" ")}`;
				}
			}

			// --- find: inject prune clauses ---
			if (baseCmd === "find") {
				// Only inject if no prune/exclude is already present
				if (!trimmed.includes("-prune") && !trimmed.includes("-not -path")) {
					// Inject prune clauses between the search path(s) and the filter predicates.
					// find <paths...> <prune-clauses> <original-predicates> -print
					// Heuristic: the search path is everything up to the first flag (starts with -)
					// or predicate keyword like -name, -type, -exec, etc.
					const predicateStart = parts.findIndex(
						(p, i) =>
							i > 0 &&
							(p.startsWith("-") || p === "!" || p === "(" || p === "\\("),
					);

					if (predicateStart > 0) {
						const searchPaths = parts.slice(0, predicateStart).join(" ");
						const predicates = parts.slice(predicateStart).join(" ");
						const pruneClauses = this.buildFindPruneClauses();
						return `${searchPaths} ${pruneClauses} ${predicates} -print`;
					} else if (predicateStart === -1 && parts.length === 1) {
						// Just "find" with no args — add prune and print
						const pruneClauses = this.buildFindPruneClauses();
						return `find . ${pruneClauses} -print`;
					}
				}
			}

			// --- ls -R: rewrite to git ls-files ---
			if (baseCmd === "ls") {
				const hasRecursiveFlag = parts.some(
					(p) => p === "-R" || /^-[a-zA-Z]*R[a-zA-Z]*$/.test(p),
				);

				if (hasRecursiveFlag) {
					// Rewrite to git ls-files which naturally respects .gitignore
					return "git ls-files";
				}
			}

			return segment;
		});

		return transformedSegments.join(" | ");
	}

	/**
	 * Execute a command if it is deemed safe, automatically injecting
	 * workspace-aware exclusions (gitignore-aligned) for grep, find, and ls -R.
	 * @param command The command string to execute
	 * @param cwd The current working directory
	 */
	public static async execute(command: string, cwd: string): Promise<string> {
		if (!this.isSafe(command)) {
			throw new Error("Command denied by SafeCommandExecutor: " + command);
		}

		// Transform the command to respect workspace boundaries
		const transformedCommand = this.transformCommandForWorkspace(command);

		return new Promise((resolve, reject) => {
			cp.exec(
				transformedCommand,
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

						// Handle exit code 1 for grep/diff/git -- these usually mean "no matches" or "found differences"
						// rather than a system error. We should return the stdout (or empty string) so the agent
						// knows it ran successfully but found nothing/something different.
						if (error.code === 1) {
							// Check if command is one where code 1 is valid
							// matches: grep, egrep, fgrep, diff, git grep (part of git)
							// We check for word boundaries to avoid matching "agrep" if we didn't mean to,
							// though "agrep" also probably follows this.
							// Simple heuristic: if command *contains* "grep" or "diff" as a whole word.
							if (
								/\bgrep\b/.test(command) ||
								/\bdiff\b/.test(command) ||
								/\bcmp\b/.test(command)
							) {
								resolve(stdout || "");
								return;
							}
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

		// 4. Awk: Block 'system' calls
		if (baseCommand === "awk") {
			// Check against the raw command string to catch 'system("...")'.
			// We check for "system" followed by optional whitespace and an opening parenthesis.
			// This avoids blocking strings like 'print "system status"'.
			// Note: In awk, system is a function and requires parentheses: system(cmd).
			if (/\bsystem\s*\(/.test(command)) {
				return false;
			}
		}

		return true;
	}
}
