# Minovative Mind System Architecture

This diagram illustrates the high-level architecture of the Minovative Mind VS Code extension, divided into 7 core systems as described in `ARCHITECTURE.md`.

```mermaid
graph TB
    %% Core Styling
    classDef context fill:#e1f5fe,stroke:#01579b,stroke-width:2px;
    classDef ai fill:#f3e5f5,stroke:#4a148c,stroke-width:2px;
    classDef history fill:#e8f5e9,stroke:#1b5e20,stroke-width:2px;
    classDef codegen fill:#fff3e0,stroke:#e65100,stroke-width:2px;
    classDef plan fill:#fff8e1,stroke:#fbc02d,stroke-width:2px;
    classDef ui fill:#fce4ec,stroke:#880e4f,stroke-width:2px;
    classDef utils fill:#eceff1,stroke:#37474f,stroke-width:2px;

    %% ---------------------------------------------------------
    %% 6. User Interface & Interactive Chat Systems
    %% ---------------------------------------------------------
    subgraph UI_System [User Interface & Interactive Chat]
        direction TB
        SidebarProvider[SidebarProvider]
        Webview[Webview (React/HTML)]
        MsgHandler[WebviewMessageHandler]
        MsgSender[MessageSender]
        ChatRenderer[ChatMessageRenderer]

        Webview <--> MsgSender
        MsgSender --> MsgHandler
        MsgHandler --> SidebarProvider
        SidebarProvider --> ChatRenderer
        ChatRenderer --> Webview
    end
    class UI_System ui

    %% ---------------------------------------------------------
    %% 3. Chat History Context Management
    %% ---------------------------------------------------------
    subgraph History_System [Chat History Context Management]
        direction TB
        ChatHistoryMgr[ChatHistoryManager]
        ChatService[ChatService]
        Storage[VS Code Storage]

        ChatHistoryMgr <--> Storage
        ChatService --> ChatHistoryMgr
    end
    class History_System history

    %% ---------------------------------------------------------
    %% 1. Context Management (Project Understanding)
    %% ---------------------------------------------------------
    subgraph Context_System [Context Management]
        direction TB
        WorkspaceScanner[Workspace Scanner]
        SymbolService[Symbol Service]
        DiagnosticSvc[Diagnostic Service]
        ProjectType[Project Type Detector]
        SmartContext[Smart Context Selector]
        AgenticInvest[Agentic Context Investigation]
        UrlService[URL Context Service]

        WorkspaceScanner --> SmartContext
        SymbolService --> SmartContext
        DiagnosticSvc --> SmartContext
        ProjectType --> SmartContext
        AgenticInvest --> SmartContext
        UrlService --> SmartContext
    end
    class Context_System context

    %% ---------------------------------------------------------
    %% 2. AI Services (Core AI Interaction)
    %% ---------------------------------------------------------
    subgraph AI_Core [AI Services]
        direction TB
        GeminiClient[Gemini Client]
        AIRequestSvc[AI Request Orchestration]
        TokenTracker[Token Usage Tracking]
        PromptMgr[Prompt Management]
        CodeValidator[AI Code Quality Assurance]

        AIRequestSvc --> GeminiClient
        AIRequestSvc --> TokenTracker
        AIRequestSvc --> PromptMgr
        GeminiClient --> ExternalAI[Google Gemini API]
    end
    class AI_Core ai

    %% ---------------------------------------------------------
    %% 4. Code Generation & Modification
    %% ---------------------------------------------------------
    subgraph CodeGen_System [Code Generation & Modification]
        direction TB
        EnhCodeGen[Enhanced Code Generator]
        CodeAnalysis[Code Analysis Utils]
        DiffUtils[Diffing Utils]

        EnhCodeGen --> CodeAnalysis
        EnhCodeGen --> DiffUtils
        EnhCodeGen --> CodeValidator
    end
    class CodeGen_System codegen

    %% ---------------------------------------------------------
    %% 5. Plan & Workflow Management
    %% ---------------------------------------------------------
    subgraph Plan_System [Plan & Workflow Management]
        direction TB
        PlanService[Plan Service]
        WorkflowPlanner[Workflow Planner]
        PlanExecutor[Plan Executor Service]
        ChangeLogger[Project Change Logger]
        RevertSvc[Revert Service]

        PlanService --> WorkflowPlanner
        PlanService --> PlanExecutor
        PlanExecutor --> ChangeLogger
        RevertSvc --> ChangeLogger
        PlanExecutor --> EnhCodeGen
    end
    class Plan_System plan

    %% ---------------------------------------------------------
    %% 7. Supporting Services & Utilities
    %% ---------------------------------------------------------
    subgraph Support_System [Supporting Services]
        direction TB
        GitSvc[Git Integration]
        CmdExec[Command Execution Utility]
        ParallelProc[Concurrency Management]
        CodeSelect[Code Selection Utils]
    end
    class Support_System utils

    %% ---------------------------------------------------------
    %% Cross-System Interactions
    %% ---------------------------------------------------------

    %% UI to History & Chat
    SidebarProvider --> ChatHistoryMgr
    SidebarProvider --> ChatService

    %% Chat Service to AI & Context
    ChatService --> SmartContext
    ChatService --> AIRequestSvc

    %% Context Agents to Command Exec
    AgenticInvest --> CmdExec

    %% Plan System to AI & Context
    PlanService --> AIRequestSvc
    PlanExecutor --> AgenticInvest
    PlanExecutor --> CmdExec

    %% Code Gen to AI
    EnhCodeGen --> AIRequestSvc

    %% AI to Code Gen (Validation)
    CodeValidator --> DiagnosticSvc

    %% Context to Utils
    SmartContext --> CodeSelect
    SmartContext --> ParallelProc
```

## System Descriptions

1.  **User Interface**: Handles webview rendering, user input, and state management.
2.  **Chat History**: Manages persistence and restoration of chat sessions.
3.  **Context Management**: Scans workspace, detects project type, gathers context via Agentic investigation and symbol intelligence.
4.  **AI Services**: Orchestrates requests to Gemini, handles tokens, and manages prompts.
5.  **Code Generation**: Handles creation and modification of files with validation.
6.  **Plan & Workflow**: Manages multi-step plans, execution, logging, and reverting changes.
7.  **Supporting Services**: Utilities for git, command execution, and concurrency.
