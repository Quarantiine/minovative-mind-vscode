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

Minovative Mind is an AI-powered VS Code extension designed to assist developers. Its primary goal is to streamline workflows, automate tasks, and provide intelligent insights by leveraging Google Gemini models. This guide focuses on how to effectively utilize its powerful AI capabilities.

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
- **Token Usage**: A display feature shows current token usage, which can be toggled for visibility.

### 4.2 Code Explanation

- **Triggering Explanation**: Use the \"Generate Explanation\" command from your editor's context menu (right-click) or execute the `minovative-mind.explainSelection` command.
- **Output Format**: Explanations are presented in a clear VS Code information modal.

### 4.3 AI Planning & Execution

- **Initiating a Plan**:
  - Start a plan by typing `/plan [your request]` in the chat interface.
  - Alternatively, use commands like `/fix` or custom prompts via `Ctrl/Cmd+M` to initiate a plan from the editor in a file.
- **Executing a Plan**:
  - You will be prompted for confirmation before the AI executes a generated plan.
  - Monitor execution progress through VS Code notifications.
  - **Smart Context**: The AI will automatically find and read relevant code snippets for each step of the plan, ensuring it has the full picture before writing code.
  - Plans can be cancelled if needed during execution.
- **Reverting Changes**: The \"Revert Changes\" button, at the top right, allows you to undo AI-driven workflow actions if necessary.

### 4.4 Git Commit Generation

- **Triggering Commit**: Use the `/commit` command in the chat interface.
- **Process**: The AI analyzes your staged changes, generates a commit message, and prompts you for review and edits before committing.

### 4.5 Code Streaming & Modification

- **Live Generation**: Code generated for `create_file` and `modify_file` steps streams directly into the editor, providing immediate visual feedback.
- **Applying Changes**: AI modifications are applied to your editor, often involving diff analysis and intelligent application of changes.

### 4.6 Context Agent Investigation

- **Active Exploration**: For complex queries, the **Context Agent** will automatically spring into action. It "investigates" your codebase by running safe terminal commands (`ls`, `grep`, `find`) to find relevant files that static analysis might miss.
- **Transparent Logs**: You'll see "Context Agent" logs in the chat showing exactly what commands are being run (e.g., `grep -r "auth" .`) and what they returned.
- **Error Awareness**: If you ask about an error or bug, the Context Agent automatically enters "Investigation Mode" to hunt down the root cause using the error message.

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
