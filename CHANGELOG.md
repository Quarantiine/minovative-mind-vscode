# Changelog

All notable changes to this project will be documented in this file.

## [2.46.0] - January 28, 2026

### Flash Lite Migration and Lightweight Classification

This update introduces a lightweight classification service using the Flash Lite model to perform rapid rewrite intent checks, improves token tracking within retry loops, and migrates core chat/plan generation to gemini-flash-lite-latest for enhanced efficiency and cost-effective accuracy.

- Introduced LightweightClassificationService for rapid intent and error message checks.
- Overhauled AIRequestService to accurately track total consumed input and output tokens across retries.
- Migrated core generation flows to gemini-flash-lite-latest as the default model.
- Updated sidebar state to persist and restore AiStreamingState across VS Code restarts.

## [2.45.2] - January 15, 2026

### Dynamic File Selection and Config Fetching

Refactored the context agent to integrate project configuration data (package.json/tsconfig.json) and supported targeted line range reading for more precise codebase investigation.

- Added gatherProjectConfigContext to scan for project structure hints and dependencies.
- Enhanced selectRelevantFilesAI to support fetching content by specific line ranges or symbols.
- Improved SafeCommandExecutor safety by cleaning quoted strings before execution.

## [2.45.0] - January 13, 2026

### Agentic Codebase Investigation

Integrates a secure agentic workflow where the Context Agent can actively explore the codebase using sandboxed terminal commands before selecting relevant files.

- Introduced SafeCommandExecutor to strictly whitelist and block dangerous shell operations.
- Implemented multi-turn agentic loop using Gemini function calling (run_terminal_command).
- Added transparent logging of executed commands directly into the chat interface.

## [2.44.0] - December 20, 2025

### Gemini 3 Preview Support

Updated model definitions to support Gemini 3 previews, switching the default PRO model to gemini-3-pro-preview.

## [2.43.3] - December 10, 2025

### Robust Cancellation and Resilience

Strengthened cancellation handling and error-resilience across AI requests and plan execution flows by adding cancellable delays and racing operations against cancellation tokens.

## [2.43.0] - December 2, 2025

### Unified Progress and Dependency Sync

Streamlined plan execution by removing internal retry mechanisms for commands and consolidating progress reporting to rely on chat history.

## [2.42.0] - December 1, 2025

### Binary File Detection and Prompt Refinement

Introduced binary file exclusion to prevent context pollution and refined AI system prompts to enforce stricter focus on user requests.

- Implemented binary file detection to skip non-textual content during context building.
- Added shell command retry logic for autonomous plans.

## [2.41.0] - November 18, 2025

### Documentation Workflow and /docs Command

Introduced a dedicated documentation workflow that generates comprehensive docs while removing redundant comments.

## [2.40.0] - November 17, 2025

### Heuristic Selection Control

Implemented user controls to enable or disable resource-intensive heuristic file selection during context building.

## [2.39.0] - November 17, 2025

### Symbol Hierarchy Analysis

Refactored context extraction to include detailed symbol hierarchy and active cursor position information via findActiveSymbolDetailedInfo.

## [2.37.2] - November 12, 2025

### Semantic Linking with TF-IDF

Introduced semantic code understanding by integrating TF-IDF analysis on file summaries to build a conceptual proximity graph.

## [2.36.0] - October 29, 2025

### Visual Plan Timeline

Implemented a real-time visual timeline in the sidebar to track autonomous execution steps.

## [2.35.1] - October 27, 2025

### Batch Modifications and Inverse Patches

Optimized performance by grouping file modifications into single LLM calls and implemented inverse patches for cleaner reversion logic.

## [2.34.2] - September 28, 2025

### PlanExecutionService Orchestration

Introduced PlanExecutionService to encapsulate handlers for file operations and enforce strict execution ordering.

## [2.33.0] - September 21, 2025

### Project Context and Multi-API Keys

Added project name display in the sidebar and introduced multi-API key management support.

## [2.31.0] - September 20, 2025

### Secure Agentic Workflows

Implemented comprehensive security checks for command execution, including allowlisting and argument validation.

## [2.30.0] - September 7, 2025

### Token Usage Statistics

Enhanced token usage tracking with model-specific usage percentages and a new UI panel for statistics.

## [2.27.0] - September 2, 2025

### Robust Operation ID Management

Introduced unique operation IDs to isolate concurrent AI operations, improving state management and UI responsiveness.

## [2.25.0] - August 27, 2025

### Gemini Function Calling

Leveraged Gemini's function-calling capabilities for structured plan generation, replacing legacy parsing methods.

## [2.22.0] - August 18, 2025

### Workspace Dependency Graphs

Implemented workspace dependency analysis with forward and reverse graphs to improve AI prompt relevance.

## [2.18.0] - August 14, 2025

### Chat Message Editing

Added full support for editing past chat messages, triggering AI regeneration from the edited point.

## [2.17.0] - July 31, 2025

### Workflow Plan Parsing Resilience

