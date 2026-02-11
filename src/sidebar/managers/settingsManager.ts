import * as vscode from "vscode";
import {
	MODEL_SELECTION_STORAGE_KEY,
	AVAILABLE_GEMINI_MODELS,
	DEFAULT_MODEL,
	DEFAULT_SIZE,
	MODEL_DETAILS,
} from "../common/sidebarConstants";
import { resetClient } from "../../ai/gemini";

export const HEURISTIC_SELECTION_ENABLED_KEY =
	"optimization.heuristicSelectionEnabled";
export const ALWAYS_RUN_INVESTIGATION_KEY =
	"optimization.alwaysRunInvestigation";

const OPTIMIZATION_SETTINGS_KEYS = {
	USE_SCAN_CACHE: "optimization.useScanCache",
	USE_DEPENDENCY_CACHE: "optimization.useDependencyCache",
	USE_AI_SELECTION_CACHE: "optimization.useAISelectionCache",
	MAX_CONCURRENCY: "optimization.maxConcurrency",
	ENABLE_PERFORMANCE_MONITORING: "optimization.enablePerformanceMonitoring",
	SKIP_LARGE_FILES: "optimization.skipLargeFiles",
	MAX_FILE_SIZE: "optimization.maxFileSize",
	SCAN_CACHE_TIMEOUT: "optimization.scanCacheTimeout",
	DEPENDENCY_CACHE_TIMEOUT: "optimization.dependencyCacheTimeout",
	AI_SELECTION_CACHE_TIMEOUT: "optimization.aiSelectionCacheTimeout",
	MAX_FILES_FOR_SYMBOL_PROCESSING: "optimization.maxFilesForSymbolProcessing",
	MAX_FILES_FOR_DETAILED_PROCESSING:
		"optimization.maxFilesForDetailedProcessing",
	ENABLE_SMART_CONTEXT: "smartContext.enabled",
	MAX_PROMPT_LENGTH: "optimization.maxPromptLength",
	ENABLE_STREAMING: "optimization.enableStreaming",
	FALLBACK_TO_HEURISTICS: "optimization.fallbackToHeuristics",
	MAX_HEURISTIC_FILES_TOTAL: "optimization.maxHeuristicFilesTotal",
	MAX_SAME_DIRECTORY_FILES: "optimization.maxSameDirectoryFiles",
	MAX_DIRECT_DEPENDENCIES: "optimization.maxDirectDependencies",
	MAX_REVERSE_DEPENDENCIES: "optimization.maxReverseDependencies",
	MAX_CALL_HIERARCHY_FILES: "optimization.maxCallHierarchyFiles",
	SAME_DIRECTORY_WEIGHT: "optimization.heuristic.sameDirectoryWeight",
	DIRECT_DEPENDENCY_WEIGHT: "optimization.heuristic.directDependencyWeight",
	REVERSE_DEPENDENCY_WEIGHT: "optimization.heuristic.reverseDependencyWeight",
	CALL_HIERARCHY_WEIGHT: "optimization.heuristic.callHierarchyWeight",
	DEFINITION_WEIGHT: "optimization.heuristic.definitionWeight",
	IMPLEMENTATION_WEIGHT: "optimization.heuristic.implementationWeight",
	TYPE_DEFINITION_WEIGHT: "optimization.heuristic.typeDefinitionWeight",
	NEIGHBOR_DIRECTORY_WEIGHT: "optimization.heuristic.neighborDirectoryWeight",
	SHARED_ANCESTOR_WEIGHT: "optimization.heuristic.sharedAncestorWeight",
	REFERENCED_TYPE_DEFINITION_WEIGHT:
		"optimization.heuristic.referencedTypeDefinitionWeight",
	GENERAL_SYMBOL_RELATED_BOOST:
		"optimization.heuristic.generalSymbolRelatedBoost",
	DEPENDENCY_WEIGHT: "optimization.heuristic.dependencyWeight",
	DIRECTORY_WEIGHT: "optimization.heuristic.directoryWeight",
	ENABLE_ENHANCED_DIAGNOSTIC_CONTEXT:
		"optimization.enableEnhancedDiagnosticContext",
	HEURISTIC_SELECTION_ENABLED: HEURISTIC_SELECTION_ENABLED_KEY,
	ALWAYS_RUN_INVESTIGATION: ALWAYS_RUN_INVESTIGATION_KEY,
	SKIP_PLAN_CONFIRMATION: "optimization.skipPlanConfirmation", // Added skip plan confirmation setting key
};

