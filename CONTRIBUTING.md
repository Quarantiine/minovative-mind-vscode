# Contributing to Minovative Mind

First off, thank you for your interest in Minovative Mind! This project is built on the belief that the future of development is collaborative—both between humans and AI, and within the open-source community.

Your creativity and ingenuity are the most valuable assets to this ecosystem.

## My Contribution Philosophy

Minovative Mind is both a powerful tool and an extensible AI Agent. Because of this, "contributing" can take two primary forms. One is highly valued for me.

### Path 1: Building on the Platform (Most Encouraged)

This is the core of my vision. The [Creator](https://github.com/Quarantiine) built Minovative Mind to be a launchpad for my own ideas, but we decided to make it completely free for all developers to use and build upon. We strongly encourage you all to clone/fork the repository and use it as a foundation to create your own unique solutions, AI agents, or anything else that captures your mind.

**Your exploration, modification, and extension of this project is a primary and celebrated form of contribution.**

If you build something amazing, share it with the community on the offical Discord:
[Minovative Mind Discord](https://discord.gg/KFkMgAH3EG), or share it on social media.

### Path 2: Improving the Core Project

Contributors to this repository play a vital role in advancing the Minovative Mind AI agent for the benefit of all developers. To maintain the project's quality and integrity, a review process will be conducted to evaluate and approve individuals seeking to contribute to this project.

#### Becoming a Core Contributor

We will be looking for dedicated community members to join the core development team and help shape the future of Minovative Mind.

**This process is for developers who wish to gain write access (commit rights)** to the main Minovative Mind repository.

- IMPORTANT: **If you're cloning or forking this project for your own use and innovation, This does not pertain to you**. We warmly encourage you to explore, build, and create as freely and imaginatively as you like!

---

#### Step 1: To Become a Contributor

Before you can build the house, you must know the foundation. A prospective core contributor must first demonstrate a deep understanding of the project and a commitment to its community.

**Prerequisites:**

- **Technical Proficiency:** You should be highly proficient in HTML, CSS, and **TypeScript** mostly and have a strong and solid understanding of the **VS Code Extension API** and understand how to use the AI Agent at a high level (e.g. Minovative Mind).
- **Architectural Knowledge:** You must have read and understood the [**`ARCHITECTURE.md`**](./ARCHITECTURE.md) document. You should be able to discuss the core systems and the responsibilities of the areas your want to work own.
- **Active Community Participation:** Be an active and helpful member of our community. This includes:
  - Helping other users with their questions in GitHub Issues or on our Discord server.
  - Submitting high-quality, detailed bug reports. A great bug report includes logs, replication steps, and even initial analysis of the potential cause.

> Fill out this form: [Minovative Mind - Core Contributor Application](https://forms.gle/5GiZ7EooEGdei9939)

#### Step 2: The Invitation

After a developer has consistently demonstrated the qualities above over a period of time, the existing maintainer(s) will formally invite you to become a core contributor. This invitation is a recognition of your proven skill, your commitment to the project's success, and the trust you have earned from the maintainer(s).

### Improving the Core Project as a Accepted Contributor

#### Step 1: Demonstrate Your Skill with High-Quality Contributions to Keep Write Permissions

Trust is earned through action. The next step is to make tangible contributions that improve the core project.

**Contribution Requirements:**

- **Solve Existing Issues:** Submit at least **2 high-quality Pull Requests** that successfully close existing issues from our tracker.
- **Write Clean, Maintainable Code:** Your submitted code must align with the project's existing style, structure, functionality, and quality standards. It should be well-documented, with comments explaining complex logic. Use AI to help you.
- **Write or Improve Tests:** Contributions that include adding or improving unit or integration tests are highly valued, as they demonstrate a commitment to long-term stability.
- **Improve the Documentation:** A PR that significantly clarifies or expands our documentation (`README.md`, `ARCHITECTURE.md`, or code comments) is a fantastic contribution. It proves you understand the project well enough to explain it to others.

#### Step 2: Participate in Code Reviews & Architectural Discussions

A core contributor doesn't just write code—they are a steward of the project's quality. This means helping review the work of others and participating in strategic discussions.

**Stewardship Requirements:**

- **Provide Constructive Code Reviews:** Actively and helpfully review Pull Requests submitted by other developers. Your feedback should be constructive, respectful, and aimed at improving code quality.
- **Engage in Technical Discussions:** Participate in the discussion on new feature proposals or bug reports. Your input should demonstrate architectural thinking and a clear understanding of the project's trade-offs.

This structured process ensures that the project remains stable and high-quality while creating a clear, fair, and transparent path for dedicated community members to take on a leadership role.

## Local Development Setup

Ready to dive in? Setting up your local environment is simple.

1. **Fork & Clone the Repository:**

   ```bash
   git clone https://github.com/Minovative-Technologies/minovative-mind.git minovative-mind-vscode
   cd minovative-mind-vscode
   ```

2. **Install Dependencies:**
   This project uses `npm` for package management.

   ```bash
   npm install
   ```

3. **Compile & Watch for Changes:**
   To build the project and have it recompile automatically as you make changes:

   ```bash
   npm run compile
   ```

4. **Run in Debug Mode:**
   - Open the project folder in VS Code.
   - Press `F5` to open a new Extension Development Host window.
   - This new window will have your development version of Minovative Mind installed and ready for testing.

## Submitting a Pull Request

To ensure a smooth process for core contributions, please follow these steps:

1. **Create an Issue:** Before starting significant work, please open an issue to discuss the proposed change. This helps us align on the solution.
2. **Create a New Branch:** Create a feature branch from `main` for your work. (`git checkout -b feature/my-new-feature`)
3. **Write Clean Code:** Follow the existing code style and structure. Use AI if you have to, to make sure it always follow the existing structure.
4. **Test Your Changes:** Ensure your changes work as expected in the debug environment.
5. **Submit the PR:** Push your branch to your fork and open a Pull Request against the `main` branch of the original repository. Please provide a clear description of the changes.

## Architectural Deep Dive

To understand the core systems and how they interact, please see our detailed [**`ARCHITECTURE.md`**](./ARCHITECTURE.md) document. It's the perfect guide for anyone looking to modify or extend the agent's capabilities.

---

> Remember, Minovative Mind is designed to assist, not replace, the brilliance of human developers! Happy Coding!