Refactored AI output control and workflow plan parsing to improve robustness against malformed responses.

## [2.14.0] - July 21, 2025

### Multimodal Chat Support

Implemented multimodal chat allowing users to upload images for visual context analysis.

## [2.12.0] - July 18, 2025

### Undo and Revert Functionality

Introduced a comprehensive revert mechanism allowing users to undo AI-applied workflow changes.

## [2.11.0] - July 17, 2025

### Plan Prompt Generation

Enabled generating actionable /plan prompts directly from AI chat messages.

## [2.6.0] - July 9, 2025

### Ultra-Precision Context System

Developed an intelligent file search system with multi-factor relevance scoring and dynamic sizing.

## [2.5.0] - July 7, 2025

### Live Code Generation

Introduced real-time typing animation for AI-generated code directly in the editor.

## [2.0.0] - July 6, 2025

### Local-First Architecture Transition

Removed account management and feature gating, transitioning to a streamlined local-first architecture.

## [1.4.5] - June 21, 2025

### Prompt and Firebase Refactors

Refined instructions for commit message generation, improving the clarity and consistency of AI-generated commit messages. Additionally, the Firebase service no longer implicitly creates user documents; previously, it would create a default document in Firestore if one didn't exist upon a user's initial sign-in or event, which has now been stopped.

- Refine: Refined commit message generation instructions for AI-generated commit messages.
- Refine: Stopped implicitly creating user documents in Firebase. The `firebaseService` previously created a default user document in Firestore if one didn't exist upon a user's initial sign-in or event.

## [1.4.4] - June 20, 2025

### Sanitize absolute paths in error messages

Enhances error handling by replacing absolute file system paths with workspace-relative paths or basenames within error messages. This improves user privacy by preventing the exposure of sensitive file system structures and makes error messages more concise and readable.

- New: Introduced `src/utils/pathUtils.ts` for robust path sanitization.
- Update: Refactored `planService` to integrate the new path sanitization for displayed errors.

## [1.4.3] - June 20, 2025

### Error handling and Robustness

Enhance error handling and plan execution robustness

- Implemented intelligent retry mechanism for "Service Unavailable" (503) and "model overloaded" errors from the Gemini API, ensuring automatic retries after a delay without switching API keys.
- Centralized all AI content generation calls through `AIRequestService` for improved robustness and consistent retry logic.
- Added robust `try-catch` blocks in plan execution to prevent AI API error messages from being written into source files, preserving file integrity.

## [1.4.2] - June 19, 2025

### AI Cancellation Handling Fix

Improve immediate cancellation handling: Add an early cancellation check at the start of the retry loop to prevent unnecessary attempts. Prioritize operation cancellation errors in error handling to ensure immediate re-throw and prevent retries.

## [1.4.1] - June 19, 2025

### Documentation Overhaul

Overhaul user-facing policies and usage guides: Enhanced transparency in PRIVACY_POLICY.md, strengthened TERMS_OF_USE.md, and updated USAGE.md with new features, UI/UX improvements, and clearer examples.

- PRIVACY_POLICY.md: Enhanced transparency on data collection, processing, storage, and sharing.
- TERMS_OF_USE.md: Strengthened user responsibility for AI-generated output and clarified payment processing.
- USAGE.md: Documented AI merge conflict resolution, smart context awareness, and resilient plan execution.

## [1.4.0] - June 19, 2025

### AI Merge Conflict Resolution

Automatically detects and resolves Git merge conflicts in the active file, generating a semantically coherent merged version.

## [1.3.0] - June 19, 2025

### Resilient Plan Execution

Implement robust step execution with auto-retries for transient errors and user-prompted intervention for failed steps.

## [1.2.6] - June 19, 2025

### Responsive Grid for Useful Links

Applies a new CSS Grid-based layout to the ‘Useful Links’ section in the settings webview for better organization and responsiveness.

## [1.2.5] - June 18, 2025

### AI Plan Parsing and Git Command Fix

Enhance AI plan parsing resilience with a retry mechanism and fix backtick escaping in git commit messages.

## [1.2.0] - June 18, 2025

### Sign In and UI Enhancements

Introduced 'Sign In' button, enhanced AI code generation context, and improved UI with responsive message rendering and chat history persistence.

- Added 'Sign In' button and settings panel command.
- Enhanced AI code generation with broader project context and TypeScript-aware module resolution.
- Improved UI with HTML rendering in MarkdownIt and animated loading indicators.

## [1.1.0] - June 16, 2025

### Symbol-Aware Refactoring

Added Symbol-Aware Refactoring feature leveraging VS Code symbol information for precise modifications.

## [1.0.0] - June 15, 2025

### First Release

First release of Minovative Mind in VS Code marketplace.

## [0.1.0-beta] - May 31, 2025

### Minovative Mind Developer Showcase

Initial beta release focused on project contextual code explanation and AI chat functionality.

- Early access to core AI-Agent capabilities including project contextual code explanation.