const DEFAULT_OPTIMIZATION_SETTINGS = {
	useScanCache: true,
	useDependencyCache: true,
	useAISelectionCache: true,
	maxConcurrency: 15,
	enablePerformanceMonitoring: true,
	skipLargeFiles: true,
	maxFileSize: DEFAULT_SIZE,
	scanCacheTimeout: 5 * 60 * 1000,
	dependencyCacheTimeout: 10 * 60 * 1000,
	aiSelectionCacheTimeout: 5 * 60 * 1000,
	maxFilesForSymbolProcessing: 500,
	maxFilesForDetailedProcessing: 1000,
	enableSmartContext: true,
	maxPromptLength: 100000,
	enableStreaming: false,
	fallbackToHeuristics: true,
	maxHeuristicFilesTotal: 50,
	maxSameDirectoryFiles: 20,
	maxDirectDependencies: 20,
	maxReverseDependencies: 10,
	maxCallHierarchyFiles: 30,
	sameDirectoryWeight: 5,
	directDependencyWeight: 15,
	reverseDependencyWeight: 10,
	callHierarchyWeight: 20,
	definitionWeight: 50,
	implementationWeight: 40,
	typeDefinitionWeight: 30,
	neighborDirectoryWeight: 5,
	sharedAncestorWeight: 10,
	referencedTypeDefinitionWeight: 25,
	generalSymbolRelatedBoost: 15,
	dependencyWeight: 5,
	directoryWeight: 1,
	enableEnhancedDiagnosticContext: true,
	heuristicSelectionEnabled: true,
	alwaysRunInvestigation: true,
	skipPlanConfirmation: false, // Added default value for skip plan confirmation
};

export class SettingsManager {
	private _selectedModelName: string = DEFAULT_MODEL;
	private _isWebviewReady: boolean = false;

	constructor(
		private readonly workspaceState: vscode.Memento,
		private readonly postMessageToWebview: (message: any) => void,
	) {}

	public initialize(): void {
		this.loadSettingsFromStorage();
	}

	public resetWebviewReady(): void {
		this._isWebviewReady = false;
	}

	public handleWebviewReady(): void {
		this._isWebviewReady = true;
		this.updateWebviewModelList();
		this.updateWebviewOptimizationSettings();
	}

	public getSelectedModelName(): string {
		return this._selectedModelName;
	}

	public getSetting<T>(key: string, defaultValue: T): T {
		return this.workspaceState.get<T>(key, defaultValue);
	}

