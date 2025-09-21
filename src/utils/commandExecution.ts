import { ChildProcess, spawn } from "child_process";
import * as vscode from "vscode";
import { Readable } from "stream";

/**
 * Interface for the result object returned by the executeCommand function.
 *
 * @interface CommandResult
 * @property {string} stdout - The standard output from the executed command.
 * @property {string} stderr - The standard error output from the executed command.
 * @property {number | null} exitCode - The exit code of the command. Null if the process exited due to a signal or could not be spawned.
 */
export interface CommandResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
}

/**
 * Executes a command, captures its stdout and stderr, and handles cancellation.
 * It adds the spawned child process to a provided tracking array (`activeChildProcesses`)
 * immediately and removes it upon the command's completion (success, failure, or cancellation).
 *
 * @param {string} command - The command to execute (e.g., "npm").
 * @param {string[]} args - An array of string arguments for the command (e.g., ["install"]).
 * @param {string} cwd - The current working directory for the command execution.
 * @param {vscode.CancellationToken} token - A VS Code CancellationToken to observe for cancellation requests.
 * @param {ChildProcess[]} activeChildProcesses - An array to which the spawned ChildProcess will be added
 *   and from which it will be removed. This allows for global management of active child processes.
 * @param {vscode.Terminal} [vscodeTerminal] - An optional VS Code terminal to which stdout/stderr will be piped in real-time.
 * @returns {Promise<CommandResult>} A Promise that resolves with an object containing
 *   `stdout`, `stderr`, and `exitCode`. The Promise will reject only if the command
 *   fails to spawn (e.g., command not found, permissions error).
 *
 * @remarks
 * - This function explicitly avoids `shell: true` for security reasons. Ensure the `command`
 *   and `args` are properly escaped if they originate from untrusted user input before
 *   being passed to this function, although passing `args` separately mitigates many shell injection risks.
 * - If the command is cancelled, it will be killed via `child.kill()` (SIGTERM). The `exitCode`
 *   in this scenario might be `null` or a specific non-zero value (e.g., 130 for SIGTERM on Linux).
 */
