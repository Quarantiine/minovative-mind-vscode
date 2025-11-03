import { ERROR_OPERATION_CANCELLED } from "../ai/gemini";
import * as vscode from "vscode";

export interface ParallelTask<T> {
	id: string;
	task: () => Promise<T>;
	priority: number;
	dependencies?: string[];
	timeout?: number;
	retries?: number;
	cancellationToken?: vscode.CancellationToken;
}

export interface ParallelTaskResult<T> {
	id: string;
	result: T;
	duration: number;
	success: boolean;
	error?: string;
	retries: number;
}

export interface ParallelProcessorConfig {
	maxConcurrency: number;
	defaultTimeout: number;
	defaultRetries: number;
	enableRetries: boolean;
	enableTimeout: boolean;
	cancellationToken?: vscode.CancellationToken;
}

export class ParallelProcessor {
	private static readonly DEFAULT_CONFIG: ParallelProcessorConfig = {
		maxConcurrency: 4,
		defaultTimeout: 30000, // 30 seconds
		defaultRetries: 2,
		enableRetries: true,
		enableTimeout: true,
	};

	/**
	 * Execute multiple tasks in parallel with concurrency control
	 */
	public static async executeParallel<T>(
		tasks: ParallelTask<T>[],
		config: Partial<ParallelProcessorConfig> = {},
		globalCancellationToken?: vscode.CancellationToken // Modified signature to accept global cancellation token
	): Promise<Map<string, ParallelTaskResult<T>>> {
		const finalConfig = { ...this.DEFAULT_CONFIG, ...config };
		const results = new Map<string, ParallelTaskResult<T>>();
		const running = new Set<string>();
		const completed = new Set<string>();
		const failed = new Set<string>();
		let isCancelled = false;

		// Sort tasks by priority (higher priority first)
		const queue = [...tasks].sort((a, b) => b.priority - a.priority);

		const executeTask = async (task: ParallelTask<T>): Promise<void> => {
			const startTime = Date.now();
			let retries = 0;
			const maxRetries = task.retries ?? finalConfig.defaultRetries;

			// Determine the effective cancellation token for this specific task execution.
			// Prioritize task-specific token, then config-level, then global.
			const currentTaskExecutionToken =
				task.cancellationToken ||
				finalConfig.cancellationToken ||
				globalCancellationToken;

			while (retries <= maxRetries) {
				try {
					// Check for cancellation before starting the task or a retry
					if (currentTaskExecutionToken?.isCancellationRequested) {
						throw new Error(ERROR_OPERATION_CANCELLED);
					}

					// Check dependencies
					if (task.dependencies) {
						const unmetDeps = task.dependencies.filter(
							(dep) => !completed.has(dep)
						);
						if (unmetDeps.length > 0) {
							// If dependencies are not met, throw an error. If the dependency itself
							// was cancelled, it would have been marked in `results` with ERROR_OPERATION_CANCELLED.
							throw new Error(`Dependencies not met: ${unmetDeps.join(", ")}`);
						}
					}

					running.add(task.id);

					// Execute task with optional timeout
					let result: T;
					if (finalConfig.enableTimeout) {
						const timeout = task.timeout ?? finalConfig.defaultTimeout;
						result = await Promise.race([
							task.task(),
							new Promise<never>((_, reject) =>
								setTimeout(
									() =>
										reject(
											new Error(`Task ${task.id} timed out after ${timeout}ms`)
										),
									timeout
								)
							),
						]);
					} else {
						result = await task.task();
					}

					const duration = Date.now() - startTime;
					results.set(task.id, {
						id: task.id,
						result,
						duration,
						success: true,
						retries,
					});

					completed.add(task.id);
					break; // Success, exit retry loop
				} catch (error) {
					// Check if the error is due to an explicit cancellation
					if (
						error instanceof Error &&
						error.message === ERROR_OPERATION_CANCELLED
					) {
						results.set(task.id, {
							id: task.id,
							result: null as T,
							duration: Date.now() - startTime,
							success: false,
							error: ERROR_OPERATION_CANCELLED,
							retries,
						});
						failed.add(task.id);
						// Re-throw the cancellation error to propagate it up and stop outer loops
						throw error;
					}

					retries++;
					const duration = Date.now() - startTime;

					if (retries > maxRetries || !finalConfig.enableRetries) {
						// Final failure (retries exhausted or retries not enabled)
						results.set(task.id, {
							id: task.id,
							result: null as T,
							duration,
							success: false,
							error: error instanceof Error ? error.message : String(error),
							retries,
						});
						failed.add(task.id);
						break; // Exit retry loop due to final failure
					} else {
						// Wait before retry (exponential backoff)
						const delay = Math.min(1000 * Math.pow(2, retries - 1), 5000);
						// This promise resolves on a timer, or immediately if cancellation is requested.
						const delayWithCancellation = new Promise<void>((resolve) => {
							const timer = setTimeout(() => {
								cancellationListener?.dispose();
								resolve();
							}, delay);

							const cancellationListener =
								currentTaskExecutionToken?.onCancellationRequested(() => {
									clearTimeout(timer);
									cancellationListener?.dispose();
									resolve();
								});
						});

						await delayWithCancellation;

						// Check for cancellation immediately after the delay (or early resolve due to cancellation)
						if (currentTaskExecutionToken?.isCancellationRequested) {
							throw new Error(ERROR_OPERATION_CANCELLED);
						}
						continue; // Retry
					}
				} finally {
					running.delete(task.id);
				}
			}
		};

		// Process tasks with concurrency control
		while (queue.length > 0 || running.size > 0) {
			if (isCancelled) {
				// Mark all remaining queued tasks as cancelled
				while (queue.length > 0) {
					const task = queue.shift()!;
					results.set(task.id, {
						id: task.id,
						result: null as T,
						duration: 0, // No execution time as it was cancelled before starting
						success: false,
						error: ERROR_OPERATION_CANCELLED,
						retries: 0,
					});
					failed.add(task.id);
				}
				// If no running tasks are left, we can break the loop
				if (running.size === 0) {
					break;
				}
			}

			// Start new tasks if under concurrency limit and not cancelled
			while (
				running.size < finalConfig.maxConcurrency &&
				queue.length > 0 &&
				!isCancelled
			) {
				const task = queue.shift()!;

				// Check if task can be executed (dependencies met)
				if (task.dependencies) {
					const unmetDeps = task.dependencies.filter(
						(dep) => !completed.has(dep)
					);
					if (unmetDeps.length > 0) {
						const failedDep = unmetDeps.find((dep) => failed.has(dep));
						if (failedDep) {
							// A dependency has failed for a non-cancellation reason, so this task must also fail.
							const errorMessage = `Task '${task.id}' failed because its dependency '${failedDep}' failed.`;
							results.set(task.id, {
								id: task.id,
								result: null as T,
								duration: 0,
								success: false,
								error: errorMessage,
								retries: 0,
							});
							failed.add(task.id);
							continue; // Do not re-queue, move to the next task in the queue.
						}

						// If dependencies are not yet met but none have failed, re-queue the task and try later
						queue.push(task);
						continue;
					}
				}

				executeTask(task).catch((error) => {
					if (
						error instanceof Error &&
						error.message === ERROR_OPERATION_CANCELLED
					) {
						isCancelled = true; // Set the flag to terminate the main loop promptly.
					} else {
						// Other errors are logged but don't stop the overall parallel execution.
						console.error(`Failed to execute task ${task.id}:`, error);
					}
				});
			}

			// Wait a bit before checking again to prevent busy-waiting
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		return results;
	}

	/**
	 * Process multiple files in parallel
	 */
	public static async processFilesInParallel<T>(
		files: vscode.Uri[],
		processor: (file: vscode.Uri) => Promise<T>,
		config: Partial<ParallelProcessorConfig> = {}
	): Promise<Map<string, ParallelTaskResult<T>>> {
		const tasks: ParallelTask<T>[] = files.map((file, index) => ({
			id: file.fsPath,
			task: () => processor(file),
			priority: files.length - index, // Process files in order (higher index = higher priority)
			dependencies: [],
			timeout: config.defaultTimeout,
			retries: config.defaultRetries,
			cancellationToken: config.cancellationToken, // Propagate config's token to individual tasks
		}));

		// Pass config.cancellationToken as the globalCancellationToken to executeParallel
		return this.executeParallel(tasks, config, config.cancellationToken);
	}

	/**
	 * Process files with dependency awareness
	 */
	public static async processFilesWithDependencies<T>(
		files: vscode.Uri[],
		processor: (file: vscode.Uri) => Promise<T>,
		dependencyGraph: Map<string, string[]>,
		config: Partial<ParallelProcessorConfig> = {}
	): Promise<Map<string, ParallelTaskResult<T>>> {
		const tasks: ParallelTask<T>[] = files.map((file, index) => {
			const filePath = file.fsPath;
			const dependencies = dependencyGraph.get(filePath) || [];

			return {
				id: filePath,
				task: () => processor(file),
				priority: files.length - index,
				dependencies: dependencies.length > 0 ? dependencies : undefined,
				timeout: config.defaultTimeout,
				retries: config.defaultRetries,
				cancellationToken: config.cancellationToken, // Propagate config's token to individual tasks
			};
		});

		// Pass config.cancellationToken as the globalCancellationToken to executeParallel
		return this.executeParallel(tasks, config, config.cancellationToken);
	}

	/**
	 * Execute tasks in batches for memory management
	 */
	public static async executeInBatches<T>(
		tasks: ParallelTask<T>[],
		batchSize: number = 10,
		config: Partial<ParallelProcessorConfig> = {}
	): Promise<Map<string, ParallelTaskResult<T>>> {
		const allResults = new Map<string, ParallelTaskResult<T>>();

		for (let i = 0; i < tasks.length; i += batchSize) {
			// Pass config.cancellationToken as the globalCancellationToken for the batch execution
			const batch = tasks.slice(i, i + batchSize);
			const batchResults = await this.executeParallel(
				batch,
				config,
				config.cancellationToken
			);

			// Merge batch results
			for (const [id, result] of batchResults) {
				allResults.set(id, result);
			}

			// Optional: Add delay between batches to prevent overwhelming the system
			if (i + batchSize < tasks.length) {
				// Add cancellation check to the delay between batches
				await new Promise((resolve) => {
					const timer = setTimeout(resolve, 100);
					config.cancellationToken?.onCancellationRequested(() => {
						clearTimeout(timer);
						resolve(null); // Resolve immediately on cancellation
					});
				});
				if (config.cancellationToken?.isCancellationRequested) {
					// If cancelled during the delay, stop processing further batches
					throw new Error(ERROR_OPERATION_CANCELLED);
				}
			}
		}

		return allResults;
	}

	/**
	 * Get execution statistics
	 */
	public static getExecutionStats<T>(
		results: Map<string, ParallelTaskResult<T>>
	): {
		totalTasks: number;
		successfulTasks: number;
		failedTasks: number;
		averageDuration: number;
		totalDuration: number;
		successRate: number;
	} {
		const totalTasks = results.size;
		const successfulTasks = Array.from(results.values()).filter(
			(r) => r.success
		).length;
		const failedTasks = totalTasks - successfulTasks;
		const totalDuration = Array.from(results.values()).reduce(
			(sum, r) => sum + r.duration,
			0
		);
		const averageDuration = totalTasks > 0 ? totalDuration / totalTasks : 0;
		const successRate =
			totalTasks > 0 ? (successfulTasks / totalTasks) * 100 : 0;

		return {
			totalTasks,
			successfulTasks,
			failedTasks,
			averageDuration,
			totalDuration,
			successRate,
		};
	}

	/**
	 * Create a task with automatic retry logic
	 */
	public static createRetryTask<T>(
		id: string,
		task: () => Promise<T>,
		options: {
			priority?: number;
			dependencies?: string[];
			timeout?: number;
			retries?: number;
			cancellationToken?: vscode.CancellationToken; // Added
		} = {}
	): ParallelTask<T> {
		return {
			id,
			task,
			priority: options.priority ?? 0,
			dependencies: options.dependencies,
			timeout: options.timeout,
			retries: options.retries,
			cancellationToken: options.cancellationToken, // Propagate option's token to task
		};
	}

	/**
	 * Create a task that depends on other tasks
	 */
	public static createDependentTask<T>(
		id: string,
		task: () => Promise<T>,
		dependencies: string[],
		options: {
			priority?: number;
			timeout?: number;
			retries?: number;
			cancellationToken?: vscode.CancellationToken; // Added
		} = {}
	): ParallelTask<T> {
		return {
			id,
			task,
			priority: options.priority ?? 0,
			dependencies,
			timeout: options.timeout,
			retries: options.retries,
			cancellationToken: options.cancellationToken, // Propagate option's token to task
		};
	}
}