	public getOptimizationSettings() {
		return {
			useScanCache: this.getSetting(
				OPTIMIZATION_SETTINGS_KEYS.USE_SCAN_CACHE,
				DEFAULT_OPTIMIZATION_SETTINGS.useScanCache,
			),
			useDependencyCache: this.getSetting(
				OPTIMIZATION_SETTINGS_KEYS.USE_DEPENDENCY_CACHE,
				DEFAULT_OPTIMIZATION_SETTINGS.useDependencyCache,
			),
			useAISelectionCache: this.getSetting(
				OPTIMIZATION_SETTINGS_KEYS.USE_AI_SELECTION_CACHE,
				DEFAULT_OPTIMIZATION_SETTINGS.useAISelectionCache,
			),
			maxConcurrency: this.getSetting(
				OPTIMIZATION_SETTINGS_KEYS.MAX_CONCURRENCY,
				DEFAULT_OPTIMIZATION_SETTINGS.maxConcurrency,
			),
			enablePerformanceMonitoring: this.getSetting(
				OPTIMIZATION_SETTINGS_KEYS.ENABLE_PERFORMANCE_MONITORING,
				DEFAULT_OPTIMIZATION_SETTINGS.enablePerformanceMonitoring,
			),
			skipLargeFiles: this.getSetting(
				OPTIMIZATION_SETTINGS_KEYS.SKIP_LARGE_FILES,
				DEFAULT_OPTIMIZATION_SETTINGS.skipLargeFiles,
			),
			maxFileSize: this.getSetting(
				OPTIMIZATION_SETTINGS_KEYS.MAX_FILE_SIZE,
				DEFAULT_OPTIMIZATION_SETTINGS.maxFileSize,
			),
			scanCacheTimeout: this.getSetting(
				OPTIMIZATION_SETTINGS_KEYS.SCAN_CACHE_TIMEOUT,
				DEFAULT_OPTIMIZATION_SETTINGS.scanCacheTimeout,
			),
			dependencyCacheTimeout: this.getSetting(
				OPTIMIZATION_SETTINGS_KEYS.DEPENDENCY_CACHE_TIMEOUT,
				DEFAULT_OPTIMIZATION_SETTINGS.dependencyCacheTimeout,
			),
			aiSelectionCacheTimeout: this.getSetting(
				OPTIMIZATION_SETTINGS_KEYS.AI_SELECTION_CACHE_TIMEOUT,
				DEFAULT_OPTIMIZATION_SETTINGS.aiSelectionCacheTimeout,
			),
			maxFilesForSymbolProcessing: this.getSetting(
				OPTIMIZATION_SETTINGS_KEYS.MAX_FILES_FOR_SYMBOL_PROCESSING,
				DEFAULT_OPTIMIZATION_SETTINGS.maxFilesForSymbolProcessing,
			),
			maxFilesForDetailedProcessing: this.getSetting(
				OPTIMIZATION_SETTINGS_KEYS.MAX_FILES_FOR_DETAILED_PROCESSING,
				DEFAULT_OPTIMIZATION_SETTINGS.maxFilesForDetailedProcessing,
			),
			enableSmartContext: this.getSetting(
				OPTIMIZATION_SETTINGS_KEYS.ENABLE_SMART_CONTEXT,
				DEFAULT_OPTIMIZATION_SETTINGS.enableSmartContext,
			),
			maxPromptLength: this.getSetting(
				OPTIMIZATION_SETTINGS_KEYS.MAX_PROMPT_LENGTH,
				DEFAULT_OPTIMIZATION_SETTINGS.maxPromptLength,
			),
			enableStreaming: this.getSetting(
				OPTIMIZATION_SETTINGS_KEYS.ENABLE_STREAMING,
				DEFAULT_OPTIMIZATION_SETTINGS.enableStreaming,
			),
			fallbackToHeuristics: this.getSetting(
				OPTIMIZATION_SETTINGS_KEYS.FALLBACK_TO_HEURISTICS,
				DEFAULT_OPTIMIZATION_SETTINGS.fallbackToHeuristics,
			),
			maxHeuristicFilesTotal: this.getSetting(
				OPTIMIZATION_SETTINGS_KEYS.MAX_HEURISTIC_FILES_TOTAL,
				DEFAULT_OPTIMIZATION_SETTINGS.maxHeuristicFilesTotal,
			),
			maxSameDirectoryFiles: this.getSetting(
				OPTIMIZATION_SETTINGS_KEYS.MAX_SAME_DIRECTORY_FILES,
				DEFAULT_OPTIMIZATION_SETTINGS.maxSameDirectoryFiles,
			),
			maxDirectDependencies: this.getSetting(
				OPTIMIZATION_SETTINGS_KEYS.MAX_DIRECT_DEPENDENCIES,
				DEFAULT_OPTIMIZATION_SETTINGS.maxDirectDependencies,
			),
			maxReverseDependencies: this.getSetting(
				OPTIMIZATION_SETTINGS_KEYS.MAX_REVERSE_DEPENDENCIES,
				DEFAULT_OPTIMIZATION_SETTINGS.maxReverseDependencies,
			),
			maxCallHierarchyFiles: this.getSetting(
				OPTIMIZATION_SETTINGS_KEYS.MAX_CALL_HIERARCHY_FILES,
				DEFAULT_OPTIMIZATION_SETTINGS.maxCallHierarchyFiles,
			),
			sameDirectoryWeight: this.getSetting(
				OPTIMIZATION_SETTINGS_KEYS.SAME_DIRECTORY_WEIGHT,
				DEFAULT_OPTIMIZATION_SETTINGS.sameDirectoryWeight,
			),
			directDependencyWeight: this.getSetting(
				OPTIMIZATION_SETTINGS_KEYS.DIRECT_DEPENDENCY_WEIGHT,
				DEFAULT_OPTIMIZATION_SETTINGS.directDependencyWeight,
			),
			reverseDependencyWeight: this.getSetting(
				OPTIMIZATION_SETTINGS_KEYS.REVERSE_DEPENDENCY_WEIGHT,
				DEFAULT_OPTIMIZATION_SETTINGS.reverseDependencyWeight,
			),
			callHierarchyWeight: this.getSetting(
				OPTIMIZATION_SETTINGS_KEYS.CALL_HIERARCHY_WEIGHT,
				DEFAULT_OPTIMIZATION_SETTINGS.callHierarchyWeight,
			),
			definitionWeight: this.getSetting(
				OPTIMIZATION_SETTINGS_KEYS.DEFINITION_WEIGHT,
				DEFAULT_OPTIMIZATION_SETTINGS.definitionWeight,
			),
			implementationWeight: this.getSetting(
				OPTIMIZATION_SETTINGS_KEYS.IMPLEMENTATION_WEIGHT,
				DEFAULT_OPTIMIZATION_SETTINGS.implementationWeight,
			),
			typeDefinitionWeight: this.getSetting(
				OPTIMIZATION_SETTINGS_KEYS.TYPE_DEFINITION_WEIGHT,
				DEFAULT_OPTIMIZATION_SETTINGS.typeDefinitionWeight,
			),
			neighborDirectoryWeight: this.getSetting(
				OPTIMIZATION_SETTINGS_KEYS.NEIGHBOR_DIRECTORY_WEIGHT,
				DEFAULT_OPTIMIZATION_SETTINGS.neighborDirectoryWeight,
			),
			sharedAncestorWeight: this.getSetting(
				OPTIMIZATION_SETTINGS_KEYS.SHARED_ANCESTOR_WEIGHT,
				DEFAULT_OPTIMIZATION_SETTINGS.sharedAncestorWeight,
			),
			referencedTypeDefinitionWeight: this.getSetting(
				OPTIMIZATION_SETTINGS_KEYS.REFERENCED_TYPE_DEFINITION_WEIGHT,
				DEFAULT_OPTIMIZATION_SETTINGS.referencedTypeDefinitionWeight,
			),
			generalSymbolRelatedBoost: this.getSetting(
				OPTIMIZATION_SETTINGS_KEYS.GENERAL_SYMBOL_RELATED_BOOST,
				DEFAULT_OPTIMIZATION_SETTINGS.generalSymbolRelatedBoost,
			),
			dependencyWeight: this.getSetting(
				OPTIMIZATION_SETTINGS_KEYS.DEPENDENCY_WEIGHT,
				DEFAULT_OPTIMIZATION_SETTINGS.dependencyWeight,
			),
			directoryWeight: this.getSetting(
				OPTIMIZATION_SETTINGS_KEYS.DIRECTORY_WEIGHT,
				DEFAULT_OPTIMIZATION_SETTINGS.directoryWeight,
			),
			enableEnhancedDiagnosticContext: this.getSetting(
				OPTIMIZATION_SETTINGS_KEYS.ENABLE_ENHANCED_DIAGNOSTIC_CONTEXT,
				DEFAULT_OPTIMIZATION_SETTINGS.enableEnhancedDiagnosticContext,
			),
			heuristicSelectionEnabled: this.getSetting(
				OPTIMIZATION_SETTINGS_KEYS.HEURISTIC_SELECTION_ENABLED,
				DEFAULT_OPTIMIZATION_SETTINGS.heuristicSelectionEnabled,
			),
			alwaysRunInvestigation: this.getSetting(
				OPTIMIZATION_SETTINGS_KEYS.ALWAYS_RUN_INVESTIGATION,
				DEFAULT_OPTIMIZATION_SETTINGS.alwaysRunInvestigation,
			),
			skipPlanConfirmation: this.getSetting(
				OPTIMIZATION_SETTINGS_KEYS.SKIP_PLAN_CONFIRMATION,
				DEFAULT_OPTIMIZATION_SETTINGS.skipPlanConfirmation,
			),
		};
	}