export async function executeCommand(
	command: string,
	args: string[],
	cwd: string,
	token: vscode.CancellationToken,
	activeChildProcesses: ChildProcess[],
	vscodeTerminal?: vscode.Terminal
): Promise<CommandResult> {
	const stdoutChunks: Buffer[] = [];
	const stderrChunks: Buffer[] = [];
	let cancellationInitiatedByToken: boolean = false;
	const fullCommandString = `${command} ${args.join(" ")}`; // For logging purposes

	return new Promise<CommandResult>((resolve, reject) => {
		// Spawn the child process without shell: true
		const child: ChildProcess = spawn(command, args, { cwd });

		// Add the child process to the active tracking array immediately
		activeChildProcesses.push(child);

		// Function to clean up resources: remove from active processes and dispose cancellation listener
		let disposable: vscode.Disposable; // Declare here so it's accessible in cleanup

		const cleanup = (): void => {
			const index: number = activeChildProcesses.indexOf(child);
			if (index > -1) {
				activeChildProcesses.splice(index, 1);
			}
			if (disposable) {
				disposable.dispose(); // Dispose of the cancellation listener to prevent memory leaks
			}
		};

		// Helper function to pipe stream data to internal chunks and optionally to VS Code terminal
		const pipeStreamToTerminal = (
			stream: Readable | null,
			chunkBuffer: Buffer[]
		): void => {
			if (!stream) {
				return;
			}
			stream.on("data", (data: Buffer) => {
				chunkBuffer.push(data); // Always collect data into chunks
				if (vscodeTerminal && !vscodeTerminal.dispose) {
					const textData = data.toString("utf8");
					// Pipe to terminal without adding new line by default,
					// as data can be fragmented. Newlines will come from the stream itself.
					vscodeTerminal.sendText(textData, false);
				}
			});
		};

		// Register a listener for cancellation requests from the VS Code token
		disposable = token.onCancellationRequested(() => {
			if (!child.killed) {
				const cancelMsg = `Command execution cancelled. Killing process PID: ${
					child.pid ?? "N/A"
				} for command: "${fullCommandString}"`;
				console.log(cancelMsg);
				if (vscodeTerminal && !vscodeTerminal.dispose) {
					vscodeTerminal.sendText(cancelMsg + "\r\n", true);
				}
				cancellationInitiatedByToken = true; // Mark that cancellation was initiated by our token
				child.kill(); // Send SIGTERM to the child process
			}
		});

		// Collect stdout data chunks and optionally pipe to terminal
		pipeStreamToTerminal(child.stdout, stdoutChunks);

		// Collect stderr data chunks and optionally pipe to terminal
		pipeStreamToTerminal(child.stderr, stderrChunks);

		// Handle errors that occur during spawning or execution of the command
		// This event is typically emitted if the command cannot be found, permissions are denied, etc.
		child.on("error", (err: Error) => {
			const errorMessage: string = `Failed to execute command "${fullCommandString}" in "${cwd}" or internal error: ${err.message}`;
			console.error(
				`Command Spawn Error [PID: ${
					child.pid ?? "N/A"
				}] for command: "${fullCommandString}":`,
				errorMessage,
				err
			);
			if (vscodeTerminal && !vscodeTerminal.dispose) {
				// Ensure error messages are visible with a newline
				vscodeTerminal.sendText(`Error: ${errorMessage}\r\n`, true);
			}
			cleanup(); // Ensure cleanup even if the process failed to spawn
			reject(new Error(errorMessage)); // Reject the promise as the command couldn't even start
		});

		// Handle the process 'close' event, which fires when the process exits
		// (either successfully, with an error code, or due to a signal).
		child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
			const stdout: string = Buffer.concat(stdoutChunks).toString("utf8");
			const stderr: string = Buffer.concat(stderrChunks).toString("utf8");
			const exitCode: number | null = code;

			const closeLogMessage = `Command finished [PID: ${
				child.pid ?? "N/A"
			}] for command: "${fullCommandString}" with exit code: ${exitCode}, signal: ${
				signal ?? "N/A"
			}`;
			console.log(closeLogMessage);
			if (vscodeTerminal && !vscodeTerminal.dispose) {
				vscodeTerminal.sendText(closeLogMessage + "\r\n", true);
				if (stderr && !cancellationInitiatedByToken) {
					// Only log stderr summary to terminal if not cancelled, as raw stream would have already shown it
					vscodeTerminal.sendText(`--- STDERR ---\r\n${stderr}\r\n`, true);
				}
			}

			if (stderr) {
				// Log stderr output, especially if the command was not explicitly cancelled.
				// During cancellation, stderr might contain irrelevant output as process is abruptly stopped.
				if (!cancellationInitiatedByToken) {
					console.warn(
						`Command stderr [PID: ${child.pid ?? "N/A"}]:\n${stderr}`
					);
				}
			}

			cleanup(); // Always clean up when the process closes

			if (cancellationInitiatedByToken || token.isCancellationRequested) {
				// If cancellation was initiated by our token, resolve with the available output.
				// A common exit code for SIGTERM (which child.kill() sends) is 130 on Unix-like systems.
				const cancelledMsg = `Command [PID: ${
					child.pid ?? "N/A"
				}] was killed due to external cancellation request for command: "${fullCommandString}".`;
				console.log(cancelledMsg);
				if (vscodeTerminal && !vscodeTerminal.dispose) {
					vscodeTerminal.sendText(cancelledMsg + "\r\n", true);
				}
				// Prefer the actual exit code if available, otherwise default for SIGTERM.
				resolve({
					stdout,
					stderr,
					exitCode: exitCode ?? (signal === "SIGTERM" ? 130 : null),
				});
			} else {
				// Resolve with stdout, stderr, and exitCode. The caller should inspect exitCode
				// to determine if the command completed successfully (typically exitCode === 0).
				resolve({ stdout, stderr, exitCode });
			}
		});

		// Immediately check if the token was already cancelled before the promise or spawning completed.
		// This ensures quick termination for already-cancelled operations.
		if (token.isCancellationRequested) {
			const immediateCancelMsg = `Token already cancelled upon command initiation. Killing command [PID: ${
				child.pid ?? "N/A"
			}] immediately for command: "${fullCommandString}"`;
			console.log(immediateCancelMsg);
			if (vscodeTerminal && !vscodeTerminal.dispose) {
				vscodeTerminal.sendText(immediateCancelMsg + "\r\n", true);
			}
			cancellationInitiatedByToken = true;
			child.kill();
		}
	});
}
