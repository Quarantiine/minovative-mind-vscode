# Minovative Mind Capabilities

Minovative Mind is a powerful AI-augmented Visual Studio Code extension that integrates Google Gemini models into your development workflow. It dramatically enhances developer productivity through intelligent assistance, autonomous planning, and advanced AI-driven coding support.

## 🚀 Core Functionalities at a Glance

- **Intelligent AI Chat Interface**: Multimodal interaction, context-aware Q&A, **Contextual History Summarization**, and rich file interactions.
- **Autonomous AI Workflows**: AI-driven planning, execution of multi-step tasks, intelligent code modification, and **Autonomous Self-Correction**.
- **Project Context & Intelligence**: Deep codebase analysis, Symbol Intelligence, **Progressive Discovery** for large projects, and **Intent-Aware Context** classification.
- **Reliability, Control & Performance**: Centralized concurrency, secure filesystem operations, **Output Integrity Validation**, and optimized resource handling.
- **Flexible Customization**: API key management, model selection, and granular context filtering.

---

## 1. AI Chat & Interactive Experience

Minovative Mind offers an intuitive chat interface for direct interaction with AI, designed to be both powerful and user-friendly.

### 1.1 Multimodal Interaction

- **Text and Image Input**: Engage with the AI using text prompts and image uploads (Base64 data), enabling visually aware conversations.
- **Context-Aware Q&A**: The AI leverages the active editor file, selected code, and broader workspace context to provide highly relevant answers and insights.

### 1.2 Rich Chat Interface & Actions

- **Interactive File Display**: Within the chat, you can open, expand, or collapse contextual files relevant to the conversation.
- **Direct Chat from Editor**: Initiate a chat directly from the active editor via right-click context menu or `Ctrl/Cmd+M`, sending selected code or the full file to the AI for discussion.
- **Dynamic Markdown Responses**: AI-generated Markdown responses are rendered with rich HTML support for interactive content.
- **Inline Code Actions**: Easily copy code snippets from AI responses or apply changes directly to your active editor.
- **Slash Command Suggestions**: Utilize intelligent suggestions for commands like `/plan`, `/fix`, and `/commit` to streamline actions.
- **Editable History**: Edit previous messages to re-evaluate conversations with updated context.
- **Convert to Plans**: AI-generated responses can be seamlessly converted into actionable `/plan` commands for structured execution.
- **Plan & Agent Logs**: AI-generated plan explanations display a "Generated Plan" badge. Context Agent logs feature **terminal-like styling** and **collapsible code blocks** (Show Code/Hide Code) to keep detailed output compact. The sidebar UI includes **collapsible sections** for organized navigation during inactivity.
- **Interactive File Selector**: A dedicated "Open File List" button provides a dynamic, searchable, and navigable popup. Users can efficiently select workspace files to insert their paths directly into the chat input, complete with search, keyboard navigation, and visual enhancements.

### 1.3 Code Explanation

- **Direct Explanation**: Trigger AI-driven explanations for selected code via the VS Code right-click context menu or a dedicated command.
- **Concise Output**: Explanations are presented clearly within VS Code information modals for quick review.

---

## 2. Autonomous AI Workflows & Code Transformation

Minovative Mind can autonomously plan and execute complex development tasks, significantly accelerating your coding process and transforming code.

### 2.1 AI Planning & Execution

- **High-Level Goal Execution**: Provide a high-level objective, and the AI will generate a structured, multi-step plan to achieve it.
- **Automated Workflow**: The AI executes its plan by creating new files, writing and modifying code, and running shell commands (`create_directory`, `create_file`, `modify_file`, `run_command`).
- **Intelligent Command Escalation**: Commands like `/fix` or general code edits can automatically escalate to a full plan execution when task complexity warrants it.
- **Dynamic Context Refinement**: Unlike static plans, the AI re-evaluates project context _before every single step_. It investigates the codebase and reads only the specific lines of code needed for that step (e.g., "read lines 50-100 of auth.ts"), ensuring maximum accuracy and minimal token usage.
- **Confirmation & Controls**: You'll be prompted for confirmation before a plan executes by default, but this can be skipped using the "Fast Forward" toggle for rapid execution. You can also monitor progress and cancel specific ongoing tasks. The plan timeline now includes **(Auto-retry X/Y)** indicators for resilient step execution.
- **Autonomous Self-Correction & Context Rebuilding**: Automatically detects and repairs issues introduced during code generation or modification. It monitors **real-time diagnostics** and uses the **exact error message text** to identify root causes. The system now **automatically rebuilds project context** when diagnostics show an Error, ensuring the agent sees the failure context immediately.

### 2.2 Intelligent Code Modification