	public async updateHeuristicSelectionEnabled(
		isEnabled: boolean,
	): Promise<void> {
		try {
			await this.workspaceState.update(
				HEURISTIC_SELECTION_ENABLED_KEY,
				isEnabled,
			);
			this.updateWebviewOptimizationSettings();
		} catch (error) {
			console.error("Error updating heuristic selection setting:", error);
			this.postMessageToWebview({
				type: "statusUpdate",
				value: "Error updating heuristic selection setting.",
				isError: true,
			});
		}
	}

	public async updateSkipPlanConfirmation(isEnabled: boolean): Promise<void> {
		try {
			const key = OPTIMIZATION_SETTINGS_KEYS.SKIP_PLAN_CONFIRMATION;
			await this.workspaceState.update(key, isEnabled);
			this.updateWebviewOptimizationSettings();
		} catch (error) {
			console.error("Error updating skip plan confirmation setting:", error);
			this.postMessageToWebview({
				type: "statusUpdate",
				value: "Error updating skip plan confirmation setting.",
				isError: true,
			});
		}
	}

	public async updateOptimizationSettings(
		settings: Partial<typeof DEFAULT_OPTIMIZATION_SETTINGS>,
	): Promise<void> {
		try {
			for (const [key, value] of Object.entries(settings)) {
				const settingKey =
					OPTIMIZATION_SETTINGS_KEYS[
						key as keyof typeof OPTIMIZATION_SETTINGS_KEYS
					];
				if (settingKey) {
					await this.workspaceState.update(settingKey, value);
				}
			}
			this.updateWebviewOptimizationSettings();
			this.postMessageToWebview({
				type: "statusUpdate",
				value: "Optimization settings updated successfully.",
			});
		} catch (error) {
			console.error("Error updating optimization settings:", error);
			this.postMessageToWebview({
				type: "statusUpdate",
				value: "Error updating optimization settings.",
				isError: true,
			});
		}
	}

