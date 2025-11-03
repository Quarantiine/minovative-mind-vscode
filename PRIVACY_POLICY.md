# Privacy Policy for Minovative Mind VS Code Extension

## Last Updated: September 15, 2025

## 1. Introduction

The Minovative Mind VS Code extension ("Minovative Mind") is a powerful AI coding agent designed to assist developers directly within Visual Studio Code. This Privacy Policy explains how Minovative Technologies DBA ("we," "us," or "our") processes and protects information when you use our extension, emphasizing local processing and user control.

## 2. Data Controller

Minovative Technologies DBA, based in USA (publisher: MinovativeTechnologies) is the data controller responsible for your information in the context of this extension.

## 3. Information We Process

We believe in transparency regarding the information we handle. The Minovative Mind extension operates with a strong emphasis on user privacy and local processing.

### 3.1 User-Provided Data

When you use the Minovative Mind extension, you explicitly provide various forms of input:

- **Text Prompts**: Your natural language instructions, queries, and commands (e.g., `/plan`, `/fix`, `/commit`, `/merge`).
- **Image Uploads**: Images you upload to the chat interface are processed as Base64 data for multimodal interactions.
- **Selected Code**: Specific code snippets or entire active editor files you select for AI analysis, modification, or explanation.
- **URLs**: URLs provided in your prompts, from which the extension fetches and processes content to enhance context.
- **API Key**: Your Google Gemini API key, which you provide and is stored securely locally.

### 3.2 Workspace & Project Data (Local Processing)

The extension processes data from your local VS Code workspace to provide context-aware assistance. This data remains on your local machine and is never sent to Minovative Technologies DBA' servers. It is only transmitted to the Google Gemini API as part of your explicit AI requests. This includes:

- **Workspace Files**: Content of files within your local workspace, respecting `.gitignore` rules and configurable inclusion/exclusion settings.
- **Active Editor Content**: The content of the file currently open in your VS Code editor.
- **VS Code Diagnostics**: Real-time error, warning, and informational messages from your codebase.
- **Code Structure Information**: Document symbols (functions, classes, types), code references, and workspace-wide dependency graphs derived from your codebase.
- **Git Changes**: Staged and unstaged changes in your Git repository, particularly for generating commit messages or resolving conflicts.
- **File Structure Analysis**: Information about file organization used to make contextually aware modifications.

### 3.3 AI-Generated Data

In response to your inputs, the extension generates various data locally:

- **Code**: New code snippets, refactored code, or modifications to existing files.
- **Execution Plans**: Structured, multi-step plans generated to achieve your high-level objectives.
- **Diffs**: Summaries of changes applied to files.
- **Commit Messages**: AI-generated Git commit messages.
- **Explanations**: Explanations of selected code.

### 3.4 Usage Data (Limited & Local)

The Minovative Mind extension does not collect any analytics or personal usage data from you beyond the information explicitly sent to the Google Gemini API for its core functionality, or what VS Code itself collects.

- **Token Consumption Statistics**: The extension precisely measures token consumption for all AI requests. These statistics are tracked locally and displayed within the extension's UI for your transparency and cost monitoring. This data is not transmitted to Minovative Technologies DBA' servers.

## 4. How Information is Used

The information processed by the Minovative Mind extension is used solely to deliver its core functionality and enhance your development workflow:

### 4.1 To Deliver Core Functionality

- **Interactive AI Experiences**: To facilitate multimodal chat, generate code, explain selected code, and provide context-aware Q&A.
- **Autonomous Workflows**: To generate, execute, and monitor multi-step plans that involve creating, modifying, and deleting files, and running shell commands.
- **Automated Git Operations**: To analyze staged changes for generating insightful Git commit messages and to assist in resolving Git merge conflicts.

### 4.2 For Contextual Understanding & Relevance

- To build a deep and accurate understanding of your project's codebase, including its structure, symbols, and dependencies.
- To leverage all available context (user input, active editor, workspace files, diagnostics, URLs) to provide highly relevant, accurate, and high-quality AI responses and modifications.

### 4.3 For Performance & Transparency

- For estimating and tracking API token usage in real-time, allowing you to monitor your consumption and control costs.
- To provide real-time progress indicators and notifications on ongoing AI tasks.
- For logging and auditing all file system changes made by AI-driven workflows, ensuring transparency and accountability.

## 5. AI Model Interaction & Data Sharing

### 5.1 Interaction with Google Gemini API

When you interact with the Minovative Mind extension, your inputs (prompts, selected code context, processed images as Base64 data, summaries of workspace snippets, and parsed URL content) are securely transmitted to the Google Gemini API for processing.