- **Flexible Scope**: The AI can refactor, edit, or modify either selected code snippets or the entire active file based on your instructions.
- **Dedicated Documentation Workflow (`/docs`)**: A specialized Quick Pick command that automatically generates a high-level plan instruction for the AI to simultaneously **add comprehensive documentation** and **remove useless or redundant comments** from the selected code or the entire active file, ensuring immediate standardization and clarity.
- **Symbol-Aware Context**: Leverages detailed symbol information (functions, classes, types) from your codebase to ensure accurate and contextually relevant modifications.
- **Quality & Production-Ready Code**: Generates modular, maintainable, and production-ready code, often using diff analysis to validate output quality.
- **Output Validation**: Employs sophisticated heuristics to sanitize and validate AI-generated code snippets, ensuring functional and high-quality output.
- **Surgical Code Editing & Integrity Validation**: Uses an intelligent "Search and Replace" block system (`SEARC#H / ===#=== / REPLAC#E`) to update only specific parts of a file. This hardened protocol ensures maximum uniqueness and prevents collisions. **Output Integrity Validation** checks for malformed markers or partial fragments, autonomously retrying if output is corrupted.
- **Full File Regeneration**: For massive rewrites or new files, the AI can still generate full content when necessary.

### 2.3 Code Streaming

- **Live Generation**: Code generated by AI (for `create_file` and `modify_file` steps) is streamed character-by-character directly into the editor.
- **Enhanced User Experience**: Provides immediate visual feedback with a **Smart Flash** effect that highlights changes across the full line width. The flash persists until you interact with the specific code, ensuring you never miss an update.
- **Real-time Status Updates**: Receive granular status updates during execution (e.g., "Analyzing structure", "Applying changes", "Retrying..."). Real-time status now includes visual success (`✓`) and warning (`⚠️`) indicators for each file.

### 2.4 Integrated Git Automation

- **Automated Commit Messages**: Use the `/commit` command to have the AI analyze your staged changes and generate insightful, descriptive Git commit messages.
- **Review & Edit**: The AI prompts you to review and edit the generated message before committing.

---

## 3. Project Context & Intelligence

Minovative Mind builds a profound understanding of your project using comprehensive analysis, intelligent filtering, and advanced context optimization techniques.

### 3.1 Core Context Engine

- **Rich Data Integration**: Integrates various contextual data points, including VS Code diagnostics, user selection, document symbols, and code references.
- **Dynamic Memory Updates**: Tracks recent changes in the workspace to continually update the AI's contextual understanding.
- **External Content Processing**: Extracts and processes content directly from URLs or linked files, enhancing its comprehension and actionability.
- **Efficient Workspace Scanning**: Utilizes an intelligent workspace scanner with filtering to quickly identify and process relevant project files, respecting `.gitignore` rules.
- **Symbol Intelligence**: Builds a comprehensive symbol tree and provides deep, context-aware analysis and type resolution using modern IDE symbol and reference APIs.

### 3.2 Advanced Relevance & Optimization

- **Prioritized Context**: Prioritizes files that are recently modified, linked by symbols, or are directly related to the user's active context, with refined relevance scoring considering symbols and references.
- **Intelligent File Summarization**: Summarizes file content to fit within token limits while preserving critical information, including detailed file complexity estimation and enhanced main purpose detection.
- **Priority File Selection**: Automatically identifies uncommitted git changes and active editor files as priority context, ensuring the AI always has visibility into the most relevant working-set files.
- **Cached Analysis**: Caches file analysis results to improve performance for symbol and reference lookups. It includes internal file caching to prevent redundant processing.
- **Smart Truncation & Progressive Loading**: Employs intelligent truncation and progressive loading of content to optimize token usage and response times.

### 3.4 Agentic Context Investigation

- **Active Codebase Exploration**: The Context Agent proactively "looks around" your codebase using high-performance models (**Gemini Flash Lite**) and specialized tools. It leverages safe terminal commands (`git ls-files`, `grep`, `find`, `cat`, `head`, `tail`, `wc`, `file`) and deep symbol analysis tools (`get_implementations`, `get_type_definition`, `get_call_hierarchy`, `get_git_diffs`). All search commands are automatically transformed to respect `.gitignore` rules through injected exclusion flags.
- **Stricter tool-driven loop**: To ensure accuracy, the agent now operates in a stricter agentic loop, mandating the use of investigative tools to discover files before making a selection. Legacy fallbacks have been removed in favor of this robust investigation.
- **Progressive Discovery**: For large repositories, the agent starts with a highly efficient, truncated view of the project structure and discovers files on-demand using **Progressive Discovery**, reducing initial context token usage by up to 90%.
- **Intent-Aware Context**: Automatically classifies the user's intent (e.g., bug fixing vs. general query) to prioritize the most relevant diagnostic or symbol information for the context.
- **AI-Driven Error Investigation**: Automatically detects when you're asking about errors or bugs using intelligent intent classification and proactively investigates error messages, stack traces, and relevant code paths before generating a response.
- **Safe Execution Environment**: All investigation commands are executed in a secure, read-only sandbox that prevents modification or external network access. Commands are automatically enhanced with comprehensive exclusion lists covering all major languages and frameworks (Node.js, Python, Java, Go, Rust, Ruby, PHP, C/C++, .NET, iOS/macOS, Terraform) to skip build artifacts, dependencies, and binary files.
- **Transparent Operation**: You see exactly what the agent is doing—every command run and its output is logged transparently in the chat interface.