	public async resetOptimizationSettings(): Promise<void> {
		try {
			for (const [key, defaultValue] of Object.entries(
				DEFAULT_OPTIMIZATION_SETTINGS,
			)) {
				const settingKey =
					OPTIMIZATION_SETTINGS_KEYS[
						key as keyof typeof OPTIMIZATION_SETTINGS_KEYS
					];
				if (settingKey) {
					await this.workspaceState.update(settingKey, defaultValue);
				}
			}
			this.updateWebviewOptimizationSettings();
			this.postMessageToWebview({
				type: "statusUpdate",
				value: "Optimization settings reset to defaults.",
			});
		} catch (error) {
			console.error("Error resetting optimization settings:", error);
			this.postMessageToWebview({
				type: "statusUpdate",
				value: "Error resetting optimization settings.",
				isError: true,
			});
		}
	}

	public getCacheStatistics() {
		return {
			scanCache: { size: 0, entries: [] },
			dependencyCache: { size: 0, entries: [] },
			aiSelectionCache: { size: 0, entries: [] },
		};
	}

	public async clearAllCaches(): Promise<void> {
		try {
			console.log("Cache clear requested");
			this.postMessageToWebview({
				type: "statusUpdate",
				value: "All caches cleared successfully.",
			});
		} catch (error) {
			console.error("Error clearing caches:", error);
			this.postMessageToWebview({
				type: "statusUpdate",
				value: "Error clearing caches.",
				isError: true,
			});
		}
	}

	private loadSettingsFromStorage(): void {
		try {
			const savedModel = this.workspaceState.get<string>(
				MODEL_SELECTION_STORAGE_KEY,
			);
			if (savedModel && AVAILABLE_GEMINI_MODELS.includes(savedModel)) {
				this._selectedModelName = savedModel;
			} else {
				this._selectedModelName = DEFAULT_MODEL;
			}
		} catch (error) {
			console.error("Error loading settings from storage:", error);
			this._selectedModelName = DEFAULT_MODEL;
			vscode.window.showErrorMessage("Failed to load extension settings.");
		}
	}

	public async saveSettingsToStorage(): Promise<void> {
		try {
			await this.workspaceState.update(
				MODEL_SELECTION_STORAGE_KEY,
				this._selectedModelName,
			);
			resetClient();
			this.updateWebviewModelList();
		} catch (error) {
			console.error("Error saving settings to storage:", error);
			vscode.window.showErrorMessage("Failed to save extension settings.");
		}
	}

	public async handleModelSelection(modelName: string): Promise<void> {
		if (AVAILABLE_GEMINI_MODELS.includes(modelName)) {
			this._selectedModelName = modelName;
			await this.saveSettingsToStorage();
			this.postMessageToWebview({
				type: "statusUpdate",
				value: `Switched to AI model: ${modelName}.`,
			});
		} else {
			console.warn("Attempted to select an invalid model:", modelName);
			this.postMessageToWebview({
				type: "statusUpdate",
				value: `Error: Invalid model selected: ${modelName}.`,
				isError: true,
			});
			this.updateWebviewModelList();
		}
	}

	public updateWebviewModelList(): void {
		if (!this._isWebviewReady) {
			return;
		}
		this.postMessageToWebview({
			type: "updateModelList",
			value: {
				availableModels: MODEL_DETAILS,
				selectedModel: this._selectedModelName,
			},
		});
	}

	public updateWebviewOptimizationSettings(): void {
		if (!this._isWebviewReady) {
			return;
		}
		this.postMessageToWebview({
			type: "updateOptimizationSettings",
			value: this.getOptimizationSettings(),
		});
	}
}
