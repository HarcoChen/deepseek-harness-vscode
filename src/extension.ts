import * as vscode from "vscode";
import {
    AgentStatusPresentationRegistry,
    DshExtensionApi,
} from "./agentStatusPresentation";
import { DeepSeekBalanceService } from "./balanceService";
import { ChatViewProvider, QuickTaskKind } from "./chatView";
import {
    ConversationNavigationProvider,
    ConversationNavigationRegistry,
} from "./conversationNavigation";
import { ContextStore } from "./contextStore";
import { DebugContextTracker } from "./debugContext";
import { DshRuntime } from "./dshRuntime";
import { configureLocalization, t } from "./localize";
import { TracePanelManager } from "./tracePanel";
import { parseTraceLocation } from "./traceProtocol";
import { TerminalContextStore } from "./terminalContext";

let shutdownRuntime: (() => Promise<void>) | undefined;

export function activate(context: vscode.ExtensionContext): DshExtensionApi {
    configureLocalization((message, args) => vscode.l10n.t(message, args));
    const rawOutput = vscode.window.createOutputChannel("DeepSeek Harness");
    let outputDisposed = false;
    // A cancelled download or late stream callback may finish after shutdown.
    // Keep diagnostics alive through cleanup and ignore writes after disposal.
    const output = new Proxy(rawOutput, {
        get(target, property) {
            if (property === "append" || property === "appendLine") {
                return (value: string): void => { if (!outputDisposed) target[property](value); };
            }
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
    const runtime = new DshRuntime(output, context.globalStorageUri.fsPath);
    let shutdown: Promise<void> | undefined;
    const stopRuntime = (): Promise<void> => shutdown ??= runtime.dispose().finally(() => {
        outputDisposed = true;
        rawOutput.dispose();
    });
    shutdownRuntime = stopRuntime;
    const balanceService = new DeepSeekBalanceService(context, output);
    const terminalContext = new TerminalContextStore();
    const debugContextTracker = new DebugContextTracker();
    const contextStore = new ContextStore(debugContextTracker);
    const agentStatusPresentations = new AgentStatusPresentationRegistry();
    const conversationNavigationRegistry = new ConversationNavigationRegistry();
    const chatView = new ChatViewProvider(
        context,
        context.extensionUri,
        runtime,
        contextStore,
        terminalContext,
        output,
        balanceService,
        agentStatusPresentations,
    );
    const tracePanels = new TracePanelManager(
        runtime,
        output,
        workspaceRoot,
        context.extensionUri,
    );
    const conversationNavigation = new ConversationNavigationProvider(
        runtime,
        chatView,
        conversationNavigationRegistry,
    );

    context.subscriptions.push(
        balanceService,
        terminalContext,
        debugContextTracker,
        agentStatusPresentations,
        conversationNavigationRegistry,
        chatView,
        tracePanels,
        conversationNavigation,
        new vscode.Disposable(() => {
            void stopRuntime().catch(error => console.error("DSH Runtime cleanup failed", error));
        }),
        vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatView, {
            webviewOptions: {
                retainContextWhenHidden: true,
            },
        }),
        vscode.window.registerTreeDataProvider(
            "dsh.conversationNavigation",
            conversationNavigation,
        ),
        vscode.commands.registerCommand("dsh.revealConversationMilestone", (seq?: unknown) => {
            if (typeof seq === "number") chatView.revealConversationMilestone(seq);
        }),
        registerChatParticipant(chatView, context.extensionUri),
        vscode.window.registerWebviewPanelSerializer(TracePanelManager.viewType, tracePanels),
        vscode.commands.registerCommand("dsh.open", () => chatView.reveal()),
        vscode.commands.registerCommand("dsh.openTrace", async (value?: unknown) => {
            try {
                const supplied = value === undefined ? undefined : parseTraceLocation(value);
                if (value !== undefined && !supplied) {
                    throw new Error(t("Invalid Trace location."));
                }
                const sessionId = supplied?.sessionId ?? chatView.getCurrentSessionId();
                if (!sessionId) throw new Error(t("There is no current session to open."));
                await tracePanels.open(supplied ?? { sessionId });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                void vscode.window.showErrorMessage(t("DSH: Failed to open Trace: {message}", { message }));
            }
        }),
        vscode.commands.registerCommand("dsh.newSession", () =>
            runCommand(t("Create session"), () => chatView.newSession()),
        ),
        vscode.commands.registerCommand("dsh.switchSession", () =>
            runCommand(t("Switch session"), () => chatView.chooseSession()),
        ),
        vscode.commands.registerCommand("dsh.searchSession", () =>
            runCommand(t("Search sessions"), () => chatView.searchSession()),
        ),
        vscode.commands.registerCommand("dsh.selectModel", () =>
            runCommand(t("Select model"), () => chatView.selectModel()),
        ),
        vscode.commands.registerCommand("dsh.renameSession", () =>
            runCommand(t("Rename session"), () => chatView.renameSession()),
        ),
        vscode.commands.registerCommand("dsh.forkSession", () =>
            runCommand(t("Fork session"), () => chatView.forkSession()),
        ),
        vscode.commands.registerCommand("dsh.archiveSession", () =>
            runCommand(t("Archive session"), () => chatView.archiveSession()),
        ),
        vscode.commands.registerCommand("dsh.start", async () => {
            await runCommand(t("Start dsh web"), async () => {
                await runtime.start(workspaceRoot());
                chatView.reveal();
            });
        }),
        vscode.commands.registerCommand("dsh.stop", async () => {
            await runCommand(t("Stop dsh web"), () => runtime.stop());
        }),
        vscode.commands.registerCommand("dsh.restart", async () => {
            await runCommand(t("Restart dsh web"), async () => {
                await runtime.restart(workspaceRoot());
                chatView.reveal();
            });
        }),
        vscode.commands.registerCommand("dsh.openLogs", () => output.show(true)),
        vscode.commands.registerCommand("dsh.recovery.cancel", () => {
            runtime.cancelRecovery();
        }),
        vscode.commands.registerCommand("dsh.recovery.openDiagnostics", () => output.show(true)),
        vscode.commands.registerCommand("dsh.recovery.exportDiagnostics", async () => {
            await runCommand(t("Export recovery diagnostics"), async () => {
                const path = await runtime.exportRecoveryDiagnostics();
                await vscode.env.clipboard.writeText(path);
                void vscode.window.showInformationMessage(t("DSH recovery diagnostics exported to {path}.", { path }));
            });
        }),
        vscode.commands.registerCommand("dsh.recovery.restore", async () => {
            // Ask outside runCommand: returning from inside its callback completes
            // normally and would report a successful restore that never happened.
            const answer = await vscode.window.showWarningMessage(
                t("Restore the automatic DSH recovery changes? The Runtime must be stopped first."),
                { modal: true },
                t("Restore"),
            );
            if (answer !== t("Restore")) return;
            await runCommand(t("Restore automatic recovery changes"), async () => {
                await runtime.restoreRecovery();
            });
        }),
        vscode.commands.registerCommand("dsh.openInBrowser", async () => {
            await runCommand(t("Open dsh Web UI"), () => chatView.openBrowser());
        }),
        vscode.commands.registerCommand("dsh.insertEditorReference", () =>
            chatView.insertEditorReference(),
        ),
        vscode.commands.registerCommand("dsh.askAboutResource", (resource?: vscode.Uri) =>
            runCommand(t("Ask about resource"), () => chatView.askAboutResource(resource)),
        ),
        vscode.commands.registerCommand("dsh.explainDebugState", () =>
            runQuietCommand(t("Capture Debug Context"), () => chatView.explainDebugState()),
        ),
        ...registerQuickTaskCommands(chatView),
        vscode.commands.registerCommand("dsh.openIdeContextPicker", () =>
            chatView.openIdeContextPicker(),
        ),
        vscode.commands.registerCommand("dsh.insertPromptTemplate", () =>
            runCommand(t("Insert prompt template"), () => chatView.insertPromptTemplate()),
        ),
        vscode.commands.registerCommand("dsh.captureAppShot", () =>
            runCommand(t("Capture AppShot"), () => chatView.captureAppShot()),
        ),
        vscode.commands.registerCommand("dsh.configureApiKey", () =>
            chatView.configureApiKey().catch((error) => {
                const message = error instanceof Error ? error.message : String(error);
                void vscode.window.showErrorMessage(t("DSH: Failed to configure API Key: {message}", { message }));
            }),
        ),
        vscode.commands.registerCommand("dsh.manageProviders", () =>
            runCommand(t("Manage providers"), () => chatView.manageProviders()),
        ),
        vscode.commands.registerCommand("dsh.manageWorkspaces", () =>
            runCommand(t("Manage DSH Workspaces"), () => chatView.manageWorkspaces()),
        ),
        vscode.commands.registerCommand("dsh.manageAgentPresets", () =>
            runCommand(t("Manage Agent Presets"), () => chatView.manageAgentPresets()),
        ),
        vscode.commands.registerCommand("dsh.refreshBalance", () => balanceService.refresh()),
        vscode.commands.registerCommand("dsh.diagnoseEnvironment", async () => {
            await runCommand(t("Diagnose environment"), async () => {
                output.appendLine("");
                output.appendLine(await runtime.diagnoseEnvironment(workspaceRoot()));
                output.show(true);
            });
        }),
    );
    balanceService.start();

    const configuration = vscode.workspace.getConfiguration("dsh");
    const autoStart = configuration.get<boolean>("autoStart", true);
    const root = workspaceRoot();
    const configuredServerUrl = configuration.get<string>("serverUrl", "").trim();
    if (autoStart && vscode.workspace.isTrusted && (root || configuredServerUrl)) {
        void runtime.start(root).catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            output.appendLine(`[dsh] automatic startup failed: ${message}`);
        });
    }

    return {
        registerAgentStatusPresentation: (presentation) =>
            agentStatusPresentations.registerAgentStatusPresentation(presentation),
        registerConversationNavigation: (entries) =>
            conversationNavigationRegistry.registerConversationNavigation(entries),
    };
}