### 3.3 Resilient Context Construction

- **Large Project Handling**: Designed to efficiently handle large projects by strategically skipping oversized files (e.g., 1MB+ files).
- **Intelligent File Exclusion**: Automatically excludes binary files and adheres to `.gitignore` rules to optimize context and avoid irrelevant data. The `SafeCommandExecutor` proactively transforms `grep`, `find`, and `ls -R` commands with gitignore-aligned exclusion filters, ensuring the agent never searches through `node_modules`, `dist`, `build`, or other generated content.
- **Language Detection**: Includes robust language detection for files without extensions, ensuring accurate context formatting for the AI.

---

## 4. Reliability, Control & Performance

Minovative Mind prioritizes user control, project security, transparent operation, and optimized resource utilization.

### 4.1 Core System Reliability & Concurrency

- **Centralized Concurrency Control**: Concurrency management is centralized and robust, ensuring predictable behavior and overall system reliability during multi-step AI operations.
- **Optimized AI Request Handling**: Employs parallel processing and batching for concurrent AI calls, enhancing scalability and managing workload efficiently.
- **LRU Cache**: Implements an LRU (Least Recently Used) cache with preloading for frequently accessed data, minimizing latency.
- **Dynamic Content Limits**: Enforces file size and context limits to manage memory and API token usage effectively.
- **Progressive Analysis**: Utilizes progressive analysis and refinement of context, ensuring efficiency even with complex tasks.

### 4.2 Security & Filesystem Safety

- **Workspace-Bound Operations**: All file system modifications and creations are strictly confined to the user's active VS Code workspace directory, preventing unintended changes outside the project scope.
- **AI Output Sanitization**: Implements robust sanitization of AI responses to strip agent control sequences, leaked tool calls, and raw HTML, ensuring a clean and secure output rendering in the chat interface.
- **Shell Command Approval**: Requires explicit user confirmation for every `run_command` step within an AI-generated plan. Users have the power to allow, skip, or cancel individual execution steps.

### 4.3 Change Auditing & Reversibility

- **Project Change Logging**: Accurately tracks all file system changes (additions, modifications, deletions) made by AI-driven workflows.
- **Reversible AI Plans**: Enables safe experimentation by allowing users to easily revert entire AI plans with a dedicated button.
- **Auditable Change Log**: Maintains a detailed log of all AI-driven changes for transparency and auditing.

### 4.4 Transparency & Monitoring

- **Real-time Progress Indicators**: Provides constant, visible feedback on ongoing AI tasks using VS Code notifications.
- **Cancellable Tasks**: Supports cancellation of most AI-driven tasks via `CancellationToken`, allowing users to interrupt long-running operations.
- **Transparent UI Updates**: Ensures all UI changes and cancellations are clearly communicated and reflected in the extension's interface.
- **Transparent AI Reasoning**: The AI's internal thought process is captured and optionally displayed alongside its actions, ensuring reliable and understandable behavior.
- **Seamless State Restoration**: Preserves and restores critical extension states (e.g., pending plans, active AI operations, user preferences) across VS Code restarts for continuity.
- **Accurate API Token Counting**: Precisely measures token consumption for all AI requests.
- **Real-time Token Usage Display**: Provides immediate feedback on token usage and request counts (including failures) directly within the sidebar, optimized for high scannability.
- **Error Handling & Fallbacks**: Implements a layered fallback mechanism for context building (smart context → priority files → minimal) to ensure AI always receives some relevant information.
- **Error and Diff Highlighting**: Highlights errors and code differences in the UI for quick identification and review.

---

## 5. Customization & Personalization

Tailor Minovative Mind to your specific needs and preferences.

### 5.1 API & Model Settings

- **Secure API Key Management**: Facilitates secure setup and storage of the Gemini API key(s). The system supports the secure management and utilization of _multiple_ API keys, allowing users to configure and switch between them as needed.
- **Flexible Model Selection**: Allows users to select preferred Gemini models (`gemini-2.5-pro`, `flash`, `flash-lite` - Thinking Mode) for different tasks, offering control over performance and cost.

### 5.2 Context Filtering

- **Granular Inclusions/Exclusions**: Provides explicit options for users to include or exclude specific files and directories from AI context processing.

### 5.3 Enhanced Chat History Management

- **Persistent Chat & Diff Storage**: Chat conversations, including associated file diffs, can be saved and loaded as JSON for continuity.
- **Session Restoration**: Restores conversation context and file states after VS Code reloads, maintaining workflow consistency.
- **Flexible History Management**: Provides options to clear/reset the entire conversation or delete individual messages.

### 5.4 Persistent UI States

- **UI State Retention**: Retains UI states and settings across VS Code restarts for a seamless user experience.

---

Minovative Mind merges robust software engineering with advanced AI tooling to create a seamless, secure, and efficient development experience inside Visual Studio Code.
