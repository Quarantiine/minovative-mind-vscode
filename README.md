# Minovative Mind (Free AI Agent)

Turn your ideas into software—just describe it in natural language, and this world-class extension builds it for you.

Minovative Mind is a powerful, open-source AI agent for Visual Studio Code that integrates Google's Gemini models directly into your workflow. It plans, writes code, fixes bugs, and automates mundane tasks, all while running locally on your machine with your own API key.

[Official Website: minovativemind.dev](https://minovativemind.dev/)

[![Installs](https://img.shields.io/visual-studio-marketplace/i/MinovativeTechnologies.minovative-mind-vscode)](https://marketplace.visualstudio.com/items?itemName=MinovativeTechnologies.minovative-mind-vscode)
[![Version](https://img.shields.io/visual-studio-marketplace/v/MinovativeTechnologies.minovative-mind-vscode)](https://marketplace.visualstudio.com/items?itemName=MinovativeTechnologies.minovative-mind-vscode)
[![License](https://img.shields.io/github/license/Minovative-Technologies/minovative-mind-vscode)](https://github.com/Quarantiine/minovative-mind-vscode/blob/main/LICENSE.md)

---

## 🚀 Key Features

- **🤖 Autonomous Planning & Execution**: Give it a high-level goal (e.g., "Create a login form"), and it generates a plan, creates files, writes code, and **self-corrects** any issues. Uses a strict **`/plan` command enforcement** for structural modifications to ensure safety and precision. Includes **Output Integrity Validation** to ensure generated code snippets are complete and correctly formatted.
- **💬 Intelligent Chat**: Context-aware chat that understands your entire workspace. Text and image support (Multimodal).
- **🛠️ Auto-Fix & Debug**: `/fix` command to analyze errors and auto-repair code issues.
- **📝 Documentation & Cleanup**: `/docs` command to add comprehensive docs and remove clutter.
- **🔎 Context Agent**: Actively investigates your codebase using terminal commands and specialized tools (`get_implementations`, `get_call_hierarchy`, `grep`, `find`, `read_file`) with automatic `.gitignore`-aware filtering.
- **💾 Git Automation**: `/commit` generates descriptive commit messages based on your changes.
- **🛡️ Safe & Private**: Runs locally using **Gemini Flash Lite**. Features decoupled context management for real-time synchronization and AI output sanitization to prevent agent control leaks.

[View Full Capabilities](./CAPABILITIES.md)

---

## ⚡ Quick Start

### 1. Install from VS Code Marketplace

Search for **"Minovative Mind"** in the VS Code Extensions view (`Cmd+Shift+X`) and install it.

[**Marketplace Link**](https://marketplace.visualstudio.com/items?itemName=MinovativeTechnologies.minovative-mind)

### 2. Get Your Free Gemini API Key

Minovative Mind uses Google's Gemini models. You need your own API key (it's free!).

1.  Go to [Google AI Studio](https://aistudio.google.com/app/apikey).
2.  Create a new API key.

### 3. Configure the Extension

1.  Open the **Minovative Mind** sidebar in VS Code (click the icon in the Activity Bar).
2.  Scroll down to the **API Key Management** section.
3.  Paste your API key and click **Save**.

**That's it! You're ready to code.**

---

## 📚 Documentation

- **[Official Website](https://minovativemind.dev/)**: Central hub for Minovative Mind, featuring the latest updates and platform overview.
- **[User Guide](./USER_GUIDE.md)**: Detailed instructions on how to use all features.
- **[Capabilities](./CAPABILITIES.md)**: In-depth breakdown of what the agent can do.
- **[Architecture](./ARCHITECTURE.md)**: How it works under the hood.
- **[Contributing](./CONTRIBUTING.md)**: How to build from source or contribute to the project.
- **[Privacy Policy](./PRIVACY_POLICY.md)** & **[Terms of Use](./TERMS_OF_USE.md)**

---

## 🤝 Contributing & Community

Minovative Mind is open source! We welcome contributions, whether it's fixing bugs, adding features, or improving documentation.

- **Build from Source**: See [CONTRIBUTING.md](./CONTRIBUTING.md#local-development-setup) for local setup instructions.
- **Support**: Star us on [GitHub](https://github.com/Minovative-Technologies/minovative-mind) to show your support!

---

> _This project makes API calls directly from your VS Code environment using your own Gemini API key. No data is stored, processed, or transmitted by third parties beyond Google’s API._