function registerChatParticipant(chatView: ChatViewProvider, extensionUri: vscode.Uri): vscode.Disposable {
    const participant = vscode.chat.createChatParticipant("dsh", async (request, _context, response, token) => {
        const prompt = request.prompt.trim();
        if (!prompt) {
            response.markdown(t("Please provide a task for dsh."));
            return;
        }
        response.progress(t("Sending the task to the dsh session..."));
        await chatView.sendParticipantPrompt(prompt, token);
        if (token.isCancellationRequested) return;
        response.markdown(t("Task sent to the current dsh session. Continue in the DSH view for streaming output and approvals."));
    });
    participant.iconPath = {
        light: vscode.Uri.joinPath(extensionUri, "resources", "dsh.svg"),
        dark: vscode.Uri.joinPath(extensionUri, "resources", "dsh-dark.svg"),
    };
    return participant;
}

function registerQuickTaskCommands(chatView: ChatViewProvider): vscode.Disposable[] {
    const tasks: ReadonlyArray<{ kind: QuickTaskKind; command: string }> = [
        { kind: "explain", command: "explain" },
        { kind: "fix", command: "fix" },
        { kind: "review", command: "review" },
        { kind: "docs", command: "docs" },
    ];

    return tasks.flatMap(({ kind, command }) => [
        vscode.commands.registerCommand(`dsh.editorTask.${command}`, () =>
            runQuietCommand(t("Prefill editor quick task"), () => chatView.prefillEditorTask(kind)),
        ),
        vscode.commands.registerCommand(`dsh.gitDiffTask.${command}`, () =>
            runQuietCommand(t("Prefill Git diff quick task"), () => chatView.prefillGitDiffTask(kind)),
        ),
    ]);
}

export function deactivate(): Promise<void> | undefined {
    // VS Code awaits this promise; asynchronous Disposable callbacks alone are not awaited.
    return shutdownRuntime?.();
}

function workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

async function runCommand(label: string, action: () => Promise<void>): Promise<void> {
    try {
        await action();
        void vscode.window.showInformationMessage(t("DSH: {label} completed.", { label }));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(t("DSH: {label} failed: {message}", { label, message }));
    }
}

async function runQuietCommand(label: string, action: () => Promise<void>): Promise<void> {
    try {
        await action();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(t("DSH: {label} failed: {message}", { label, message }));
    }
}
