# Minovative Mind User Guide

This guide will help users understand and effectively utilize the AI-powered features integrated into the Minovative Mind VS Code extension.

## Table of Contents

1. Introduction
2. Prerequisites
3. Getting Started (Brief Overview)
4. Core AI Features
   - 4.1 AI Chat Interface
   - 4.2 Code Explanation
   - 4.3 AI Planning & Execution
   - 4.4 Git Commit Generation
   - 4.5 Code Streaming & Modification
5. Tips for Effective AI Usage
6. Conclusion

---

## 1. Introduction

Minovative Mind is an AI-powered VS Code extension designed to assist developers. Its primary goal is to streamline workflows, automate tasks, and provide intelligent insights by leveraging Google Gemini models. This guide focuses on how to effectively utilize its powerful AI capabilities. For the most up-to-date information, features, and community links, visit the official website at [https://minovativemind.dev/](https://minovativemind.dev/).

---

## 2. Prerequisites

To use Minovative Mind's AI features, you will need:

- **Gemini API Key**: A valid Google Gemini API key is essential for AI functionality.
  - **Obtaining the Key**: You can obtain a free API key from [Google AI Studio](https://aistudio.google.com/app/apikey).
  - **Setting the Key**: Input your API key into the sidebar UI via the API Key Management section.

---

## 3. Getting Started (Brief Overview)

For most users, the easiest way to get started is to **install Minovative Mind directly from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=MinovativeTechnologies.minovative-mind-vscode)**.

If you are a developer looking to build from source or contribute, please refer to the [**`CONTRIBUTING.md`**](./CONTRIBUTING.md) guide for local development setup.

**Crucially, ensure your Gemini API key is correctly configured** (see section 2) to enable AI features.

---

## 4. Core AI Features

### 4.1 AI Chat Interface

- **Accessing the Chat**: The AI chat interface is available within the Minovative Mind sidebar. Open it to begin interacting with the AI.
- **Multimodal Input**:
  - You can input text directly into the chat message box.
  - The extension supports image input. Attach images or paste them; they will be processed and sent as Base64 data.
- **Slash Commands**: Enhance your interaction with convenient slash commands:
  - `/fix`: Fast Assistants in debugging and fixing bugs.
  - `/plan`: Initiates AI planning for complex tasks.
  - `/commit`: Generates Git commit messages.
  - `chat` (general): For regular conversational queries about your code.
  - `custom prompt`: Executes custom AI-driven actions or modifications based on specific user prompts. This is a combination of /fix, and /plan, which means you can ask for anything you want from the AI.
- **Contextual Awareness**: The AI intelligently uses context from your current file, selected code snippets, and the broader workspace. You'll often see relevant files listed within AI chat responses.
- **Interpreting AI Responses**: AI responses are rendered with code snippets, markdown, and diffs for clarity. You can easily copy code blocks or use the \"Apply to Editor\" functionality to integrate changes directly.
- **Message Interaction**: Refine AI context or regenerate responses by editing your previous messages.
- **Context Summarization**: For long conversations, the AI automatically summarizes previous discussions to maintain a clear focus on the current task.
- **Organized Sidebar**: The sidebar features **collapsible sections** for "empty chat" placeholders, keeping your workspace clean and focused during inactivity.
- **Token Usage**: A display feature shows current token usage, including request counts and failed requests, optimized for scannability.

### 4.2 Code Explanation

- **Triggering Explanation**: Use the \"Generate Explanation\" command from your editor's context menu (right-click) or execute the `minovative-mind.explainSelection` command.
- **Output Format**: Explanations are presented in a clear VS Code information modal.

### 4.3 AI Planning & Execution

- **Initiating a Plan**:
  - Start a plan by typing `/plan [your request]` in the chat interface.
  - Alternatively, use commands like `/fix` or custom prompts via `Ctrl/Cmd+M` to initiate a plan from the editor in a file.
- **Executing a Plan**:
  - **Confirmation**: By default, you will be prompted to confirm execution.
  - **Skip Confirmation**: Use the "Fast Forward" toggle in the sidebar to bypass this step and execute plans automatically.
  - **Plan Labels**: AI-generated plan explanations are labeled with a "Generated Plan" badge in the chat, so you can easily identify them.
  - Monitor execution progress through VS Code notifications.
  - **Smart Context & Structural Intelligence**: The AI will automatically find and read relevant code snippets for each step of the plan using agentic investigation and symbol intelligence. It prioritizes **structural relationships** (definitions, references) to understand your codebase as a cohesive system rather than just a collection of text files.
- **AI-Driven Integrity Validation**: The system uses a dedicated **Integrity Validator** model (Flash Lite) to perform a final check on modified code. Instead of relying on rigid, error-prone heuristics, this move toward "AI-Trust" ensures that complete file rewrites and complex JSON objects are correctly recognized and applied without unnecessary failures.
- **Reverting Changes**: The "Revert Changes" button, at the top right, allows you to undo AI-driven workflow actions instantly.
- **Autonomous Self-Correction**: For errors introduced during execution, the AI initiates a "Self-Correction" cycle using real-time diagnostic feedback to repair the code autonomously.

### 4.4 Git Commit Generation

- **Triggering Commit**: Use the `/commit` command in the chat interface.
- **Process**: The AI analyzes staged changes and generates a descriptive commit message for your review.

### 4.5 Code Streaming & Surgical Modification

When the AI modifies existing code, it uses a **Collision-Resistant Surgical Search and Replace** system.

The protocol utilizes unique markers (`SEARC#H` / `REPLAC#E` / `===#===`) anchored to line starts to ensure precision, even when the markers themselves are mentioned in your source code documentation or discussions.

- **Live Generation**: Code streams directly into the editor with real-time status updates ("Analyzing structure", "Applying code...").
- **Smart Visual Flash**: Newly added or modified code is highlighted with a full-width green flash effect. This highlight tracks with your code as you edit around it and intelligently removes itself only when you modify or delete the flashed lines.
- **Narrative Change Summaries**: The chat interface now provides polished, single-sentence descriptions for every automated modification. These "Narrative Summaries" explain the _why_ and _how_ of a change in plain English.
- **Precision Change Summaries**: Through AI-powered entity extraction (`ENTITY_EXTRACTION_TOOL`), the system accurately identifies exactly which functions, classes, and variables were modified. These details are reflected in technical diff summaries and commit messages, providing highly actionable feedback during your development cycle.
- **AI-Driven Retries**: If a surgical update fails to parse correctly, the system automatically triggers an autonomous retry with clarification context, ensuring a high success rate for complex modifications.

- **Live Generation**: Code generated for `create_file` and `modify_file` steps streams directly into the editor, providing immediate visual feedback.
- **Smart Visual Flash**: Newly added or modified code is highlighted with a full-width green flash effect. This highlight tracks with your code as you edit around it and intelligently removes itself only when you modify or delete the flashed lines.
- **Applying Changes**: AI modifications are applied to your editor, often involving diff analysis and intelligent application of changes.
- **Real-time Status**:
  - **Active Step Monitoring**: The currently executing step is highlighted in your sidebar. You can see live status updates (e.g., "Designing change", "Applying code...") and even **auto-retry progress** (e.g., `(Auto-retry 1/3)`) if the AI encounters transient issues.
  - **Visual Feedback**:
    - **✓ (Success)**: Indicates a file was successfully generated or modified.
    - **⚠️ (Warning)**: Indicates a step encountered an issue but might be retrying or requires attention.
    - **Error (Red Text)**: Indicates a step has failed and requires manual intervention or self-correction.
- **Active Exploration**: For complex queries, the **Context Agent** will automatically spring into action. It "investigates" your codebase by running safe terminal commands (`git ls-files`, `grep`, `find`, `sed`, `head`) to find relevant files that static analysis might miss. It prioritizes a **Relationship-First strategy**, following the "structural graph" of your code (calling functions, checking types) to ensure absolute precision. All search commands are automatically filtered to respect `.gitignore` rules and exclude build artifacts, dependencies, and binary files.
- **Transparent Logs**: You'll see "Context Agent" logs in the chat showing exactly what commands are being run (e.g., `grep -r "auth" src/`) and what they returned.
- **Progressive Discovery**: In large projects, the Context Agent uses a "Progressive Discovery" strategy, starting with a truncated view of your project structure and discovering files on-the-fly to save tokens and improve performance.
- **Error Awareness**: If you ask about an error or bug, the Context Agent automatically enters "Investigation Mode" to hunt down the root cause using the error message and real-time diagnostics.

---

## 5. Tips for Effective AI Usage

- **Be Specific with Prompts**: Provide clear, detailed prompts with sufficient context for the best results.
- **Leverage Context**: Utilize relevant commands (`/plan`, `/fix`) and select code snippets when appropriate to give the AI more context.
- **Iterative Refinement**: If an AI response isn't perfect, refine your prompts or edit your previous chat messages for better outcomes.
- **Review AI Output**: Always review AI-generated code and plans before execution, especially for critical or complex tasks.
- **Utilize Multimodality**: Don't hesitate to upload images when visual context can help the AI understand your requirements better.

---

## 6. Conclusion

Minovative Mind's AI features are designed to boost your productivity and streamline your development workflow. Explore its capabilities, experiment with different prompts, and discover how AI can enhance your coding experience. We encourage your feedback to help us improve!

### 5.2 Optimization Settings

- **Always Run Investigation**: By default, the Context Agent investigates when needed. You can force it to _always_ investigate by setting `"optimization.alwaysRunInvestigation": true` in your VS Code settings. This skips static file summaries and relies entirely on active exploration, which can be faster and save tokens for large projects.