- **Data Handling**: This data is handled according to Google's own terms and policies. We encourage you to review Google's Generative AI Additional Terms and Privacy Policy for detailed information.
- **Model Training**: As per Google's policies, data submitted to the Google Gemini API is not used to train Google's models without your explicit opt-in.
- **Data Caching**: Input and output data may be cached by Google for up to 24 hours by default to improve user experience and diagnostics, unless data caching is disabled at the project level by you through Google Cloud settings.

### 5.2 No Third-Party Sharing by Minovative Technologies DBA

Minovative Technologies DBA does not share your personal data or usage information with any other third parties beyond the necessary transmission to the Google Gemini API for the extension's core service functionality.

## 6. Data Storage and Security

### 6.1 Local Processing & Storage

- **Client-Side Operation**: The Minovative Mind extension operates entirely client-side within your VS Code environment. It does not utilize any external backend servers operated by Minovative Technologies DBA for storing or processing your data.
- **Local Data Storage**: Chat history, generated file diffs, persistent UI states, active AI operation states, and certain extension preferences are stored locally within your VS Code workspace state or user settings, residing solely on your machine. This data is not transferred to external servers controlled by Minovative Technologies DBA.

### 6.2 API Key Security

- Your Google Gemini API key is managed exclusively by VS Code's secure SecretStorage API. This mechanism ensures that your API key is encrypted and stored securely, isolated from other extension data.
- Minovative Technologies DBA does not access, store, or transmit your API key on any external servers.

### 6.3 Workspace-Bound Operations

- **Data Confinement**: All file system modifications (creation, modification, deletion of files/directories) performed by AI-driven workflows are strictly confined to your active VS Code workspace directory. This prevents unintended changes outside the project scope and ensures your project's integrity.

### 6.4 Explicit Approvals for Commands

- **Shell Command Approval**: For enhanced security and control, any `run_command` step within an AI-generated plan requires explicit user confirmation before execution. You are prompted to allow, skip, or cancel individual command execution steps, giving you full oversight of potentially impactful operations.

## 7. User Control and Transparency

Minovative Mind prioritizes user control, project security, and transparent operation, providing you with several mechanisms to manage your data and interactions:

### 7.1 Data Input & Context Filtering

- **Explicit Input**: You retain full control over what data (text prompts, code selections, image uploads, URLs) you explicitly send to the AI for processing.
- **Granular Context Filtering**: The extension offers explicit options to include or exclude specific files and directories from AI context processing, allowing you to fine-tune the information shared with the AI.

### 7.2 Reversible Changes & Auditing

- **Project Change Logging**: The extension accurately tracks all file system changes (additions, modifications, deletions) made by AI-driven workflows.
- **Revertible AI Plans**: Every file system operation performed by the AI is logged, allowing you to easily review and revert entire operations with a dedicated "Revert" button. This enables safe experimentation and ensures you can undo any unwanted changes.
- **Auditable Change Log**: A detailed log of all AI-driven changes is maintained locally for transparency and auditing purposes.

### 7.3 Operational Control

- **Cancellable Tasks**: You can interrupt most AI-driven tasks and long-running operations via a `CancellationToken`, providing immediate control over active processes.
- **Editable History**: You can edit your previous chat messages to re-evaluate conversations with updated context.
- **Commit Message Review**: AI-generated Git commit messages are presented for your review and editing before being applied.
- **Model Selection**: You have the flexibility to select preferred Google Gemini models for different tasks, offering control over performance, cost, and specific AI capabilities.
- **Chat History Management**: You can clear or reset your entire chat conversation or delete individual messages.

### 7.4 Transparency

- **Real-time Progress Indicators**: The extension provides constant, visible feedback on ongoing AI tasks through VS Code notifications.
- **Real-time Token Usage**: Immediate feedback on token consumption is displayed directly within the sidebar, ensuring transparency into API usage.

## 8. Children's Privacy

The Minovative Mind extension is not intended for use by individuals under the age of 13. We do not knowingly collect personal information from children under 13.

## 9. Changes to This Privacy Policy

We may update this Privacy Policy from time to time to reflect changes in our practices or legal requirements. Any changes will be posted on our GitHub repository [https://github.com/Minovative-Technologies/minovative-mind](https://github.com/Minovative-Technologies/minovative-mind) and potentially announced via the VS Code Marketplace. Your continued use of the extension after any changes signifies your acceptance of the updated policy.

## 10. Contact Us

If you have any questions or concerns regarding this Privacy Policy or our data practices, please open an issue on our GitHub repository [https://github.com/Minovative-Technologies/minovative-mind/issues](https://github.com/Minovative-Technologies/minovative-mind/issues) or use the security reporting form: [https://forms.gle/QexZY2resdXpahUK6](https://forms.gle/QexZY2resdXpahUK6).
