import { randomUUID } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import * as vscode from "vscode";
import { AgentStatusPresentationRegistry } from "./agentStatusPresentation";
import { captureAppShot as captureNativeAppShot } from "./appShot";
import { DeepSeekBalanceService } from "./balanceService";
import {
    highestKnownSeq,
    hiddenViewBadge,
    focusChatMessages,
    OptimisticPrompt,
    promptDisplayText,
    projectChatMessages,
    projectTurnStatus,
    queueDockItems,
    resolvePromptMode,
} from "./chatState";
import {
    ChatViewAction,
    CHAT_WEBVIEW_PROTOCOL_VERSION,
    parseChatViewAction,
    validateQuestionAnswers,
} from "./chatViewProtocol";
import { ContextStore } from "./contextStore";
import { AGENT_PRESET_DOCUMENT_SCHEME, manageAgentPresets } from "./agentPresetActions";
import { ChangeReviewStore } from "./changeReviewStore";
import { ToolDiffStore } from "./toolDiffStore";
import { manageWorkspaces } from "./workspaceActions";
import { DshRuntime } from "./dshRuntime";
import { goalActionAllowed, goalOperationFor } from "./goalActions";
import { isImageMediaType, isRecord } from "./guards";
import { manageProviders as runProviderManagement } from "./providerManagement";
import {
    applyCodeBlock,
    copyCodeBlock,
    insertCodeBlock,
    openCodeBlock,
} from "./codeBlockActions";
import { MarkdownRenderCache } from "./markdownRenderCache";
import { samePath } from "./paths";
import { presentSessionRows } from "./sessionCatalog";
import { SessionCatalogCache } from "./sessionCatalogCache";
import { listPromptTemplates, readPromptTemplate } from "./promptTemplates";
import { MessageFeedbackController } from "./messageFeedbackController";
import { SubagentController } from "./subagentController";
import { projectionCell, projectionValue, type SessionStateSnapshot } from "./sessionStore";
import { isRemoteError } from "./remote/errors";
import { presentHostBaseline } from "./hostState";
import { t } from "./localize";
import { DshTerminalCommand, TerminalContextStore } from "./terminalContext";
import {
    imageLimitsProjection,
    permissionProjection,
    planProjection,
    prepareImageUploads,
    presentSettingsPanel,
    settingsMutationOps,
    reasoningEffortOptions,
    scheduleProjection,
    sessionStatsProjection,
    todoProjection,
} from "./chatViewPresentation";
import {
    parseSafeHttpUrl,
    renderSafeMarkdown,
} from "./safeMarkdown";
import {
    GoalMutationGate,
    type GoalMutationOperation,
    normalizeGoalRef,
    parseGoalProjection,
    presentGoalHud,
    presentJobCenter,
    presentApprovalCall,
    presentPlanReview,
} from "./sessionFeatures";
import {
    ChatViewState,
    ChatImageView,
    ChatMessage,
    DshAgentPresetEntry,
    DshDynamicPluginPanelView,
    DshImageLimitsView,
    DshImageUpload,
    DshFileReferenceCandidate,
    DshSessionReferenceCandidate,
    DshReferenceCandidate,
    DshReasoningEffortOption,
    DshSessionSearchItem,
    DshSessionModelsResult,
    DshSettingFieldType,
    DshSettingFieldView,
    DshSettingsCardView,
    DshSettingsPanelView,
    DshSettingsNamespaceView,
    DshCommandDescriptor,
    DshSkillEntry,
    DshTodoItemView,
    DshWorkspaceView,
    PermissionProjectionView,
    SessionStatsView,
} from "./types";
import { projectTokenUsage, SelectedModelSnapshot } from "./tokenUsage";
import { openWorkspaceFileLocation } from "./workspaceNavigation";
import { errorMessage } from "./errors";
import { normalizeModelSelectionProjection, sameModelSelection } from "./modelSelection";
import {
    formatFileReferenceMention,
    formatSessionReferenceMention,
    referencePathPresentation,
} from "./referenceCandidates";

interface PersistedSession {
    sessionId: string;
    cwd: string;
}

export type QuickTaskKind = "explain" | "fix" | "review" | "docs";

const EDITOR_TASK_PROMPTS: Readonly<Record<QuickTaskKind, (reference: string) => string>> = {
    explain: (reference) =>
        t("Explain the implementation, key data flow, and important edge cases in {reference}.", { reference }),
    fix: (reference) =>
        t("Inspect and fix issues in {reference}. Explain the issues and proposed changes before implementing them.", { reference }),
    review: (reference) =>
        t("Review {reference}, focusing on correctness, regression risk, security, and maintainability.", { reference }),
    docs: (reference) =>
        t("Generate or improve documentation for {reference}, following the project's existing style.", { reference }),
};

const GIT_DIFF_TASK_PROMPTS: Readonly<Record<QuickTaskKind, () => string>> = {
    explain: () => t("Explain the purpose, implementation, and impact of the attached Git diff."),
    fix: () => t("Inspect and fix issues in the attached Git diff. Explain the issues and proposed changes before implementing them."),
    review: () => t("Review the attached Git diff, focusing on defects, regression risk, security, and omissions."),
    docs: () => t("Generate or update relevant documentation from the attached Git diff, following the project's existing style."),
};

const DEFAULT_AGENT_STATUS_LABELS = [
    "大肥鱼正在深潜…",
    "大肥鱼摆摆尾巴，想想办法…",
    "大肥鱼翻了个身，继续思考…",
    "大肥鱼正在吞吐上下文…",
    "大肥鱼在鱼缸里转圈…",
    "大肥鱼：这题我会…",
] as const;


/**
 * The command name a prompt line would invoke, by the host parser's grammar:
 * a slash at byte zero, a lowercase name, then whitespace or end of input.
 * `/path/to/file` is not a command line, and neither is `/Compact`.
 */
function looksLikeCommandLine(text: string): string | undefined {
    return /^\/([a-z][a-z0-9_-]*)(?:$|[\t\n\r ])/u.exec(text)?.[1];
}

function goalErrorCode(error: unknown): string | undefined {
    if (!isRemoteError(error)) return undefined;
    const details = error.details;
    const code = isRecord(details) ? details.goalCode : undefined;
    return typeof code === "string" ? code : error.code;
}

function goalErrorForHud(error: unknown, operation: GoalMutationOperation): string {
    const raw = errorMessage(error).trim();
    const normalized = raw
        .replace(/^GoalError:\s*/iu, "")
        .trim();
    const lower = normalized.toLowerCase();
    const code = goalErrorCode(error);
    let summary = normalized || raw;
    if (operation === "resume" && /\b(active|running)\b/u.test(lower)) {
        summary = t("Goal is already active; resume is not needed.");
    } else if (operation === "resume" && /\b(max(?:imum)?|limit|exhausted|no more).*round|round.*(max(?:imum)?|limit|exhausted)/u.test(lower)) {
        summary = t("Goal has reached its maximum rounds and cannot be resumed.");
    } else if (operation === "resume" && /\bblocked\b/u.test(lower)) {
        summary = t("Goal is blocked; resolve the blocking reason before resuming.");
    } else if (operation === "resume" && /\bcomplete(?:d)?\b/u.test(lower)) {
        summary = t("Goal is already completed.");
    } else if (operation === "pause" && /\bpaused\b/u.test(lower)) {
        summary = t("Goal is already paused.");
    } else if (operation === "complete" && /\bcomplete(?:d)?\b/u.test(lower)) {
        summary = t("Goal is already completed.");
    } else if (code === "GOAL_NOT_FOUND" || code === "goal/not-found" || /not found|does not exist|no goal|missing/u.test(lower)) {
        summary = t("The current session has no Goal to change.");
    } else if (
        code === "GOAL_STALE_REVISION" ||
        code === "goal/conflict" ||
        code === "goal/stale-revision" ||
        /revision|stale|conflict|compare[- ]and[- ]set|\bcas\b/u.test(lower)
    ) {
        summary = t("Goal changed elsewhere; refresh and try again.");
    }
    return summary === raw ? summary : `${summary}\n${raw}`;
}

function referencesSelection(text: string): boolean {
    return /(^|\s)@selection(?=$|\s|[,.;:!?])/u.test(text);
}

function isCredentialIssue(error: unknown): boolean {
    const message = errorMessage(error).toLowerCase();
    return /missing[_ -]?credential|api[ _-]?key|\bauth\b|authentication|unauthori[sz]ed|\b401\b|credential.*(unset|missing|not configured)/u.test(
        message,
    );
}

/**
 * Default sprite image used as the reasoning effort slider knob, e.g. the
 * 8-frame "chibi runner" strip from the dsh-reasoning-effort plugin.
 * Applied to every effort unless overridden per-id below.
 */
const REASONING_EFFORT_KNOB_IMAGE = "chibi-runner-strip.png";

/**
 * Per-effort knob image overrides.
 * Maps an effort id (e.g. "low") to an image file inside `resources/`.
 */
const REASONING_EFFORT_IMAGES: Readonly<Record<string, string>> = {};

function positiveTurn(value: unknown): number | undefined {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0
        ? value
        : undefined;
}

function isCheckpointMessageType(type: string): boolean {
    return type === "user/message" || type === "assistant/message";
}

/** Resolve the turn containing a projected user/assistant message. */
function checkpointMessageTurn(snapshot: SessionStateSnapshot, seq: number): number | undefined {
    const target = snapshot.events.find((stored) => stored.event.seq === seq);
    if (!target || !isCheckpointMessageType(target.event.type)) return undefined;
    const targetData = isRecord(target.event.data) ? target.event.data : undefined;
    const explicit = positiveTurn(targetData?.turn);
    if (explicit !== undefined) return explicit;

    let active: number | undefined;
    for (const stored of snapshot.events) {
        if (stored.event.seq > seq) break;
        const data = isRecord(stored.event.data) ? stored.event.data : undefined;
        if (stored.event.type === "turn/start") {
            const turn = positiveTurn(data?.turn);
            if (turn !== undefined) active = turn;
        } else if (stored.event.type === "turn/end") {
            const turn = positiveTurn(data?.turn);
            if (turn === active) active = undefined;
        }
    }
    return active;
}

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    public static readonly viewType = "dsh.chatView";

    private view: vscode.WebviewView | undefined;
    private viewMessageDisposable: vscode.Disposable | undefined;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly optimisticPrompts: OptimisticPrompt[] = [];
    private readonly markdownRenders = new MarkdownRenderCache();
    private readonly goalMutations = new GoalMutationGate();
    private readonly subagents: SubagentController;
    private sessionId: string | undefined;
    private sessionCwd: string | undefined;
    private newSessionDraft = false;
    private pendingNewSessionPreset: string | undefined;
    private pendingNewSessionWorkspaceId: string | undefined;
    private pendingNewSessionWorkspacePath: string | undefined;
    private pendingNewSessionWorkspaceTitle: string | undefined;
    private submitting = false;
    private planCommandTail: Promise<void> = Promise.resolve();
    private cancelRequested = false;
    private checkpointActionInFlight = false;
    private selectionEnabled = true;
    private focusMode = false;
    private fileReferenceCandidates: DshReferenceCandidate[] = [];
    private fileReferenceQueryGeneration = 0;
    private fileReferenceQueryAbort: AbortController | undefined;
    private pendingComposerUpdate: { type: "insertText" | "setText"; text: string } | undefined;
    private readonly pendingComposerImages: DshImageUpload[] = [];
    private webviewReady = false;
    private restoringPersistedSession: Promise<void> | undefined;
    private stateUpdateTimer: ReturnType<typeof setTimeout> | undefined;
    private readonly observedRunning = new Map<string, boolean>();
    private readonly completedWhileHidden = new Set<string>();
    private readonly selectedModels = new Map<string, SelectedModelSnapshot>();
    private readonly modelCatalogs = new SessionCatalogCache<DshSessionModelsResult>();
    private readonly modelSelectionProjectionSeqs = new Map<string, number>();
    private readonly skillCatalogs = new SessionCatalogCache<DshSkillEntry[]>();
    private readonly commandCatalogs = new SessionCatalogCache<DshCommandDescriptor[]>();
    private readonly messageFeedback: MessageFeedbackController;
    /**
     * Latched once the Runtime answers 404 for the command registry, so an
     * older Runtime is asked once per connection instead of on every state
     * post. Cleared when a new stream generation connects.
     */
    private commandRegistryUnavailable = false;
    private agentPresetCatalog: DshAgentPresetEntry[] | undefined;
    private agentPresetCatalogRequest: Promise<void> | undefined;
    private agentPresetCatalogGeneration = 0;
    private agentPresetCatalogRefreshPending = false;
    private pendingNewSessionSkills: DshSkillEntry[] | undefined;
    private readonly agentPresetDocuments = new Map<string, string>();
    private readonly imageCache = new Map<string, { src?: string; error?: string; loading?: boolean }>();
    private settingsPanel: DshSettingsPanelView | undefined;
    private readonly settingsNamespaces = new Map<string, DshSettingsNamespaceView>();
    private settingsPanelGeneration = 0;
    private pluginInventoryGeneration = 0;
    private dynamicPlugins: DshDynamicPluginPanelView | undefined;
    private dynamicPluginsGeneration = 0;
    private readonly changeReviews: ChangeReviewStore;
    private readonly toolDiffs: ToolDiffStore;
    private agentStatusChoice: { sessionId: string; candidateKey: string; label: string } | undefined;

    public constructor(
        private readonly extensionContext: vscode.ExtensionContext,
        private readonly extensionUri: vscode.Uri,
        private readonly runtime: DshRuntime,
        private readonly contextStore: ContextStore,
        private readonly terminalContext: TerminalContextStore,
        private readonly output: vscode.OutputChannel,
        private readonly balanceService?: DeepSeekBalanceService,
        private readonly agentStatusPresentations?: AgentStatusPresentationRegistry,
    ) {
        this.changeReviews = new ChangeReviewStore(output);
        this.toolDiffs = new ToolDiffStore(output);
        this.subagents = new SubagentController({
            runtime,
            currentRootSession: () => this.sessionId,
            onChange: () => this.postState(),
        });
        this.messageFeedback = new MessageFeedbackController({
            runtime,
            currentRootSession: () => this.sessionId,
            onChange: () => this.postState(),
        });
        const unsubscribeSession = runtime.getSessionStore().onDidChange((sessionId, snapshot) => {
            const catalogSession = runtime.getSessionCatalog().snapshot().sessions.find(
                (item) => item.sessionId === sessionId,
            );
            if (!catalogSession?.parentSessionId && catalogSession?.origin !== "subagent") {
                this.changeReviews.observe(
                    sessionId,
                    catalogSession?.cwd ?? (sessionId === this.sessionId ? this.sessionCwd : undefined),
                    snapshot,
                );
            }
            const subagentTimingChanged = this.subagents.observeSubagentTiming(sessionId, snapshot);
            if (sessionId === this.sessionId) {
                this.observeModelSelection(sessionId, snapshot);
                this.goalMutations.observe(
                    sessionId,
                    projectionCell(snapshot, "goal"),
                );
                this.schedulePostState();
            } else if (subagentTimingChanged) {
                this.schedulePostState();
            }
        });
        const unsubscribeCatalog = runtime.getSessionCatalog().onDidChange(() => {
            this.observeSessionTransitions();
            this.schedulePostState();
            this.subagents.scheduleSubagentRefresh();
        });
        this.disposables.push(
            vscode.workspace.registerTextDocumentContentProvider(
                AGENT_PRESET_DOCUMENT_SCHEME,
                {
                    provideTextDocumentContent: (uri) =>
                        this.agentPresetDocuments.get(uri.toString()) ?? "",
                },
            ),
            vscode.workspace.onDidCloseTextDocument((document) => {
                if (document.uri.scheme === AGENT_PRESET_DOCUMENT_SCHEME) {
                    this.agentPresetDocuments.delete(document.uri.toString());
                }
            }),
            runtime.onDidChange((status) => {
                if (status.state === "stopped") {
                    ++this.dynamicPluginsGeneration;
                    this.dynamicPlugins = undefined;
                }
                this.schedulePostState();
            }),
            agentStatusPresentations?.onDidChange(() => this.schedulePostState()) ?? new vscode.Disposable(() => {}),
            runtime.onDidRemoteEvent((event) => {
                // Forwarded RC events carry no diff. Invalidate the affected
                // local cache and repull the visible session when possible.
                switch (event) {
                    case "commands/change":
                        this.commandCatalogs.invalidate();
                        if (this.sessionId) this.refreshCommandCatalog(this.sessionId);
                        break;
                    case "agent-preset/selected":
                        this.invalidateAgentPresetCatalog();
                        this.refreshAgentPresetCatalog();
                        break;
                    case "llm/adapters-updated":
                    case "credentials/reference-updated":
                        this.modelCatalogs.invalidate();
                        if (this.sessionId) this.refreshModelCatalog(this.sessionId);
                        break;
                    case "settings/document-updated":
                        ++this.settingsPanelGeneration;
                        ++this.pluginInventoryGeneration;
                        this.settingsPanel = undefined;
                        this.settingsNamespaces.clear();
                        this.postState();
                        break;
                    case "cordis/dynamic-package":
                    case "cordis/dynamic-retract":
                    case "cordis/request-run":
                    case "cordis/request-run-resolved":
                        void this.refreshDynamicPlugins();
                        break;
                    default:
                        break;
                }
            }),
            runtime.onDidHarnessConnect(() => {
                this.commandRegistryUnavailable = false;
                this.commandCatalogs.clear();
                void this.refreshDynamicPlugins();
                void this.restorePersistedSession(this.workspaceRoot()).then(() => {
                    if (this.sessionId) {
                        this.refreshModelCatalog(this.sessionId);
                        this.refreshSkillCatalog(this.sessionId);
                        this.refreshCommandCatalog(this.sessionId);
                        void this.subagents.refreshSubagentTree(this.sessionId);
                    }
                });
            }),
            contextStore.onDidChange(() => this.schedulePostState()),
            terminalContext.onDidChange(() => this.schedulePostState()),
            terminalContext.onDidCapture((command) => {
                if (command.exitCode !== undefined && command.exitCode !== 0) {
                    void this.offerFailedTerminalCommand(command);
                }
            }),
            vscode.workspace.onDidChangeConfiguration((event) => {
                if (
                    event.affectsConfiguration("dsh.agentStatusLabel") ||
                    event.affectsConfiguration("dsh.agentStatusLabels")
                ) {
                    this.agentStatusChoice = undefined;
                    this.schedulePostState();
                }
            }),
            vscode.window.onDidChangeActiveTextEditor(() => this.schedulePostState()),
            vscode.window.onDidChangeTextEditorSelection(() => this.schedulePostState()),
            this.changeReviews.onDidUpdate(() => this.schedulePostState()),
            vscode.workspace.onDidChangeConfiguration((event) => {
                if (
                    event.affectsConfiguration("dsh.enableEffortKnob") ||
                    event.affectsConfiguration("dsh.autoOpenReasoning")
                ) {
                    this.schedulePostState();
                }
            }),
            new vscode.Disposable(unsubscribeSession),
            new vscode.Disposable(unsubscribeCatalog),
        );
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        this.view = webviewView;
        this.webviewReady = false;
        this.seedObservedRunning();
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri],
        };
        webviewView.webview.html = this.getHtml(webviewView.webview);
        this.viewMessageDisposable?.dispose();
        this.viewMessageDisposable = webviewView.webview.onDidReceiveMessage((message: unknown) =>
            this.handleMessage(message),
        );
        this.disposables.push(
            webviewView.onDidChangeVisibility(() => {
                if (webviewView.visible) this.completedWhileHidden.clear();
                this.updateViewBadge();
            }),
            webviewView.onDidDispose(() => {
                if (this.view === webviewView) {
                    this.view = undefined;
                    this.webviewReady = false;
                }
            }),
        );
        this.postState();
    }

    public insertEditorReference(): void {
        const reference = this.contextStore.getActiveEditorReference();
        if (!reference) {
            this.reportError(new Error(t("There is no current editor to reference.")));
            return;
        }

        this.insertComposerText(reference);
    }

    /** Prefills a safe, workspace-scoped prompt for an Explorer resource. */
    public async askAboutResource(resource?: vscode.Uri): Promise<void> {
        if (!vscode.workspace.isTrusted) {
            throw new Error(t("Trust the current workspace before asking about a resource."));
        }
        if (!resource || resource.scheme !== "file") {
            throw new Error(t("Select a file or directory inside a workspace first."));
        }
        const folder = vscode.workspace.getWorkspaceFolder(resource);
        if (!folder) {
            throw new Error(t("The selected resource is outside the current workspace."));
        }

        const relativePath = relative(folder.uri.fsPath, resource.fsPath).replace(/\\/gu, "/");
        if (
            !relativePath ||
            relativePath === ".." ||
            relativePath.startsWith("../") ||
            isAbsolute(relativePath)
        ) {
            throw new Error(t("The selected resource is outside the current workspace."));
        }

        let resourceType = t("Workspace resource");
        try {
            const stat = await vscode.workspace.fs.stat(resource);
            resourceType = stat.type & vscode.FileType.Directory ? t("Directory") : t("File");
        } catch {
            // The prompt remains useful when the Explorer item disappears during the command.
        }

        const cleanPath = relativePath.replace(/[\r\n]/gu, " ");
        this.setComposerText([
            t("Inspect this workspace resource and help me with it."),
            `${t("Workspace root")}: ${folder.uri.fsPath}`,
            `${t("Target path")}: ${cleanPath}`,
            `${t("Target type")}: ${resourceType}`,
        ].join("\n"));
    }

    public async prefillEditorTask(kind: QuickTaskKind): Promise<void> {
        const reference = this.contextStore.getActiveEditorReference();
        if (!reference) {
            throw new Error(t("There is no current editor for this quick task."));
        }

        this.setComposerText(EDITOR_TASK_PROMPTS[kind](reference));
    }

    public async prefillGitDiffTask(kind: QuickTaskKind): Promise<void> {
        await this.contextStore.addGitDiff();
        this.setComposerText(GIT_DIFF_TASK_PROMPTS[kind]());
    }

    /** Captures the focused debugger state and prepares a one-shot explanation task. */
    public async explainDebugState(): Promise<void> {
        await this.contextStore.addDebugContext();
        this.setComposerText(t("Explain why execution stopped here and suggest the next debugging checks."));
    }

    public async configureApiKey(): Promise<void> {
        const configuration = vscode.workspace.getConfiguration("dsh");
        const ref = configuration.get<string>("apiKeyEnv", "DEEPSEEK_API_KEY").trim();
        if (!ref) {
            throw new Error(t("dsh.apiKeyEnv cannot be empty. Configure a credential reference name first."));
        }

        const key = await vscode.window.showInputBox({
            title: t("Configure {reference}", { reference: ref }),
            prompt: t("The API Key is passed to the dsh runtime and encrypted in VS Code SecretStorage for balance queries. It is never written to extension state or logs."),
            password: true,
            ignoreFocusOut: true,
            validateInput: (value) => (value.trim() ? undefined : t("Enter an API Key.")),
        });
        if (key === undefined) {
            return;
        }

        await this.runtime.start(this.workspaceRoot());
        await this.runtime.setCredential(ref, key.trim());
        try {
            await this.balanceService?.storeApiKey(key.trim());
        } catch (error) {
            const message = errorMessage(error);
            void vscode.window.showWarningMessage(t("DSH: The chat key was saved, but balance caching failed: {message}", { message }));
        }
        void vscode.window.showInformationMessage(t("DSH: {reference} was saved. You can retry the task.", { reference: ref }));
        this.reveal();
    }

    public manageWorkspaces(): Promise<void> {
        return manageWorkspaces({
            runtime: this.runtime,
            workspaceRoot: () => this.workspaceRoot(),
            onWorkspaceRenamed: (workspaceId, title) => {
                if (this.pendingNewSessionWorkspaceId !== workspaceId) return;
                this.pendingNewSessionWorkspaceTitle = title;
                this.postState();
            },
            onWorkspaceRemoved: (workspaceId) => {
                if (this.pendingNewSessionWorkspaceId !== workspaceId) return;
                this.clearNewSessionWorkspace();
                this.postState();
            },
        });
    }

    public manageAgentPresets(): Promise<void> {
        return manageAgentPresets({
            runtime: this.runtime,
            output: this.output,
            workspaceRoot: () => this.workspaceRoot(),
            onCatalog: (presets) => {
                this.agentPresetCatalog = [...presets];
            },
            onSnapshotDocument: (uri, content) => {
                this.agentPresetDocuments.set(uri, content);
            },
            onPresetRemoved: (presetId) => {
                if (this.pendingNewSessionPreset !== presetId) return;
                this.pendingNewSessionPreset = undefined;
                this.pendingNewSessionSkills = undefined;
                this.postState();
            },
        });
    }

    private async toggleSettingsPanel(): Promise<void> {
        if (this.settingsPanel?.open) {
            this.settingsPanel = undefined;
            this.settingsNamespaces.clear();
            ++this.settingsPanelGeneration;
            ++this.pluginInventoryGeneration;
            this.postState();
            return;
        }
        const generation = ++this.settingsPanelGeneration;
        const inventoryGeneration = ++this.pluginInventoryGeneration;
        this.settingsPanel = {
            open: true,
            loading: true,
            writable: false,
            hasDocument: false,
            cards: [],
            pluginInventory: { loading: true, entries: [] },
        };
        this.postState();
        try {
            await this.runtime.start(this.workspaceRoot());
            const [settingsResult, inventoryResult] = await Promise.allSettled([
                this.runtime.describeSettings(),
                this.runtime.pluginInventory(),
            ]);
            if (generation !== this.settingsPanelGeneration || inventoryGeneration !== this.pluginInventoryGeneration) return;
            if (settingsResult.status === "fulfilled") {
                this.settingsNamespaces.clear();
                for (const namespace of settingsResult.value.namespaces) this.settingsNamespaces.set(namespace.ns, namespace);
                this.settingsPanel = presentSettingsPanel(settingsResult.value);
            } else {
                this.settingsNamespaces.clear();
                this.settingsPanel = {
                    open: true,
                    writable: false,
                    hasDocument: false,
                    cards: [],
                    error: errorMessage(settingsResult.reason),
                };
                this.output.appendLine(`[dsh:settings] describe failed: ${errorMessage(settingsResult.reason)}`);
            }
            if (inventoryResult.status === "fulfilled") {
                this.settingsPanel.pluginInventory = {
                    entries: inventoryResult.value.entries,
                    ...(inventoryResult.value.agentPresets === undefined
                        ? {}
                        : { agentPresets: inventoryResult.value.agentPresets }),
                };
            } else {
                this.settingsPanel.pluginInventory = {
                    entries: [],
                    error: t("Plugins are temporarily unavailable."),
                };
                this.output.appendLine(`[dsh:plugin-inventory] list failed: ${errorMessage(inventoryResult.reason)}`);
            }
        } catch (error) {
            if (generation !== this.settingsPanelGeneration || inventoryGeneration !== this.pluginInventoryGeneration) return;
            this.settingsPanel = {
                open: true,
                writable: false,
                hasDocument: false,
                cards: [],
                error: errorMessage(error),
                pluginInventory: {
                    entries: [],
                    error: t("Plugins are temporarily unavailable."),
                },
            };
            this.output.appendLine(`[dsh:settings] panel load failed: ${errorMessage(error)}`);
        }
        this.postState();
    }

    private async refreshPluginInventory(): Promise<void> {
        const panel = this.settingsPanel;
        if (!panel?.open) return;
        const generation = ++this.pluginInventoryGeneration;
        this.settingsPanel = {
            ...panel,
            pluginInventory: { loading: true, entries: [] },
        };
        this.postState();
        try {
            await this.runtime.start(this.workspaceRoot());
            const inventory = await this.runtime.pluginInventory();
            if (generation !== this.pluginInventoryGeneration || !this.settingsPanel?.open) return;
            this.settingsPanel = {
                ...this.settingsPanel,
                pluginInventory: {
                    entries: inventory.entries,
                    ...(inventory.agentPresets === undefined
                        ? {}
                        : { agentPresets: inventory.agentPresets }),
                },
            };
        } catch (error) {
            if (generation !== this.pluginInventoryGeneration || !this.settingsPanel?.open) return;
            this.settingsPanel = {
                ...this.settingsPanel,
                pluginInventory: {
                    entries: [],
                    error: t("Plugins are temporarily unavailable."),
                },
            };
            this.output.appendLine(`[dsh:plugin-inventory] refresh failed: ${errorMessage(error)}`);
        }
        this.postState();
    }

    private async refreshDynamicPlugins(): Promise<void> {
        const generation = ++this.dynamicPluginsGeneration;
        const previousRows = this.dynamicPlugins?.rows ?? [];
        this.dynamicPlugins = { rows: previousRows, loading: true };
        this.postState();
        try {
            await this.runtime.start(this.workspaceRoot());
            const rows = await this.runtime.dynamicPluginInventory();
            if (generation !== this.dynamicPluginsGeneration) return;
            if (rows === undefined) {
                this.dynamicPlugins = undefined;
            } else {
                this.dynamicPlugins = { rows };
            }
        } catch (error) {
            if (generation !== this.dynamicPluginsGeneration) return;
            this.dynamicPlugins = {
                rows: previousRows,
                error: t("Dynamic plugins are temporarily unavailable."),
            };
            this.output.appendLine(`[dsh:dynamic-plugins] inventory failed: ${errorMessage(error)}`);
        }
        this.postState();
    }

    private async stopDynamicPlugin(sessionId: string, pluginId: string): Promise<void> {
        const present = this.dynamicPlugins?.rows.some(
            (candidate) => candidate.agentId === sessionId && candidate.pluginId === pluginId,
        );
        if (!present) throw new Error(t("Dynamic plugin state is out of date. Refresh and try again."));
        const result = await this.runtime.stopDynamicPlugin(sessionId, pluginId);
        if (!result.ok) throw new Error(result.message);
        await this.refreshDynamicPlugins();
    }

    private async removeDynamicPlugin(sessionId: string, pluginId: string): Promise<void> {
        const present = this.dynamicPlugins?.rows.some(
            (candidate) => candidate.agentId === sessionId && candidate.pluginId === pluginId,
        );
        if (!present) throw new Error(t("Dynamic plugin state is out of date. Refresh and try again."));
        const result = await this.runtime.removeDynamicPlugin(sessionId, pluginId);
        if (!result.ok) throw new Error(result.message);
        await this.refreshDynamicPlugins();
    }

    private async declineDynamicPlugin(pluginId: string, requestId: string): Promise<void> {
        const row = this.dynamicPlugins?.rows.find((candidate) => candidate.pluginId === pluginId);
        const latest = row?.latestRun;
        if (!latest || latest.status !== "awaiting-approval" || latest.approvalRequestId !== requestId) {
            throw new Error(t("Dynamic plugin approval is out of date. Refresh and try again."));
        }
        const result = await this.runtime.declineDynamicPlugin(requestId, latest.pluginRunId);
        if (!result.accepted) throw new Error(t("The dynamic plugin approval was already resolved."));
        await this.refreshDynamicPlugins();
    }

    private async mutateSettings(
        namespaceId: string,
        revision: number,
        changes: Array<{ path: string[]; value: string; clear: boolean }>,
    ): Promise<void> {
        const panel = this.settingsPanel;
        const namespace = this.settingsNamespaces.get(namespaceId);
        const card = panel?.cards.find((candidate) => candidate.ns === namespaceId);
        if (!panel?.open || !panel.writable || !namespace || !card || card.revision !== revision) {
            throw new Error(t("Settings are out of date. Close and reopen the settings cards."));
        }
        const ops = settingsMutationOps(card.fields, changes);
        if (ops.length === 0) return;
        const updated = await this.runtime.mutateSettings(namespaceId, ops, revision);
        this.settingsNamespaces.set(namespaceId, updated);
        const refreshed = presentSettingsPanel({
            writable: panel.writable,
            hasDocument: panel.hasDocument,
            namespaces: [...this.settingsNamespaces.values()],
        });
        this.settingsPanel = {
            ...refreshed,
            ...(panel.pluginInventory === undefined ? {} : { pluginInventory: panel.pluginInventory }),
        };
        this.postState();
    }

    public manageProviders(): Promise<void> {
        return runProviderManagement({
            runtime: this.runtime,
            output: this.output,
            workspaceRoot: () => this.workspaceRoot(),
            openBrowser: () => this.openBrowser(),
        });
    }

    public async openIdeContextPicker(): Promise<void> {
        const hasSelection = Boolean(this.contextStore.getCurrentSelectionMetadata());
        const choice = await vscode.window.showQuickPick(
            [
                ...(hasSelection
                    ? [{ actionId: "selection" as const, label: `$(selection) ${t("Selection")}`, detail: t("Enable the current selection and read it again when sending") }]
                    : []),
                { actionId: "workspace-file" as const, label: `$(search) ${t("Workspace file")}`, detail: t("Fuzzy-search and insert an @file reference") },
                { actionId: "current-file" as const, label: `$(file-code) ${t("Current file")}`, detail: t("Insert an @file reference without copying its contents") },
                { actionId: "diagnostics" as const, label: `$(warning) ${t("Diagnostics")}`, detail: t("Attach once to this turn") },
                ...(vscode.debug.activeStackItem
                    ? [{ actionId: "debug-context" as const, label: `$(debug-alt) ${t("Debug context")}`, detail: t("Attach the current stack, locals, source, and diagnostics once") }]
                    : []),
                { actionId: "git-diff" as const, label: "$(git-compare) Git diff", detail: t("Attach once to this turn") },
                { actionId: "terminal-command" as const, label: `$(terminal) ${t("Recent terminal command")}`, detail: t("Attach one captured terminal command and its output") },
                {
                    actionId: "toggle-selection" as const,
                    label: this.selectionEnabled
                        ? `$(eye-closed) ${t("Disable selection")}`
                        : `$(eye) ${t("Enable selection")}`,
                    detail: this.selectionEnabled ? t("Do not attach the current selection automatically") : t("Attach the current selection automatically"),
                },
            ],
            { placeHolder: t("Choose IDE context for this turn or adjust the selection policy") },
        );
        if (!choice) {
            return;
        }

        if (choice.actionId === "selection") {
            this.selectionEnabled = true;
        } else if (choice.actionId === "workspace-file") {
            await this.openWorkspaceFileReferencePicker();
            return;
        } else if (choice.actionId === "current-file") {
            this.insertEditorReference();
            return;
        } else if (choice.actionId === "diagnostics") {
            await this.runContextAction(() => this.contextStore.addDiagnostics());
            return;
        } else if (choice.actionId === "debug-context") {
            // The picker only attaches context, like its diagnostics and diff
            // siblings; prefilling a prompt here would discard the draft the
            // user is writing. `dsh.explainDebugState` keeps that behavior.
            await this.runContextAction(() => this.contextStore.addDebugContext());
            return;
        } else if (choice.actionId === "git-diff") {
            await this.runContextAction(() => this.contextStore.addGitDiff());
            return;
        } else if (choice.actionId === "terminal-command") {
            await this.openTerminalCommandPicker();
            return;
        } else {
            this.selectionEnabled = !this.selectionEnabled;
        }
        this.reveal();
    }

    /** Lets the user attach one of the commands captured by shell integration. */
    /**
     * Pre-fills the composer from a workspace prompt template under
     * `.dsh/prompts`. Discovery is read-only and insertion is a visible draft
     * — sending stays a separate, manual step.
     */
    public async insertPromptTemplate(): Promise<void> {
        const workspaceRoot = this.workspaceRoot();
        if (!workspaceRoot) {
            throw new Error(t("Open a workspace first."));
        }
        const promptsRoot = vscode.Uri.joinPath(vscode.Uri.file(workspaceRoot), ".dsh", "prompts");
        const templates = await listPromptTemplates(promptsRoot);
        if (templates.length === 0) {
            void vscode.window.showInformationMessage(
                t("No prompt templates found under .dsh/prompts in this workspace."),
            );
            return;
        }
        const picked = await vscode.window.showQuickPick(
            templates.map((entry) => ({
                label: entry.label,
                description: entry.path,
                ...(entry.preview.length === 0 ? {} : { detail: entry.preview }),
                path: entry.path,
            })),
            {
                title: t("Prompt templates"),
                placeHolder: t("The template becomes the composer draft; sending stays manual."),
            },
        );
        if (!picked) return;
        this.setComposerText(await readPromptTemplate(promptsRoot, picked.path));
    }

    public async openTerminalCommandPicker(): Promise<void> {
        const records = this.terminalContext.recent();
        if (records.length === 0) {
            void vscode.window.showInformationMessage(t("No terminal commands have been captured yet."));
            return;
        }
        const choices = records.map((record) => {
            const exit = record.exitCode === undefined ? t("exit code unavailable") : t("exit code {code}", { code: record.exitCode });
            const preview = record.output.replace(/\s+/gu, " ").trim().slice(0, 240);
            return {
                label: `$(terminal) ${record.command}`,
                description: `${record.terminalName} · ${exit}`,
                detail: [record.cwd, preview].filter((value): value is string => Boolean(value)).join(" · ") || undefined,
                record,
            };
        });
        const choice = await vscode.window.showQuickPick(choices, {
            placeHolder: t("Choose a recent terminal command to attach"),
            matchOnDescription: true,
            matchOnDetail: true,
        });
        if (!choice) return;
        await this.runContextAction(() => this.contextStore.addTerminalCommand(choice.record));
    }

    private async offerFailedTerminalCommand(command: DshTerminalCommand): Promise<void> {
        const askAction = t("Ask DSH");
        const commandLabel = command.command.replace(/\s+/gu, " ").trim().slice(0, 180);
        const choice = await vscode.window.showWarningMessage(
            t("Terminal command failed with exit code {code}: {command}", {
                code: command.exitCode ?? "?",
                command: commandLabel,
            }),
            askAction,
        );
        if (choice !== askAction) return;
        this.contextStore.addTerminalCommand(command);
        this.setComposerText(t("Explain why this terminal command failed and suggest a fix."));
    }

    public async captureAppShot(): Promise<void> {
        this.reveal();
        const image = await captureNativeAppShot();
        if (!image) return;
        this.pendingComposerImages.push(image);
        this.flushPendingComposerImages();
    }

    private async openWorkspaceFileReferencePicker(): Promise<void> {
        const uris = await vscode.workspace.findFiles(
            "**/*",
            "**/{.git,node_modules,.DS_Store}/**",
            2_000,
        );
        const items = uris.map((uri) => {
            const relativePath = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/");
            return {
                label: `$(file) ${relativePath.split("/").pop() ?? relativePath}`,
                description: relativePath,
                uri,
            };
        });
        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: t("Search workspace files and insert @path"),
            matchOnDescription: true,
        });
        if (!selected) return;
        this.insertComposerText(`@${vscode.workspace.asRelativePath(selected.uri, false).replace(/\\/g, "/")}`);
    }

    public reveal(): void {
        void vscode.commands.executeCommand("workbench.view.extension.dsh");
        this.view?.show?.(false);
        this.postState();
    }

    public getCurrentSessionId(): string | undefined {
        return this.sessionId;
    }

    public async revealConversationMilestone(seq: number): Promise<void> {
        if (!Number.isSafeInteger(seq) || seq < 0) return;
        this.reveal();
        if (!this.view || !this.webviewReady) return;
        const sessionId = this.sessionId;
        let targetSeq = this.conversationRevealTarget(seq);
        if (targetSeq === undefined && sessionId) {
            // turnOutline anchors at `turn/start`, which is not itself a
            // rendered message. Rebaseline once so an unloaded turn can still
            // resolve to its first visible surface node before scrolling.
            await this.runtime.syncSession(sessionId);
            // The user can switch sessions across the await; resolving against
            // the new session's snapshot would reveal an unrelated message.
            if (this.sessionId !== sessionId) return;
            targetSeq = this.conversationRevealTarget(seq);
        }
        if (!this.view || !this.webviewReady) return;
        void this.view.webview.postMessage({ type: "revealMessage", seq: targetSeq ?? seq });
    }

    private conversationRevealTarget(seq: number): number | undefined {
        const snapshot = this.sessionId
            ? this.runtime.getSessionStore().get(this.sessionId)
            : undefined;
        if (!snapshot) return undefined;
        const exact = snapshot.surface.nodes.find((node) => node.seq === seq);
        if (exact) return exact.seq;

        const outline = snapshot.projections.find((cell) => cell.key === "turnOutline")?.value;
        if (!Array.isArray(outline) || !outline.some((candidate) =>
            isRecord(candidate) && candidate.seq === seq,
        )) return undefined;
        return snapshot.surface.nodes.find((node) => node.seq > seq)?.seq;
    }

    public async openBrowser(): Promise<void> {
        let url = this.runtime.getBrowserUrl();
        if (!url) {
            const started = await this.runtime.start(this.workspaceRoot());
            url = this.runtime.getBrowserUrl() ?? started;
        }
        await vscode.env.openExternal(vscode.Uri.parse(url));
    }

    /**
     * Open a generated file location in the local editor when it belongs to
     * this workspace. Remote deployments may own the Session cwd on another
     * filesystem, so fall back to the public Session opener only after the
     * local, bounded path check has failed and the Host advertises support.
     */
    private async openFileLocation(
        location: Extract<ChatViewAction, { type: "openFileLocation" }>,
    ): Promise<void> {
        try {
            await openWorkspaceFileLocation(
                location,
                this.sessionCwd ?? this.workspaceRoot(),
            );
            return;
        } catch (localError) {
            if (!this.runtime.getUrl()) throw localError;
            let canOpen = this.runtime.getHostDescription()?.canOpenPath;
            if (canOpen === undefined) {
                try {
                    canOpen = await this.runtime.canOpenWorkspacePath();
                } catch {
                    throw localError;
                }
            }
            if (!canOpen) throw localError;
            try {
                await this.runtime.openWorkspacePath(location.path);
            } catch {
                // Preserve the local diagnostic when the remote opener also
                // rejects the path; its failure is only a fallback attempt.
                throw localError;
            }
        }
    }

    public dispose(): void {
        this.viewMessageDisposable?.dispose();
        if (this.stateUpdateTimer) clearTimeout(this.stateUpdateTimer);
        this.subagents.dispose();
        this.fileReferenceQueryAbort?.abort();
        this.changeReviews.dispose();
        this.toolDiffs.dispose();
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
    }

    private async handleMessage(value: unknown): Promise<void> {
        const message = parseChatViewAction(value);
        if (!message) {
            this.output.appendLine("[dsh:webview] ignored malformed message");
            return;
        }
        try {
            switch (message.type) {
                case "ready":
                    this.webviewReady = true;
                    this.postState();
                    this.flushPendingComposerUpdate();
                    this.flushPendingComposerImages();
                    if (this.sessionId) void this.subagents.refreshSubagentTree(this.sessionId);
                    break;
                case "sendPrompt":
                    await this.sendPrompt(message.text ?? "", message.mode, message.images ?? []);
                    break;
                case "retryPrompt":
                    await this.retryPrompt(message.id);
                    break;
                case "cancel":
                    await this.cancel();
                    break;
                case "configureApiKey":
                    await this.configureApiKey();
                    break;
                case "manageProviders":
                    await this.manageProviders();
                    break;
                case "manageSettings":
                    await this.toggleSettingsPanel();
                    break;
                case "refreshPluginInventory":
                    await this.refreshPluginInventory();
                    break;
                case "refreshDynamicPlugins":
                    await this.refreshDynamicPlugins();
                    break;
                case "stopDynamicPlugin":
                    await this.stopDynamicPlugin(message.sessionId, message.pluginId);
                    break;
                case "removeDynamicPlugin":
                    await this.removeDynamicPlugin(message.sessionId, message.pluginId);
                    break;
                case "declineDynamicPlugin":
                    await this.declineDynamicPlugin(message.pluginId, message.requestId);
                    break;
                case "openSettingsDocument":
                    await this.openBrowser();
                    break;
                case "mutateSettings":
                    await this.mutateSettings(message.ns, message.revision, message.changes);
                    break;
                case "manageAgentPresets":
                    await this.manageAgentPresets();
                    break;
                case "manageWorkspaces":
                    await this.manageWorkspaces();
                    break;
                case "openIdeContextPicker":
                    await this.openIdeContextPicker();
                    break;
                case "openTerminalCommandPicker":
                    await this.openTerminalCommandPicker();
                    break;
                case "openPromptTemplatePicker":
                    await this.insertPromptTemplate();
                    break;
                case "captureAppShot":
                    await this.captureAppShot();
                    break;
                case "removeContext":
                    this.contextStore.remove(message.id);
                    break;
                case "loadImage":
                    await this.loadImage(message.attachmentId);
                    break;
                case "fileReferenceQuery":
                    await this.updateFileReferenceCandidates(message.query, message.quoted === true);
                    break;
                case "toggleSelection":
                    this.selectionEnabled = !this.selectionEnabled;
                    this.postState();
                    break;
                case "toggleFocus":
                    this.focusMode = !this.focusMode;
                    this.postState();
                    break;
                case "start":
                    await this.runtime.start(this.workspaceRoot());
                    break;
                case "stop":
                    await this.runtime.stop();
                    break;
                case "openLogs":
                    this.output.show(true);
                    break;
                case "openBrowser":
                    await this.openBrowser();
                    break;
                case "openExternalLink": {
                    const url = parseSafeHttpUrl(message.url);
                    if (!url) throw new Error(t("Only explicit HTTP(S) links can be opened."));
                    const opened = await vscode.env.openExternal(vscode.Uri.parse(url, true));
                    if (!opened) throw new Error(t("VS Code could not open the link."));
                    break;
                }
                case "openFileLocation":
                    await this.openFileLocation(message);
                    break;
                case "copyCode":
                    await this.copyCodeBlock(message.renderId, message.codeBlockId);
                    break;
                case "insertCode":
                    await this.insertCodeBlock(message.renderId, message.codeBlockId);
                    break;
                case "openCode":
                    await this.openCodeBlock(message.renderId, message.codeBlockId, message.language);
                    break;
                case "applyCode":
                    await this.applyCodeBlock(message.renderId, message.codeBlockId, message.language);
                    break;
                case "openTrace":
                    if (this.sessionId) {
                        await vscode.commands.executeCommand("dsh.openTrace", {
                            sessionId: this.sessionId,
                            ...(message.seq === undefined ? {} : { seq: message.seq }),
                        });
                    }
                    break;
                case "setPermissionPreset":
                    if (this.sessionId) {
                        // `/permission <preset>`; the argument is the preset
                        // name, which is exactly the projection's option value.
                        await this.runHostCommand(
                            this.sessionId,
                            `/permission ${message.value}`,
                        );
                    }
                    break;
                case "setPlanMode":
                    await this.setPlanMode(message.active);
                    break;
                case "openToolDiff":
                    await this.toolDiffs.openDiff(
                        this.sessionId ? this.runtime.getSessionStore().get(this.sessionId) : undefined,
                        this.sessionCwd ?? this.workspaceRoot(),
                        message.callId,
                        message.path,
                    );
                    break;
                case "openChangeDiff":
                    if (this.sessionId) {
                        await this.changeReviews.openDiff(this.sessionId, message.turn, message.fileId);
                    }
                    break;
                case "restoreTurnChanges":
                    if (this.selectedSessionRunning()) {
                        throw new Error(t("Wait for the current turn to finish before restoring changes."));
                    }
                    if (this.sessionId) await this.changeReviews.restore(this.sessionId, message.turn);
                    break;
                case "forkFromMessage":
                    await this.runCheckpointAction(() => this.forkFromMessage(message.seq));
                    break;
                case "restoreCodeToMessage":
                    await this.runCheckpointAction(() => this.restoreCodeToMessage(message.seq));
                    break;
                case "forkAndRestoreCodeToMessage":
                    await this.runCheckpointAction(() => this.forkAndRestoreCodeToMessage(message.seq));
                    break;
                case "toggleMessageFeedback":
                    await this.messageFeedback.toggleMessageFeedback(message.messageId, message.rating);
                    break;
                case "saveMessageFeedbackNote":
                    await this.messageFeedback.saveMessageFeedbackNote(message.messageId, message.note);
                    break;
                case "switchSession":
                    await this.switchSession(message.sessionId);
                    break;
                case "newSession":
                    await this.newSession();
                    break;
                case "newSessionInCurrentWorkspace":
                    await this.newSession(undefined, true);
                    break;
                case "searchSession":
                    await this.searchSession();
                    break;
                case "selectModel":
                    await this.selectModel();
                    break;
                case "selectReasoningEffort":
                    await this.selectReasoningEffort(message.effort);
                    break;
                case "openReasoningEffort":
                    await this.openReasoningEffort();
                    break;
                case "selectAgentPreset":
                    await this.selectAgentPreset(message.agentPreset);
                    break;
                case "renameSession":
                    await this.renameSession();
                    break;
                case "forkSession":
                    await this.forkSession();
                    break;
                case "archiveSession":
                    await this.archiveSession();
                    break;
                case "goalCreate":
                case "goalEdit":
                case "goalPause":
                case "goalResume":
                case "goalComplete":
                case "goalClear":
                    await this.mutateGoal(message);
                    break;
                case "refreshSubagents":
                    if (this.sessionId) await this.subagents.refreshSubagentTree(this.sessionId);
                    break;
                case "openSubagent":
                    await this.subagents.openSubagentHistory(message.childSessionId);
                    break;
                case "closeSubagent":
                    this.subagents.closeSubagentHistory();
                    break;
                case "followUpSubagent":
                    await this.subagents.followUpSubagent(message.childSessionId, message.text);
                    break;
                case "interruptSubagent":
                    await this.subagents.interruptSubagent(message.childSessionId);
                    break;
                case "answerApproval":
                    await this.answerApproval(message);
                    break;
                case "answerQuestion":
                    await this.answerQuestion(message);
                    break;
                case "updateQueue":
                    await this.updateQueue(message);
                    break;
                default:
                    break;
            }
        } catch (error) {
            this.reportError(error);
        }
    }

    private async updateFileReferenceCandidates(query: string, preserveQuote = false): Promise<void> {
        const generation = ++this.fileReferenceQueryGeneration;
        this.fileReferenceQueryAbort?.abort();
        const controller = new AbortController();
        this.fileReferenceQueryAbort = controller;
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const normalizedQuery = query.trim().replaceAll("\\", "/").toLowerCase();
        const filesPromise = workspaceFolder
            ? Promise.resolve(vscode.workspace.findFiles("**/*", "**/{.git,node_modules,.DS_Store}/**", 2_000))
                .catch(() => [] as vscode.Uri[])
            : Promise.resolve([] as vscode.Uri[]);
        const remoteSessionId = this.sessionId;
        const remoteEnabled = remoteSessionId !== undefined && this.runtime.getUrl() !== undefined;
        const optionalRemote = <T>(endpoint: string, request: Promise<T>): Promise<T | undefined> =>
            request.catch((error) => {
                if (!controller.signal.aborted) {
                    this.output.appendLine(
                        "[dsh:rpc] " + endpoint + " candidate lookup failed: " + errorMessage(error),
                    );
                }
                return undefined;
            });
        const remoteFilesPromise: Promise<DshFileReferenceCandidate[] | undefined> = remoteEnabled
            ? optionalRemote(
                  "fileReferences/list",
                  this.runtime.listFileReferences(remoteSessionId, query, controller.signal),
              )
            : Promise.resolve(undefined);
        let remoteSessionsPromise: Promise<DshSessionReferenceCandidate[] | undefined>;
        if (preserveQuote) {
            remoteSessionsPromise = Promise.resolve([]);
        } else if (remoteEnabled) {
            remoteSessionsPromise = optionalRemote(
                "sessionReferenceResolver/candidates",
                this.runtime.listSessionReferenceCandidates(remoteSessionId, query, controller.signal),
            );
        } else {
            remoteSessionsPromise = Promise.resolve(undefined);
        }
        const searchPromise: Promise<DshSessionSearchItem[]> = !preserveQuote && normalizedQuery && remoteEnabled
            ? this.runtime.searchSessions(query.trim(), controller.signal).then((result) => result.items).catch((error) => {
                  if (!controller.signal.aborted) {
                      this.output.appendLine(
                          "[dsh:rpc] session/search candidate lookup failed: " + errorMessage(error),
                      );
                  }
                  return [];
              })
            : Promise.resolve([]);

        try {
            const [uris, searchItems, remoteFiles, remoteSessions] = await Promise.all([
                filesPromise,
                searchPromise,
                remoteFilesPromise,
                remoteSessionsPromise,
            ]);
            if (generation !== this.fileReferenceQueryGeneration || controller.signal.aborted) return;

            const terminalCandidates = this.terminalContext.referenceCandidates(query);
            const active = vscode.window.activeTextEditor?.document.uri;
            const localFileCandidates = uris
                .map((uri) => vscode.workspace.asRelativePath(uri, false).replaceAll("\\", "/"))
                .filter((path) => !normalizedQuery || path.toLowerCase().includes(normalizedQuery))
                .map((path): DshReferenceCandidate | undefined => {
                    const candidate: DshFileReferenceCandidate = { kind: "file", path };
                    const presentation = referencePathPresentation(path, false);
                    const insertText = formatFileReferenceMention(candidate, preserveQuote);
                    if (!insertText) return undefined;
                    return {
                        kind: "file",
                        label: presentation.label,
                        insertText,
                        ...(presentation.parent === undefined ? {} : { description: presentation.parent }),
                    };
                })
                .filter((candidate): candidate is DshReferenceCandidate => candidate !== undefined);
            const activeRelative = active
                ? vscode.workspace.asRelativePath(active, false).replaceAll("\\", "/")
                : undefined;
            const activeInsertText = activeRelative === undefined
                ? undefined
                : formatFileReferenceMention({ kind: "file", path: activeRelative }, preserveQuote);
            const activeCandidate = activeRelative
                ? localFileCandidates.find((candidate) => candidate.insertText === activeInsertText)
                : undefined;
            const orderedLocalFiles = activeCandidate
                ? [
                      activeCandidate,
                      ...localFileCandidates.filter((candidate) => candidate !== activeCandidate),
                  ]
                : localFileCandidates;

            const remoteFileCandidates = remoteFiles?.map((candidate): DshReferenceCandidate | undefined => {
                const presentation = referencePathPresentation(
                    candidate.path,
                    candidate.kind === "directory",
                );
                const insertText = formatFileReferenceMention(candidate, preserveQuote);
                if (!insertText) return undefined;
                return {
                    kind: candidate.kind,
                    label: presentation.label,
                    insertText,
                    ...(presentation.parent === undefined ? {} : { description: presentation.parent }),
                };
            }).filter((candidate): candidate is DshReferenceCandidate => candidate !== undefined);
            const fileCandidates = remoteFileCandidates ?? orderedLocalFiles;

            const remoteById = new Map(searchItems.map((item) => [item.sessionId, item]));
            const sessionById = new Map<string, { sessionId: string; title?: string; cwd?: string; blank?: boolean }>();
            for (const session of this.runtime.getSessionCatalog().snapshot().sessions) {
                sessionById.set(session.sessionId, session);
            }
            for (const item of searchItems) {
                if (!sessionById.has(item.sessionId)) sessionById.set(item.sessionId, { sessionId: item.sessionId });
            }
            const localSessionCandidates = [...sessionById.values()]
                .filter((session) => session.blank !== true && session.sessionId !== this.sessionId)
                .filter((session) => {
                    if (!normalizedQuery) return true;
                    const remote = remoteById.get(session.sessionId);
                    const searchable = [session.sessionId, session.title, session.cwd, remote?.snippet]
                        .filter((part): part is string => typeof part === "string")
                        .join("\\n")
                        .toLowerCase();
                    return searchable.includes(normalizedQuery);
                })
                .map((session): DshReferenceCandidate => {
                    const label = session.title?.trim() || session.sessionId;
                    const remote = remoteById.get(session.sessionId);
                    const description = [
                        session.sessionId,
                        session.cwd,
                        remote?.snippet,
                    ].filter((part): part is string => typeof part === "string" && part.length > 0).join(" · ");
                    return {
                        kind: "session",
                        label,
                        insertText: formatSessionReferenceMention(session.sessionId, label),
                        ...(description ? { description } : {}),
                    };
                });
            const remoteSessionCandidates = remoteSessions
                ?.filter((candidate) => candidate.sessionId !== this.sessionId)
                .map((candidate): DshReferenceCandidate => {
                    const description = [
                        candidate.sameWorkspace ? undefined : "other workspace",
                        candidate.cwd,
                        candidate.sessionId,
                    ].filter((part): part is string => typeof part === "string" && part.length > 0).join(" · ");
                    return {
                        kind: "session",
                        label: candidate.label,
                        insertText: candidate.mention,
                        ...(description ? { description } : {}),
                    };
                });
            const sessionCandidates = remoteSessionCandidates ?? localSessionCandidates;
            this.fileReferenceCandidates = [...terminalCandidates, ...fileCandidates, ...sessionCandidates].slice(0, 40);
            this.postState();
        } finally {
            if (this.fileReferenceQueryAbort === controller) this.fileReferenceQueryAbort = undefined;
        }
    }

    private async sendPrompt(
        rawText: string,
        requestedMode: "queue" | "steer",
        requestedImages: readonly DshImageUpload[] = [],
    ): Promise<void> {
        const text = rawText.trim();
        if ((!text && requestedImages.length === 0) || this.submitting) {
            return;
        }

        // Do not let a disabled optional command fall through as ordinary model input.
        if (
            requestedImages.length === 0 && /^\/compact$/u.test(text) &&
            !vscode.workspace.getConfiguration("dsh").get<boolean>("enableCompaction", true)
        ) {
            this.reportError(new Error(t("The connected dsh server does not expose the /compact command. Update dsh or enable the command-compact package.")));
            return;
        }

        const workspaceRoot = this.workspaceRoot();
        if (!workspaceRoot) {
            this.reportError(new Error(t("Open a workspace before sending a task to dsh.")));
            return;
        }

        this.submitting = true;
        this.cancelRequested = false;
        this.postState();

        let optimistic: OptimisticPrompt | undefined;
        try {
            const autoStart = vscode.workspace.getConfiguration("dsh").get<boolean>("autoStart", true);
            if (autoStart || this.runtime.getUrl()) {
                await this.runtime.start(workspaceRoot);
            } else {
                throw new Error(t("dsh web is not running. Enable dsh.autoStart or run “DSH: Start dsh Web Runtime”."));
            }

            const session = await this.getOrCreateSession(workspaceRoot);
            if (requestedImages.length === 0 && /^\/ide(?:$|[\t\n\r ])/u.test(text)) {
                await this.openIdeContextPicker();
                return;
            }

            // A host command line is dispatched through the command registry,
            // never as model input, so it must stay the complete prompt: no
            // IDE context is appended and no optimistic user row is echoed
            // (the host logs the outcome instead of accepting a message).
            if (looksLikeCommandLine(text)) {
                await this.ensureCommandCatalog(session);
                if (this.hostCommandName(session, text) !== undefined) {
                    await this.runHostCommand(session, text, requestedImages);
                    return;
                }
            }

            const terminalReferences = this.terminalContext.resolvePromptReferences(text);
            if (terminalReferences.missing.length > 0) {
                throw new Error(t("No captured terminal command matches: {selectors}", {
                    selectors: terminalReferences.missing.map((selector) => `@terminal:${selector}`).join(", "),
                }));
            }
            for (const command of terminalReferences.commands) {
                this.contextStore.addTerminalCommand(command);
            }
            const promptText = terminalReferences.text;
            const explicitlyReferencesSelection = referencesSelection(text);
            const capture = this.contextStore.capturePromptContext({
                includeCurrentSelection:
                    this.selectionEnabled || explicitlyReferencesSelection,
            });
            if (explicitlyReferencesSelection && !capture.items.some((item) => item.kind === "selection")) {
                throw new Error(t("@selection has no current selection. Select text in the active editor first."));
            }
            const prompt = capture.text ? `${promptText}\n\n${capture.text}` : promptText;
            let limits = imageLimitsProjection(
                this.runtime.getSessionStore().get(session)?.projections
                    .find((cell) => cell.key === "imageLimits")?.value,
            );
            if (requestedImages.length > 0 && !limits) {
                await this.runtime.syncSession(session);
                limits = imageLimitsProjection(
                    this.runtime.getSessionStore().get(session)?.projections
                        .find((cell) => cell.key === "imageLimits")?.value,
                );
            }
            if (requestedImages.length > 0 && !limits) {
                throw new Error(t("The connected Harness does not expose image attachment support."));
            }
            const prepared = requestedImages.length > 0
                ? prepareImageUploads(requestedImages, limits as DshImageLimitsView)
                : { uploads: [], views: [] };
            optimistic = {
                id: `optimistic:${randomUUID()}`,
                sessionId: session,
                requestId: randomUUID(),
                displayText: text,
                wireText: prompt,
                ...(prepared.views.length === 0 ? {} : { images: prepared.views }),
                ...(prepared.uploads.length === 0 ? {} : { imageUploads: prepared.uploads }),
                afterSeq: highestKnownSeq(this.runtime.getSessionStore().get(session)),
                createdAt: Date.now(),
            };
            this.optimisticPrompts.push(optimistic);
            this.postState();
            const mode = resolvePromptMode(requestedMode, this.selectedSessionRunning());
            const promptResult = await this.runtime.prompt(
                session,
                prompt,
                mode,
                prepared.uploads,
                optimistic.requestId,
            );
            if (promptResult.accepted === false) {
                throw new Error(t("The dsh runtime rejected this prompt. Check the current model and API Key configuration."));
            }
            this.contextStore.consumeCapturedOneShots(capture.capturedOneShotIds);
        } catch (error) {
            if (optimistic) {
                optimistic.error = errorMessage(error);
            }
            if (!this.cancelRequested) {
                this.reportError(error);
            }
        } finally {
            this.submitting = false;
            this.cancelRequested = false;
            this.postState();
        }
    }

    /** Sends a prompt originating from the VS Code Chat Participant. */
    public async sendParticipantPrompt(text: string, token?: vscode.CancellationToken): Promise<void> {
        if (token?.isCancellationRequested) return;
        await this.sendPrompt(text, "queue");
    }

    private async retryPrompt(id: string): Promise<void> {
        if (this.submitting || !this.sessionId) return;
        const optimistic = this.optimisticPrompts.find(
            (item) => item.id === id && item.sessionId === this.sessionId && item.error !== undefined,
        );
        if (!optimistic) return;
        this.submitting = true;
        optimistic.error = undefined;
        optimistic.afterSeq = highestKnownSeq(this.runtime.getSessionStore().get(this.sessionId));
        optimistic.createdAt = Date.now();
        this.postState();
        try {
            const result = await this.runtime.prompt(
                this.sessionId,
                optimistic.wireText,
                "queue",
                optimistic.imageUploads ?? [],
                optimistic.requestId,
            );
            if (result.accepted === false) throw new Error(t("The dsh runtime rejected this retry."));
        } catch (error) {
            optimistic.error = errorMessage(error);
            this.reportError(error);
        } finally {
            this.submitting = false;
            this.postState();
        }
    }

    private async cancel(): Promise<void> {
        if (!this.sessionId || !this.selectedSessionRunning()) {
            return;
        }

        this.cancelRequested = true;
        try {
            await this.runtime.cancel(this.sessionId);
        } catch (error) {
            this.output.appendLine(`[dsh] cancel failed: ${errorMessage(error)}`);
        }
        this.postState();
    }

    private async getOrCreateSession(workspaceRoot: string): Promise<string> {
        const configuration = vscode.workspace.getConfiguration("dsh");
        const persist = configuration.get<boolean>("persistSession", true);
        if (!this.newSessionDraft) {
            await this.restorePersistedSession(workspaceRoot);
        }

        // The selected DSH Session may belong to a different DSH Workspace than
        // the folder currently open in VS Code. Once a Session is explicitly
        // selected, keep using it; the VS Code folder only determines which
        // Session is restored or created when there is no current selection.
        if (!this.sessionId) {
            const workspace = this.pendingNewSessionWorkspaceId
                ? {
                      workspace: {
                          workspaceId: this.pendingNewSessionWorkspaceId,
                      },
                  }
                : await this.runtime.createWorkspace(workspaceRoot);
            const created = await this.runtime.createSession(
                undefined,
                this.pendingNewSessionPreset,
                workspace.workspace.workspaceId,
            );
            if (this.sessionId !== created.sessionId) this.subagents.discardSubagentPreview();
            this.sessionId = created.sessionId;
            this.sessionCwd = this.pendingNewSessionWorkspacePath ?? workspaceRoot;
            if (persist) {
                await this.extensionContext.workspaceState.update("session", {
                    sessionId: created.sessionId,
                    cwd: workspaceRoot,
                } satisfies PersistedSession);
            }
            void this.subagents.refreshSubagentTree(created.sessionId);
            this.newSessionDraft = false;
            this.clearNewSessionDraft();
        }

        this.refreshModelCatalog(this.sessionId);
        this.refreshSkillCatalog(this.sessionId);
        this.refreshCommandCatalog(this.sessionId);
        return this.sessionId;
    }

    private restorePersistedSession(workspaceRoot: string | undefined): Promise<void> {
        if (!workspaceRoot || this.newSessionDraft) {
            return Promise.resolve();
        }
        if (this.restoringPersistedSession) {
            return this.restoringPersistedSession;
        }
        if (this.sessionId) {
            return Promise.resolve();
        }

        const restore = this.restorePersistedSessionInternal(workspaceRoot).finally(() => {
            if (this.restoringPersistedSession === restore) {
                this.restoringPersistedSession = undefined;
            }
        });
        this.restoringPersistedSession = restore;
        return restore;
    }

    private async restorePersistedSessionInternal(workspaceRoot: string): Promise<void> {
        const persist = vscode.workspace.getConfiguration("dsh").get<boolean>("persistSession", true);
        const persisted = this.extensionContext.workspaceState.get<PersistedSession>("session");
        const candidates = [
            ...(persisted?.cwd === workspaceRoot ? [persisted.sessionId] : []),
            ...this.runtime
                .getSessionCatalog()
                .sessionsForWorkspace(workspaceRoot)
                .map((session) => session.sessionId),
        ].filter((sessionId, index, all) => all.indexOf(sessionId) === index);
        const sessionId = candidates[0];
        if (!sessionId) {
            return;
        }

        try {
            await this.runtime.history(sessionId, 1);
            if (this.sessionId) {
                return;
            }
            this.sessionId = sessionId;
            this.sessionCwd = workspaceRoot;
            if (persist) {
                await this.extensionContext.workspaceState.update("session", {
                    sessionId,
                    cwd: workspaceRoot,
                } satisfies PersistedSession);
            }
            this.postState();
            await this.runtime.syncSession(sessionId);
            this.refreshModelCatalog(sessionId);
            this.refreshSkillCatalog(sessionId);
            this.refreshCommandCatalog(sessionId);
        } catch (error) {
            const latest = this.extensionContext.workspaceState.get<PersistedSession>("session");
            if (latest?.sessionId === sessionId && latest.cwd === workspaceRoot) {
                await this.extensionContext.workspaceState.update("session", undefined);
            }
            this.output.appendLine(
                `[dsh] workspace session ${sessionId} could not be restored: ${errorMessage(error)}`,
            );
        }
    }

    public async newSession(agentPreset?: string, useCurrentWorkspace = false): Promise<void> {
        const workspaceRoot = this.workspaceRoot();
        if (!workspaceRoot) throw new Error(t("Open a workspace first."));
        await this.runtime.start(workspaceRoot);
        const catalog = this.runtime.getSessionCatalog().snapshot();
        const selectedWorkspace = useCurrentWorkspace
            ? (await this.runtime.createWorkspace(workspaceRoot)).workspace
            : this.sessionId
                ? catalog.workspaces.find((workspace) => workspace.sessionIds.includes(this.sessionId as string))
                : undefined;
        this.pendingNewSessionSkills = this.sessionId && selectedWorkspace?.sessionIds.includes(this.sessionId)
            ? this.skillCatalogs.get(this.sessionId)
            : undefined;
        this.sessionId = undefined;
        this.sessionCwd = undefined;
        this.newSessionDraft = true;
        this.pendingNewSessionPreset = agentPreset;
        this.pendingNewSessionWorkspaceId = selectedWorkspace?.workspaceId;
        this.pendingNewSessionWorkspacePath = selectedWorkspace?.path;
        this.pendingNewSessionWorkspaceTitle = selectedWorkspace?.title;
        this.optimisticPrompts.length = 0;
        this.cancelRequested = false;
        this.subagents.discardSubagentPreview();
        await this.extensionContext.workspaceState.update("session", undefined);
        this.postState();
        this.reveal();
    }

    public async searchSession(): Promise<void> {
        await this.runtime.start(this.workspaceRoot());
        const query = await vscode.window.showInputBox({
            title: t("Search dsh sessions"),
            prompt: t("Search session message content"),
            ignoreFocusOut: true,
            validateInput: (value) => (value.trim() ? undefined : t("Enter a search query.")),
        });
        if (query === undefined) return;
        const result = await this.runtime.searchSessions(query.trim());
        const catalog = this.runtime.getSessionCatalog().snapshot();
        const choice = await vscode.window.showQuickPick(
            result.items.map((item) => {
                const session = catalog.sessions.find((candidate) => candidate.sessionId === item.sessionId);
                return {
                    label: session?.title || item.sessionId,
                    description: item.sessionId,
                    detail: item.snippet,
                    sessionId: item.sessionId,
                };
            }),
            {
                placeHolder: result.hasMore ? t("Select a session (results truncated)") : t("Select a session"),
                matchOnDescription: true,
                matchOnDetail: true,
            },
        );
        if (choice) await this.switchSession(choice.sessionId);
    }

    public async selectModel(): Promise<void> {
        const workspaceRoot = this.workspaceRoot();
        if (!workspaceRoot) throw new Error(t("Open a workspace first."));
        if (!this.runtime.getUrl()) await this.runtime.start(workspaceRoot);

        // Model selection is also a valid first action. The Harness model
        // catalog is session-scoped, so materialize the pending/new session
        // before requesting it instead of rejecting the command outright.
        const sessionId = this.sessionId ?? await this.getOrCreateSession(workspaceRoot);
        const catalog = await this.runtime.models(sessionId);
        this.modelCatalogs.set(sessionId, catalog);
        const currentEfforts = reasoningEffortOptions(
            catalog,
            catalog.current.provider,
            catalog.current.model,
        );
        this.selectedModels.set(sessionId, {
            selection: catalog.current,
            asOfSeq: highestKnownSeq(this.runtime.getSessionStore().get(sessionId)),
            reasoningEfforts: currentEfforts,
        });
        this.schedulePostState();
        if (!catalog.routable) {
            throw new Error(t("The current session has no routable model."));
        }
        const items = catalog.groups.flatMap((group) => group.models.map((model) => {
            const provider = group.id;
            return {
                label: `${group.name || provider} / ${model.name || model.id}`,
                description: provider === catalog.current.provider && model.id === catalog.current.model
                    ? t("Current model")
                    : model.id,
                provider,
                model: model.id,
                efforts: reasoningEffortOptions(catalog, provider, model.id),
            };
        }));
        if (items.length === 0) throw new Error(t("Harness returned no available models."));
        const picked = await vscode.window.showQuickPick(items, {
            title: t("Select Harness model"),
            placeHolder: `${catalog.current.provider} / ${catalog.current.model}`,
        });
        if (!picked) return;
        let reasoningEffort: string | undefined;
        if (picked.efforts.length > 0) {
            const effort = await vscode.window.showQuickPick(picked.efforts.map((option) => option.id), {
                title: t("Select reasoning effort"),
                placeHolder: catalog.current.reasoningEffort ?? t("Default"),
            });
            if (effort === undefined) return;
            reasoningEffort = effort;
        }
        const result = await this.runtime.selectModel({
            sessionId,
            provider: picked.provider,
            model: picked.model,
            ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        });
        const selectedEfforts = reasoningEffortOptions(catalog, picked.provider, picked.model);
        this.selectedModels.set(sessionId, {
            selection: result.selected,
            asOfSeq: highestKnownSeq(this.runtime.getSessionStore().get(sessionId)),
            reasoningEfforts: selectedEfforts,
        });
        this.modelCatalogs.set(sessionId, {
            ...catalog,
            current: result.selected,
        });
        this.output.appendLine(`[dsh:model] selected ${result.selected.provider}/${result.selected.model}`);
        this.postState();
    }

    private async selectReasoningEffort(effort: string): Promise<void> {
        const sessionId = this.sessionId;
        if (!sessionId) throw new Error(t("There is no current session."));
        if (!this.runtime.getUrl()) await this.runtime.start(this.workspaceRoot());
        const catalog = this.modelCatalogs.get(sessionId) ?? await this.runtime.models(sessionId);
        this.modelCatalogs.set(sessionId, catalog);
        const current = catalog.current;
        const options = reasoningEffortOptions(catalog, current.provider, current.model);
        const selected = options.find((option) => option.id === effort);
        if (!selected) {
            throw new Error(t("The selected reasoning effort is not available for the current model."));
        }
        const result = await this.runtime.selectModel({
            sessionId,
            provider: current.provider,
            model: current.model,
            reasoningEffort: selected.id,
        });
        this.selectedModels.set(sessionId, {
            selection: result.selected,
            asOfSeq: highestKnownSeq(this.runtime.getSessionStore().get(sessionId)),
            reasoningEfforts: options,
        });
        this.modelCatalogs.set(sessionId, {
            ...catalog,
            current: result.selected,
        });
        this.postState();
    }

    private async openReasoningEffort(): Promise<void> {
        const workspaceRoot = this.workspaceRoot();
        if (!workspaceRoot) throw new Error(t("Open a workspace first."));
        if (!this.runtime.getUrl()) await this.runtime.start(workspaceRoot);
        const sessionId = this.sessionId ?? await this.getOrCreateSession(workspaceRoot);
        const catalog = this.modelCatalogs.get(sessionId) ?? await this.runtime.models(sessionId);
        this.modelCatalogs.set(sessionId, catalog);
        const options = reasoningEffortOptions(catalog, catalog.current.provider, catalog.current.model);
        if (options.length === 0) {
            throw new Error(t("The current model does not expose reasoning effort options."));
        }
        this.selectedModels.set(sessionId, {
            selection: catalog.current,
            asOfSeq: highestKnownSeq(this.runtime.getSessionStore().get(sessionId)),
            reasoningEfforts: options,
        });
        this.postState();
    }

    public async selectAgentPreset(requestedPreset?: string): Promise<void> {
        const workspaceRoot = this.workspaceRoot();
        if (!workspaceRoot) throw new Error(t("Open a workspace first."));
        if (!this.runtime.getUrl()) await this.runtime.start(workspaceRoot);
        // The initial empty view has no Session id yet. Give persisted state a
        // chance to restore before treating the mode choice as a new-session
        // draft, otherwise a quick first `/mode` could strand the saved Session.
        await this.restorePersistedSession(workspaceRoot);
        const catalog = await this.runtime.agentPresets();
        this.agentPresetCatalog = catalog.presets;
        const available = catalog.presets.filter((preset) => !preset.broken);
        if (available.length === 0) throw new Error(t("Harness returned no available agent modes."));

        let target = requestedPreset
            ? available.find((preset) => preset.id === requestedPreset)
            : undefined;
        if (requestedPreset && !target) {
            throw new Error(t("Agent mode “{preset}” does not exist. Available modes: {available}.", {
                preset: requestedPreset,
                available: available.map((preset) => preset.id).join(", "),
            }));
        }
        if (!target) {
            const current = this.newSessionDraft
                ? this.pendingNewSessionPreset
                : this.runtime.getSessionCatalog().snapshot().sessions
                    .find((session) => session.sessionId === this.sessionId)?.agentPreset;
            target = await vscode.window.showQuickPick(
                available.map((preset) => ({
                    label: preset.name || preset.id,
                    description: preset.id === current ? t("Current mode") : preset.id,
                    detail: preset.description,
                    preset,
                })),
                { title: t("Select Harness agent mode"), placeHolder: current || t("Select mode") },
            ).then((picked) => picked?.preset);
        }
        if (!target) return;

        // A mode can be chosen before the first prompt. Keep it in the same
        // draft used by the explicit New Session action; the actual Session is
        // created on first send with this preset in its creation request.
        if (!this.sessionId && !this.newSessionDraft) {
            await this.newSession(target.id);
            return;
        }

        if (this.newSessionDraft && !this.sessionId) {
            this.pendingNewSessionPreset = target.id;
            this.pendingNewSessionSkills = undefined;
            this.output.appendLine(`[dsh:agent-preset] selected ${target.id} for new session`);
            this.postState();
            return;
        }

        const sessionId = this.sessionId;
        if (!sessionId) throw new Error(t("There is no current session."));
        const currentSession = this.runtime.getSessionCatalog().snapshot().sessions
            .find((session) => session.sessionId === sessionId);
        if (currentSession?.blank === false) {
            const createWithMode = t("Create a session with {mode}", { mode: target.name || target.id });
            const choice = await vscode.window.showWarningMessage(
                t("The current session has already started, so its agent mode cannot be changed."),
                createWithMode,
            );
            if (choice) await this.newSession(target.id);
            return;
        }

        let result;
        try {
            result = await this.runtime.selectAgentPreset(sessionId, target.id);
        } catch (error) {
            if (!isRemoteError(error) || !/(?:^|\/)locked$/u.test(error.code)) {
                throw error;
            }
            const createWithMode = t("Create a session with {mode}", { mode: target.name || target.id });
            const choice = await vscode.window.showWarningMessage(
                t("The current session has already started, so its agent mode cannot be changed."),
                createWithMode,
            );
            if (choice) await this.newSession(target.id);
            return;
        }
        this.output.appendLine(`[dsh:agent-preset] selected ${result.agentPreset}`);
        this.skillCatalogs.delete(sessionId);
        this.refreshSkillCatalog(sessionId);
        // Recomposing the agent re-decides both catalogs this session serves.
        this.commandCatalogs.delete(sessionId);
        this.refreshCommandCatalog(sessionId);
        await this.runtime.refreshSessions();
        this.postState();
    }

    public async chooseSession(): Promise<void> {
        await this.runtime.start(this.workspaceRoot());
        const catalog = this.runtime.getSessionCatalog().snapshot();
        const archived = new Set(catalog.archivedSessionIds);
        const choice = await vscode.window.showQuickPick(
            catalog.sessions
                .filter((item) => !archived.has(item.sessionId))
                .map((item) => ({
                    label: `${item.running ? "$(sync~spin)" : "$(comment-discussion)"} ${item.title || item.sessionId}`,
                    description: item.sessionId,
                    detail: item.cwd,
                    sessionId: item.sessionId,
                })),
            { placeHolder: t("Select a dsh session"), matchOnDescription: true, matchOnDetail: true },
        );
        if (choice) await this.switchSession(choice.sessionId);
    }

    public async renameSession(): Promise<void> {
        if (!this.sessionId) throw new Error(t("There is no current session."));
        const current = this.runtime
            .getSessionCatalog()
            .snapshot()
            .sessions.find((item) => item.sessionId === this.sessionId);
        const title = await vscode.window.showInputBox({
            title: t("Rename dsh session"),
            value: current?.title ?? "",
            ignoreFocusOut: true,
            validateInput: (value) => (value.trim() ? undefined : t("The title cannot be empty.")),
        });
        if (title === undefined) return;
        await this.runtime.renameSession(this.sessionId, title);
    }

    public async forkSession(atSeq?: number): Promise<void> {
        if (!this.sessionId) throw new Error(t("There is no current session."));
        const forked = await this.runtime.forkSession(this.sessionId, atSeq);
        await this.switchSession(forked.sessionId);
    }

    private checkpointMessage(seq: number): { sessionId: string; turn?: number } {
        const sessionId = this.sessionId;
        if (!sessionId) throw new Error(t("There is no current session."));
        const snapshot = this.runtime.getSessionStore().get(sessionId);
        const message = snapshot?.events.find((stored) => stored.event.seq === seq);
        const surfaceMessage = snapshot?.surface.nodes.find((node) => node.seq === seq);
        const messageData = isRecord(message?.event.data) ? message.event.data : undefined;
        const userSource = isRecord(messageData?.source) ? messageData.source : undefined;
        if (
            !snapshot ||
            !message ||
            !surfaceMessage ||
            !isCheckpointMessageType(message.event.type) ||
            (message.event.type === "user/message" && userSource?.kind !== "user")
        ) {
            throw new Error(t("This message is no longer available."));
        }
        return {
            sessionId,
            turn: checkpointMessageTurn(snapshot, seq),
        };
    }

    private async forkFromMessage(seq: number): Promise<void> {
        const checkpoint = this.checkpointMessage(seq);
        const forked = await this.runtime.forkSession(checkpoint.sessionId, seq);
        await this.switchSession(forked.sessionId);
    }

    private async runCheckpointAction(action: () => Promise<void>): Promise<void> {
        if (this.checkpointActionInFlight) return;
        this.checkpointActionInFlight = true;
        try {
            await action();
        } finally {
            this.checkpointActionInFlight = false;
        }
    }

    private async restoreCodeToMessage(seq: number): Promise<void> {
        if (this.selectedSessionRunning()) {
            throw new Error(t("Wait for the current turn to finish before restoring changes."));
        }
        const checkpoint = this.checkpointMessage(seq);
        if (checkpoint.turn === undefined) {
            throw new Error(t("This message is not associated with a turn."));
        }
        await this.changeReviews.restore(checkpoint.sessionId, checkpoint.turn);
    }

    private async forkAndRestoreCodeToMessage(seq: number): Promise<void> {
        if (this.selectedSessionRunning()) {
            throw new Error(t("Wait for the current turn to finish before restoring changes."));
        }
        const checkpoint = this.checkpointMessage(seq);
        if (checkpoint.turn === undefined) {
            throw new Error(t("This message is not associated with a turn."));
        }

        // Restore first so cancelling the confirmation does not leave behind a
        // fork that did not receive the requested code rewind.
        const restored = await this.changeReviews.restore(checkpoint.sessionId, checkpoint.turn);
        if (!restored) return;
        let forked;
        try {
            forked = await this.runtime.forkSession(checkpoint.sessionId, seq);
        } catch (error) {
            // The restore already landed on disk and cannot be undone from here,
            // so the failure has to name the half that did succeed.
            throw new Error(t("Code was restored to this message, but forking the session failed: {message}", {
                message: errorMessage(error),
            }));
        }
        await this.switchSession(forked.sessionId);
    }

    public async archiveSession(): Promise<void> {
        if (!this.sessionId) throw new Error(t("There is no current session."));
        const archiveAction = t("Archive");
        const confirmation = await vscode.window.showWarningMessage(
            t("Archive the current session and hide it from the DSH IDE session list? Archived sessions can be managed in the official dsh Web UI."),
            { modal: true },
            archiveAction,
        );
        if (confirmation !== archiveAction) return;
        const archived = this.sessionId;
        await this.runtime.archiveSession(archived);
        const next = this.runtime
            .getSessionCatalog()
            .snapshot()
            .sessions.find(
                (item) =>
                    item.sessionId !== archived &&
                    !this.runtime.getSessionCatalog().snapshot().archivedSessionIds.includes(item.sessionId),
            );
        this.sessionId = undefined;
        this.sessionCwd = undefined;
        this.subagents.discardSubagentPreview();
        await this.extensionContext.workspaceState.update("session", undefined);
        if (next) await this.switchSession(next.sessionId);
        this.postState();
    }

    private async switchSession(sessionId: string): Promise<void> {
        const catalog = this.runtime.getSessionCatalog().snapshot();
        const session = catalog.sessions.find((item) => item.sessionId === sessionId);
        if (this.sessionId !== sessionId) this.subagents.discardSubagentPreview();
        this.sessionId = sessionId;
        this.sessionCwd = session?.cwd ?? this.workspaceRoot();
        this.newSessionDraft = false;
        this.clearNewSessionDraft();
        if (vscode.workspace.getConfiguration("dsh").get<boolean>("persistSession", true)) {
            await this.extensionContext.workspaceState.update("session", {
                sessionId,
                cwd: this.sessionCwd ?? "",
            } satisfies PersistedSession);
        }
        await this.runtime.syncSession(sessionId);
        this.refreshModelCatalog(sessionId);
        this.refreshSkillCatalog(sessionId);
        this.refreshCommandCatalog(sessionId);
        void this.subagents.refreshSubagentTree(sessionId);
        this.reveal();
    }

    /**
     * Records a Harness ref acknowledgement, failing closed when the ref is
     * malformed so the HUD never advances past an unconfirmed mutation.
     *
     * @param method - the RPC name, used verbatim in the diagnostic.
     */
    private acknowledgeGoalRef(
        sessionId: string,
        method: string,
        result: { ref: unknown },
    ): void {
        const ref = normalizeGoalRef(result.ref);
        if (!ref) {
            throw new Error(t("Harness returned an invalid {method} ref.", { method }));
        }
        this.goalMutations.acknowledgeRef(sessionId, ref);
    }

    private async mutateGoal(action: ChatViewAction): Promise<void> {
        const sessionId = this.sessionId;
        if (!sessionId) return;
        const goalCell = projectionCell(this.runtime.getSessionStore().get(sessionId), "goal");
        if (!goalCell) {
            throw new Error(t("The current Harness does not provide a goal projection, so the Goal HUD remains hidden."));
        }
        const parsed = parseGoalProjection(goalCell.value);
        if (!parsed.ok) throw new Error(parsed.error);

        const operation = goalOperationFor(action.type);
        if (!operation || !this.goalMutations.claim(sessionId, operation, goalCell.seq)) return;
        this.postState();

        try {
            if (action.type === "goalCreate") {
                if (parsed.value !== null && !goalActionAllowed(
                    parsed.value.goal.phase,
                    operation,
                    parsed.value.roundsStarted,
                    parsed.value.goal.maxGoalRounds,
                )) {
                    throw new Error(t("A replacement Goal can only be created when the current Goal is empty or complete."));
                }
                const result = await this.runtime.createGoal(
                    sessionId,
                    action.objective,
                    action.maxGoalRounds,
                );
                this.acknowledgeGoalRef(sessionId, "goal.create", result);
            } else {
                if (parsed.value === null) throw new Error(t("The current session has no actionable Goal."));
                const ref = {
                    id: parsed.value.goal.id,
                    revision: parsed.value.goal.revision,
                };
                if (!goalActionAllowed(
                    parsed.value.goal.phase,
                    operation,
                    parsed.value.roundsStarted,
                    parsed.value.goal.maxGoalRounds,
                )) {
                    if (operation === "resume" && parsed.value.roundsStarted >= parsed.value.goal.maxGoalRounds) {
                        throw new Error(t("Goal has reached its maximum rounds and cannot be resumed."));
                    }
                    throw new Error(t("That Goal action is not available in the current phase."));
                }
                if (action.type === "goalEdit") {
                    const result = await this.runtime.editGoal(
                        sessionId,
                        ref,
                        action.objective !== undefined
                            ? {
                                  objective: action.objective,
                                  ...(action.maxGoalRounds === undefined
                                      ? {}
                                      : { maxGoalRounds: action.maxGoalRounds }),
                              }
                            : { maxGoalRounds: action.maxGoalRounds },
                    );
                    this.acknowledgeGoalRef(sessionId, "goal.edit", result);
                } else if (
                    action.type === "goalPause" ||
                    action.type === "goalResume" ||
                    action.type === "goalComplete"
                ) {
                    // These three differ only in which RPC they call.
                    const call = {
                        goalPause: ["goal.pause", this.runtime.pauseGoal] as const,
                        goalResume: ["goal.resume", this.runtime.resumeGoal] as const,
                        goalComplete: ["goal.complete", this.runtime.completeGoal] as const,
                    }[action.type];
                    const result = await call[1].call(this.runtime, sessionId, ref);
                    this.acknowledgeGoalRef(sessionId, call[0], result);
                } else if (action.type === "goalClear") {
                    const result = await this.runtime.clearGoal(sessionId, ref);
                    if (result.cleared !== true) {
                        throw new Error(t("Harness returned an invalid goal.clear acknowledgement."));
                    }
                    this.goalMutations.acknowledgeClear(sessionId);
                }
            }
            const latestGoalCell = projectionCell(this.runtime.getSessionStore().get(sessionId), "goal");
            this.goalMutations.observe(sessionId, latestGoalCell);
        } catch (error) {
            this.goalMutations.fail(sessionId, goalErrorForHud(error, operation));
            throw error;
        } finally {
            this.postState();
        }
    }

    private async answerApproval(
        action: Extract<ChatViewAction, { type: "answerApproval" }>,
    ): Promise<void> {
        const sessionId = this.sessionId;
        if (!sessionId) return;
        const interaction = this.runtime.getSessionStore().claimInteraction(sessionId, action.key);
        if (!interaction || interaction.kind !== "approval") return;
        try {
            await this.runtime.respondRemoteEvent(interaction.rpcId, {
                kind: "result",
                value: action.outcome,
            });
            this.runtime.getSessionStore().settleRemoteInteraction(sessionId, action.key);
        } catch (error) {
            this.runtime
                .getSessionStore()
                .failInteraction(sessionId, action.key, errorMessage(error));
            this.reportError(error);
        }
    }

    private async answerQuestion(
        action: Extract<ChatViewAction, { type: "answerQuestion" }>,
    ): Promise<void> {
        const sessionId = this.sessionId;
        if (!sessionId) return;
        const current = this.runtime
            .getSessionStore()
            .get(sessionId)
            ?.interactions.find((item) => item.key === action.key);
        if (!current || current.kind !== "question" || current.status !== "pending") return;
        const invalid = validateQuestionAnswers(current.questions, action.answers);
        if (invalid) throw new Error(t("{message} Sending was refused.", { message: invalid }));
        const interaction = this.runtime.getSessionStore().claimInteraction(sessionId, action.key);
        if (!interaction || interaction.kind !== "question") return;
        try {
            await this.runtime.respondRemoteEvent(interaction.rpcId, {
                kind: "result",
                value: { answers: action.answers },
            });
            this.runtime.getSessionStore().settleRemoteInteraction(sessionId, action.key);
        } catch (error) {
            this.runtime
                .getSessionStore()
                .failInteraction(sessionId, action.key, errorMessage(error));
            this.reportError(error);
        }
    }

    private async updateQueue(
        action: Extract<ChatViewAction, { type: "updateQueue" }>,
    ): Promise<void> {
        const sessionId = this.sessionId;
        if (!sessionId) return;
        const item = this.runtime
            .getSessionStore()
            .get(sessionId)
            ?.queue.items.find((candidate) => candidate.id === action.itemId);
        if (!item || item.placement === "context") return;
        const dockItem = queueDockItems([item])[0];
        await this.runtime.updateQueue(
            sessionId,
            action.itemId,
            action.action === "edit"
                ? { kind: "edit", content: [{ type: "text", text: action.text ?? "" }] }
                : { kind: action.action },
        );
        if (dockItem?.editableText !== undefined) {
            let optimisticIndex = -1;
            for (let index = this.optimisticPrompts.length - 1; index >= 0; index -= 1) {
                const candidate = this.optimisticPrompts[index];
                if (
                    candidate?.sessionId === sessionId &&
                    candidate.wireText === dockItem.editableText
                ) {
                    optimisticIndex = index;
                    break;
                }
            }
            const optimistic = this.optimisticPrompts[optimisticIndex];
            if (optimistic && action.action === "edit" && action.text !== undefined) {
                optimistic.wireText = action.text;
                optimistic.displayText = promptDisplayText(action.text);
            } else if (optimisticIndex >= 0 && action.action === "remove") {
                this.optimisticPrompts.splice(optimisticIndex, 1);
            }
            this.postState();
        }
    }

    private selectedSessionRunning(): boolean {
        if (!this.sessionId) return false;
        return this.runtime
            .getSessionCatalog()
            .snapshot()
            .sessions.find((item) => item.sessionId === this.sessionId)?.running === true;
    }

    private async runContextAction(
        action: () => unknown | Promise<unknown>,
    ): Promise<void> {
        try {
            await action();
            this.reveal();
        } catch (error) {
            this.reportError(error);
        }
    }

    private reportError(error: unknown): void {
        const message = errorMessage(error);
        this.output.appendLine(`[dsh] ${message}`);
        if (isCredentialIssue(error)) {
            const configureKeyAction = t("Configure API Key");
            const openWebUiAction = t("Open dsh Web UI");
            void vscode.window
                .showErrorMessage(`DSH: ${message}`, configureKeyAction, openWebUiAction)
                .then((action) => {
                    if (action === configureKeyAction) {
                        void this.configureApiKey().catch((configureError) =>
                            this.reportError(configureError),
                        );
                    } else if (action === openWebUiAction) {
                        void this.openBrowser().catch((openError) => this.reportError(openError));
                    }
                });
        } else {
            void vscode.window.showErrorMessage(`DSH: ${message}`);
        }
        this.postState();
    }

    /**
     * Drops every field pinned by a pending New Session draft. They are always
     * set and cleared as one unit — a draft naming a Workspace that no longer
     * exists, or a Preset that was deleted, would otherwise create a session
     * against a dead reference.
     */
    private clearNewSessionDraft(): void {
        this.pendingNewSessionPreset = undefined;
        this.clearNewSessionWorkspace();
    }

    /**
     * Drops only the Workspace a draft is pinned to, and the skills carried
     * over from it. A chosen agent mode is an independent decision and
     * deliberately survives: losing the Workspace should not silently reset it.
     */
    private clearNewSessionWorkspace(): void {
        this.pendingNewSessionWorkspaceId = undefined;
        this.pendingNewSessionWorkspacePath = undefined;
        this.pendingNewSessionWorkspaceTitle = undefined;
        this.pendingNewSessionSkills = undefined;
    }

    /**
     * Names in the current session's skill catalog, for recognizing a direct
     * `/name` invocation in a prompt. Empty before the catalog arrives, which
     * only means such a message renders as plain text until it does.
     */
    private sessionSkillNames(): ReadonlySet<string> {
        const skills = this.sessionId
            ? this.skillCatalogs.get(this.sessionId)
            : this.pendingNewSessionSkills;
        return new Set((skills ?? []).map((skill) => skill.name));
    }

    private workspaceRoot(): string | undefined {
        return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    }

    /**
     * Keep the visible model route aligned with the authoritative RC
     * modelSelection projection.  A model can be changed by another client or
     * by an agent, so waiting for the next local selectModel action leaves the
     * status bar and reasoning-effort control stale.
     */
    private observeModelSelection(
        sessionId: string,
        snapshot: SessionStateSnapshot,
    ): void {
        const cell = projectionCell(snapshot, "modelSelection");
        if (!cell || this.modelSelectionProjectionSeqs.get(sessionId) === cell.seq) return;
        this.modelSelectionProjectionSeqs.set(sessionId, cell.seq);

        const selection = normalizeModelSelectionProjection(cell.value);
        if (!selection) return;

        const catalog = this.modelCatalogs.get(sessionId);
        const reasoningEfforts = catalog
            ? reasoningEffortOptions(catalog, selection.provider, selection.model)
            : undefined;
        const previous = this.selectedModels.get(sessionId);
        this.selectedModels.set(sessionId, {
            selection,
            asOfSeq: cell.seq,
            ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
        });
        if (catalog && !sameModelSelection(catalog.current, selection)) {
            this.modelCatalogs.set(sessionId, { ...catalog, current: selection });
        }
        if (!previous ||
            !sameModelSelection(previous.selection, selection) ||
            previous.asOfSeq !== cell.seq ||
            (reasoningEfforts !== undefined &&
                JSON.stringify(previous.reasoningEfforts ?? []) !== JSON.stringify(reasoningEfforts))) {
            if (this.sessionId === sessionId) this.schedulePostState();
        }
    }

    private refreshModelCatalog(sessionId: string): void {
        void this.modelCatalogs.pull(sessionId, {
            gate: () => Boolean(this.runtime.getUrl()),
            pull: () => this.runtime.models(sessionId),
            apply: (catalog) => {
                const selected = this.selectedModels.get(sessionId);
                const projectionSelection = this.modelSelectionProjectionSeqs.has(sessionId)
                    ? selected?.selection
                    : undefined;
                const current = projectionSelection ?? catalog.current;
                const effectiveCatalog = sameModelSelection(current, catalog.current)
                    ? catalog
                    : { ...catalog, current };
                this.modelCatalogs.set(sessionId, effectiveCatalog);
                const efforts = reasoningEffortOptions(
                    effectiveCatalog,
                    current.provider,
                    current.model,
                );
                if (!selected) {
                    this.selectedModels.set(sessionId, {
                        selection: current,
                        asOfSeq: highestKnownSeq(this.runtime.getSessionStore().get(sessionId)),
                        reasoningEfforts: efforts,
                    });
                } else if (!sameModelSelection(selected.selection, current) ||
                    JSON.stringify(selected.reasoningEfforts ?? []) !== JSON.stringify(efforts)) {
                    this.selectedModels.set(sessionId, {
                        ...selected,
                        selection: current,
                        reasoningEfforts: efforts,
                    });
                }
                if (this.sessionId === sessionId) this.postState();
            },
            fail: (error) => {
                this.output.appendLine(`[dsh:model] catalog refresh failed: ${errorMessage(error)}`);
            },
        });
    }

    private refreshSkillCatalog(sessionId: string): void {
        void this.skillCatalogs.pull(sessionId, {
            gate: () => Boolean(this.runtime.getUrl()),
            pull: () => this.runtime.listSkills(sessionId),
            apply: (skills) => {
                this.skillCatalogs.set(sessionId, skills);
                if (this.sessionId === sessionId) this.postState();
            },
            fail: (error) => {
                this.output.appendLine(`[dsh:skills] catalog refresh failed: ${errorMessage(error)}`);
            },
        });
    }

    /**
     * The registered command a prompt line invokes, if any. The catalog must
     * already be loaded — see {@link ensureCommandCatalog}.
     */
    private hostCommandName(sessionId: string, text: string): string | undefined {
        const name = looksLikeCommandLine(text);
        if (name === undefined) return undefined;
        return this.commandCatalogs.get(sessionId)?.some((command) => command.name === name)
            ? name
            : undefined;
    }

    /**
     * Runs one command line and reports its settled outcome. Admission and
     * outcome arrive together here; the same outcome is also logged durably on
     * the session, so this reporting is a convenience, not the record.
     */
    private async runHostCommand(
        sessionId: string,
        line: string,
        images: readonly DshImageUpload[] = [],
    ): Promise<void> {
        const execution = await this.runtime.executeCommand(sessionId, line, images);
        if (execution === undefined) {
            throw new Error(t("The dsh runtime resolved no command for “{line}”.", { line }));
        }
        const { kind, text } = execution.result;
        if (kind === "error") {
            throw new Error(text?.trim() || t("The dsh runtime rejected this command."));
        }
        if (text?.trim()) void vscode.window.showInformationMessage(`DSH: ${text.trim()}`);
    }

    /**
     * Executes the composer-owned plan toggle without taking the prompt
     * submission lock. Keeping these commands on a small serial tail makes
     * repeated Shift+Tab presses deterministic while the Runtime projection
     * catches up between requests.
     */
    private async setPlanMode(active: boolean): Promise<void> {
        const operation = this.planCommandTail.then(async () => {
            const session = this.sessionId;
            if (!session) return;
            const workspaceRoot = this.workspaceRoot();
            if (!workspaceRoot) {
                throw new Error(t("Open a workspace before sending a task to dsh."));
            }
            const autoStart = vscode.workspace.getConfiguration("dsh").get<boolean>("autoStart", true);
            if (autoStart || this.runtime.getUrl()) {
                await this.runtime.start(workspaceRoot);
            } else {
                throw new Error(t("dsh web is not running. Enable dsh.autoStart or run “DSH: Start dsh Web Runtime”."));
            }
            await this.ensureCommandCatalog(session);
            await this.runHostCommand(session, active ? "/plan" : "/plan off");
        });
        this.planCommandTail = operation.then(() => undefined, () => undefined);
        await operation;
    }

    /**
     * Pulls the session's host command registry. A Runtime without one leaves
     * the catalog empty, and the composer falls back to its IDE-local
     * commands alone.
     */
    private refreshCommandCatalog(sessionId: string): void {
        void this.ensureCommandCatalog(sessionId);
    }

    /**
     * Resolves once this session's command registry is known, sharing one
     * in-flight pull. A prompt that may be a command line awaits this, so a
     * freshly created session cannot leak `/compact` to the model just because
     * its catalog had not arrived yet.
     */
    private ensureCommandCatalog(sessionId: string): Promise<void> {
        return this.commandCatalogs.pull(sessionId, {
            gate: () => Boolean(this.runtime.getUrl()) && !this.commandRegistryUnavailable,
            pull: () => this.runtime.listCommands(sessionId),
            apply: (commands) => {
                this.commandCatalogs.set(sessionId, commands);
                if (this.sessionId === sessionId) this.postState();
            },
            absent: () => {
                this.commandRegistryUnavailable = true;
                this.output.appendLine(
                    "[dsh:commands] the connected Runtime serves no command registry; using IDE commands only",
                );
            },
            fail: (error) => {
                this.output.appendLine(`[dsh:commands] catalog refresh failed: ${errorMessage(error)}`);
            },
        });
    }

    private invalidateAgentPresetCatalog(): void {
        this.agentPresetCatalog = undefined;
        this.agentPresetCatalogGeneration += 1;
        if (this.agentPresetCatalogRequest) this.agentPresetCatalogRefreshPending = true;
    }

    private refreshAgentPresetCatalog(): void {
        if (!this.runtime.getUrl() || this.agentPresetCatalog || this.agentPresetCatalogRequest) return;
        const generation = this.agentPresetCatalogGeneration;
        const request = this.runtime.agentPresets()
            .then((catalog) => {
                if (this.agentPresetCatalogGeneration !== generation) return;
                this.agentPresetCatalog = catalog.presets;
                this.postState();
            })
            .catch((error) => {
                this.output.appendLine(`[dsh:agent-preset] catalog refresh failed: ${errorMessage(error)}`);
            })
            .finally(() => {
                if (this.agentPresetCatalogRequest !== request) return;
                this.agentPresetCatalogRequest = undefined;
                if (this.agentPresetCatalogRefreshPending) {
                    this.agentPresetCatalogRefreshPending = false;
                    this.refreshAgentPresetCatalog();
                }
            });
        this.agentPresetCatalogRequest = request;
    }

    private reasoningEffortView(): ChatViewState["reasoningEffort"] {
        if (!this.sessionId) return undefined;
        const selected = this.selectedModels.get(this.sessionId);
        const catalog = this.modelCatalogs.get(this.sessionId);
        const selection = selected?.selection ?? catalog?.current;
        if (!selection) return undefined;
        const options = selected?.reasoningEfforts ?? (catalog
            ? reasoningEffortOptions(catalog, selection.provider, selection.model)
            : []);
        if (options.length === 0) return undefined;
        return {
            ...(selection.reasoningEffort === undefined ? {} : { current: selection.reasoningEffort }),
            options: options.map((option) => {
                if (!this.reasoningEffortKnobEnabled()) return option;
                const image = this.reasoningEffortImage(option.id) ?? this.defaultEffortKnobImage();
                return image ? { ...option, image } : option;
            }),
        };
    }

    private agentStatusLabel(sessionId: string | undefined, busy: boolean): string | undefined {
        const pluginLabel = this.agentStatusPresentations?.current()?.label;
        if (pluginLabel) return pluginLabel;
        const configured = vscode.workspace
            .getConfiguration("dsh")
            .get<string>("agentStatusLabel", "")
            .trim();
        if (configured) return configured;

        const configuredCandidates = vscode.workspace
            .getConfiguration("dsh")
            .get<unknown>("agentStatusLabels", DEFAULT_AGENT_STATUS_LABELS);
        const candidates = Array.isArray(configuredCandidates)
            ? configuredCandidates.filter(
                (candidate): candidate is string =>
                    typeof candidate === "string" && candidate.trim().length > 0 && candidate.length <= 256,
            ).map((candidate) => candidate.trim())
            : [];
        if (!sessionId || !busy || candidates.length === 0) {
            this.agentStatusChoice = undefined;
            return undefined;
        }

        const candidateKey = candidates.join("\0");
        if (
            this.agentStatusChoice?.sessionId === sessionId &&
            this.agentStatusChoice.candidateKey === candidateKey
        ) return this.agentStatusChoice.label;

        const label = candidates[Math.floor(Math.random() * candidates.length)];
        this.agentStatusChoice = { sessionId, candidateKey, label };
        return label;
    }

    /** Resolves the webview-safe image URI for an effort id, if one is configured. */
    private reasoningEffortImage(effortId: string): string | undefined {
        const file = REASONING_EFFORT_IMAGES[effortId];
        if (!file || !this.view) return undefined;
        return this.view.webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, "resources", file),
        ).toString();
    }

    /** Whether the sprite-based reasoning effort knob is enabled via settings. */
    private reasoningEffortKnobEnabled(): boolean {
        return vscode.workspace.getConfiguration("dsh").get<boolean>("enableEffortKnob", true);
    }

    /** Resolves the default knob sprite URI, if configured. */
    private defaultEffortKnobImage(): string | undefined {
        if (!this.view) return undefined;
        return this.view.webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, "resources", REASONING_EFFORT_KNOB_IMAGE),
        ).toString();
    }

    private insertComposerText(text: string): void {
        this.pendingComposerUpdate = { type: "insertText", text };
        this.reveal();
        this.flushPendingComposerUpdate();
    }

    private setComposerText(text: string): void {
        this.pendingComposerUpdate = { type: "setText", text };
        this.reveal();
        this.flushPendingComposerUpdate();
    }

    private flushPendingComposerUpdate(): void {
        if (!this.view || !this.webviewReady || !this.pendingComposerUpdate) {
            return;
        }
        const update = this.pendingComposerUpdate;
        this.pendingComposerUpdate = undefined;
        void this.view.webview.postMessage(update);
    }

    private flushPendingComposerImages(): void {
        if (!this.view || !this.webviewReady) return;
        for (const image of this.pendingComposerImages.splice(0)) {
            void this.view.webview.postMessage({ type: "addImageDraft", image });
        }
    }

    private postState(): void {
        if (!this.view) {
            return;
        }

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const catalog = this.runtime.getSessionCatalog().snapshot();
        const currentDshWorkspace = workspaceFolder
            ? catalog.workspaces.find((workspace) => samePath(workspace.path, workspaceFolder.uri.fsPath))
            : undefined;
        const selected = catalog.sessions.find((item) => item.sessionId === this.sessionId);
        if (this.sessionId) {
            this.refreshSkillCatalog(this.sessionId);
            this.refreshCommandCatalog(this.sessionId);
        }
        if (selected?.agentPreset) this.refreshAgentPresetCatalog();
        const selectedAgentPreset = selected?.agentPreset;
        const selectedAgentPresetLabel = this.agentPresetCatalog
            ?.find((preset) => preset.id === selectedAgentPreset)?.name;
        const session = this.sessionId
            ? this.runtime.getSessionStore().get(this.sessionId)
            : undefined;
        const goalCell = projectionCell(session, "goal");
        const permissionsCell = projectionCell(session, "permissions");
        const todos = todoProjection(projectionValue(session, "todos"));
        const schedule = scheduleProjection(projectionValue(session, "schedule"));
        const imageLimits = imageLimitsProjection(projectionValue(session, "imageLimits"));
        const plan = planProjection(projectionValue(session, "plan"));
        const sessionStats = sessionStatsProjection(projectionValue(session, "sessionStats"));
        const host = presentHostBaseline(this.runtime.getHostDescription());
        const busy = selected?.running === true;
        const agentStatusLabel = this.agentStatusLabel(this.sessionId, busy);
        const autoOpenReasoning =
            vscode.workspace.getConfiguration("dsh").get<boolean>("autoOpenReasoning", true);
        const projectedMessages = focusChatMessages(
            projectChatMessages(session, this.optimisticPrompts, this.sessionSkillNames()),
            this.focusMode,
        );
        if (this.sessionId) this.goalMutations.observe(this.sessionId, goalCell);
        const activeInteractions = session?.interactions.filter(
            (interaction) =>
                interaction.status === "pending" ||
                interaction.status === "submitting" ||
                interaction.status === "failed" ||
                interaction.status === "unavailable" ||
                interaction.status === "resolved",
        ) ?? [];
        const subagentPreview = this.subagents.previewFor(this.sessionId);
        const state: ChatViewState = {
            messages: this.renderMessages(
                projectedMessages,
                `session:${this.sessionId ?? "none"}`,
                this.sessionId,
            ),
            context: this.contextStore.snapshot(),
            fileReferenceCandidates: this.fileReferenceCandidates,
            ...(this.settingsPanel === undefined ? {} : { settings: this.settingsPanel }),
            ...(this.dynamicPlugins === undefined ? {} : { dynamicPlugins: this.dynamicPlugins }),
            selection: this.contextStore.getCurrentSelectionMetadata(),
            selectionEnabled: this.selectionEnabled,
            status: this.runtime.getStatus(),
            busy,
            ...(agentStatusLabel === undefined
                ? {}
                : { agentStatusLabel }),
            ...(autoOpenReasoning ? {} : { autoOpenReasoning: false }),
            submitting: this.submitting,
            cancelling: this.cancelRequested && selected?.running === true,
            focusMode: this.focusMode,
            workspaceName: workspaceFolder?.name,
            skills: this.sessionId
                ? [...(this.skillCatalogs.get(this.sessionId) ?? [])]
                : [...(this.pendingNewSessionSkills ?? [])],
            commands: this.sessionId
                ? [...(this.commandCatalogs.get(this.sessionId) ?? [])]
                : [],
            ...(workspaceFolder === undefined
                ? {}
                : {
                      currentWorkspace: {
                          ...(currentDshWorkspace === undefined
                              ? {}
                              : { workspaceId: currentDshWorkspace.workspaceId }),
                          title: currentDshWorkspace?.title || workspaceFolder.name,
                      },
                  }),
            host,
            sessionId: this.sessionId,
            ...(selectedAgentPreset === undefined ? {} : { agentPreset: selectedAgentPreset }),
            ...(selectedAgentPresetLabel === undefined ? {} : { agentPresetLabel: selectedAgentPresetLabel }),
            ...(this.newSessionDraft && this.pendingNewSessionWorkspaceId
                ? {
                      draftWorkspaceId: this.pendingNewSessionWorkspaceId,
                      draftWorkspaceTitle: this.pendingNewSessionWorkspaceTitle,
                  }
                : {}),
            sessions: presentSessionRows(catalog),
            sessionStatus: selected
                ? {
                      running: selected.running === true,
                      attention: activeInteractions.some(
                          (interaction) =>
                              interaction.status === "pending" ||
                              interaction.status === "submitting",
                      ),
                      turn: projectTurnStatus(
                          session,
                          selected.running === true,
                          selected.lastAgentError,
                      ),
                      ...(selected.lastAgentError === undefined
                          ? {}
                          : { error: selected.lastAgentError }),
                  }
                : undefined,
            tokenUsage: projectTokenUsage(
                session,
                this.sessionId ? this.selectedModels.get(this.sessionId) : undefined,
                host,
            ),
            ...(sessionStats === undefined ? {} : { sessionStats }),
            reasoningEffort: this.reasoningEffortView(),
            permissions: permissionProjection(permissionsCell?.value),
            ...(todos === undefined ? {} : { todos }),
            ...(schedule === undefined ? {} : { schedule }),
            ...(imageLimits === undefined ? {} : { imageLimits }),
            ...(plan === undefined ? {} : { plan }),
            interactions: activeInteractions.map((interaction) =>
                interaction.kind === "approval"
                    ? {
                          key: interaction.key,
                          kind: "approval",
                          status: interaction.status,
                          toolName: interaction.toolName,
                          ...(interaction.reason === undefined
                              ? {}
                              : { reason: interaction.reason }),
                          ...(() => {
                              const call = presentApprovalCall(session, interaction.callId);
                              return call === undefined ? {} : { call };
                          })(),
                          ...(interaction.outcome === undefined
                              ? {}
                              : { outcome: interaction.outcome }),
                          ...(interaction.error === undefined
                              ? {}
                              : { error: interaction.error }),
                      }
                    : (() => {
                          const review = presentPlanReview(interaction.questions);
                          return review
                              ? {
                                    key: interaction.key,
                                    kind: "plan-review" as const,
                                    status: interaction.status,
                                    review,
                                    planHtml: renderSafeMarkdown(review.plan),
                                    ...(interaction.outcome === undefined
                                        ? {}
                                        : { outcome: interaction.outcome }),
                                    ...(interaction.error === undefined
                                        ? {}
                                        : { error: interaction.error }),
                                }
                              : {
                                    key: interaction.key,
                                    kind: "question" as const,
                                    status: interaction.status,
                                    questions: [...interaction.questions],
                                    ...(interaction.outcome === undefined
                                        ? {}
                                        : { outcome: interaction.outcome }),
                                    ...(interaction.error === undefined
                                        ? {}
                                        : { error: interaction.error }),
                                };
                      })(),
            ),
            queue: queueDockItems(session?.queue.items ?? []),
            goal: this.sessionId
                ? presentGoalHud(goalCell, this.goalMutations.snapshot(this.sessionId))
                : undefined,
            subagents: this.sessionId ? this.subagents.tree(this.sessionId) : undefined,
            subagentPreview: subagentPreview
                ? {
                      ...subagentPreview,
                      messages: this.renderMessages(
                          subagentPreview.messages,
                          `subagent:${subagentPreview.childSessionId}`,
                          subagentPreview.childSessionId,
                      ),
                  }
                : undefined,
            jobs: this.sessionId
                ? presentJobCenter(this.sessionId, session?.jobs.items ?? [])
                : [],
            changeReviews: this.changeReviews.view(this.sessionId),
        };
        void this.view.webview.postMessage({
            type: "state",
            protocol: CHAT_WEBVIEW_PROTOCOL_VERSION,
            state,
        });
        this.updateViewBadge(catalog.sessions);
    }

    private seedObservedRunning(): void {
        for (const session of this.runtime.getSessionCatalog().snapshot().sessions) {
            this.observedRunning.set(session.sessionId, session.running === true);
        }
    }

    private observeSessionTransitions(): void {
        const sessions = this.runtime.getSessionCatalog().snapshot().sessions;
        for (const session of sessions) {
            const running = session.running === true;
            const previous = this.observedRunning.get(session.sessionId);
            if (previous === true && !running && this.view && !this.view.visible) {
                this.completedWhileHidden.add(session.sessionId);
            }
            this.observedRunning.set(session.sessionId, running);
        }
        const currentIds = new Set(sessions.map((session) => session.sessionId));
        for (const sessionId of this.observedRunning.keys()) {
            if (!currentIds.has(sessionId)) this.observedRunning.delete(sessionId);
        }
        this.updateViewBadge(sessions);
    }

    private updateViewBadge(sessions = this.runtime.getSessionCatalog().snapshot().sessions): void {
        if (!this.view) return;
        if (this.view.visible) {
            this.completedWhileHidden.clear();
            this.view.badge = undefined;
            return;
        }
        this.view.badge = hiddenViewBadge(sessions, this.completedWhileHidden);
    }

    private renderMessages(
        messages: readonly ChatMessage[],
        scope: string,
        imageSessionId?: string,
    ): ChatMessage[] {
        const hydrated = messages.map((message): ChatMessage => {
            if (!imageSessionId) return message;
            const hydrateImages = (images: readonly ChatImageView[] | undefined): ChatImageView[] | undefined =>
                images?.map((image) => {
                    if (image.src || !image.attachmentId) return image;
                    const cached = this.imageCache.get(`${imageSessionId}:${image.attachmentId}`);
                    if (cached?.src) {
                        return { ...image, src: cached.src, loadState: undefined, error: undefined };
                    }
                    if (cached?.error) {
                        return { ...image, loadState: "error", error: cached.error };
                    }
                    return { ...image, loadState: cached?.loading ? "loading" : "idle" };
                });
            const images = hydrateImages(message.images);
            const toolImages = hydrateImages(message.tool?.images);
            if (!images && !toolImages) return message;
            return {
                ...message,
                ...(images === undefined ? {} : { images }),
                ...(message.tool === undefined || toolImages === undefined
                    ? {}
                    : { tool: { ...message.tool, images: toolImages } }),
            };
        });
        return this.markdownRenders.render(hydrated, scope);
    }

    private async loadImage(attachmentId: string): Promise<void> {
        const rootSessionId = this.sessionId;
        if (!rootSessionId) return;
        const referencedByRoot = projectChatMessages(
            this.runtime.getSessionStore().get(rootSessionId),
            this.optimisticPrompts,
        ).some((message) =>
            message.images?.some((image) => image.attachmentId === attachmentId) === true ||
            message.tool?.images?.some((image) => image.attachmentId === attachmentId) === true,
        );
        const preview = this.subagents.previewFor(rootSessionId);
        const referencedByPreview = preview !== undefined &&
            preview.messages.some((message) =>
                message.images?.some((image) => image.attachmentId === attachmentId) === true ||
                message.tool?.images?.some((image) => image.attachmentId === attachmentId) === true,
            );
        const sessionId = referencedByRoot
            ? rootSessionId
            : referencedByPreview
              ? preview?.childSessionId
              : undefined;
        if (!sessionId) return;

        const key = `${sessionId}:${attachmentId}`;
        const current = this.imageCache.get(key);
        if (current?.src || current?.loading) return;
        this.imageCache.set(key, { loading: true });
        this.postState();
        try {
            const result = await this.runtime.attachment(sessionId, attachmentId);
            if (result.attachment.attachmentId !== attachmentId) {
                throw new Error(t("Harness returned a different image attachment."));
            }
            const bytes = Buffer.from(result.data, "base64");
            if (!result.data || bytes.toString("base64") !== result.data ||
                bytes.byteLength !== result.attachment.bytes ||
                !isImageMediaType(result.attachment.mediaType)) {
                throw new Error(t("Harness returned invalid image attachment data."));
            }
            this.imageCache.delete(key);
            this.imageCache.set(key, {
                src: `data:${result.attachment.mediaType};base64,${result.data}`,
            });
            while (this.imageCache.size > 40) {
                const oldest = this.imageCache.keys().next().value as string | undefined;
                if (oldest === undefined) break;
                this.imageCache.delete(oldest);
            }
        } catch (error) {
            this.imageCache.set(key, { error: errorMessage(error) });
        }
        this.postState();
    }

    private copyCodeBlock(renderId: string, codeBlockId: string): Promise<void> {
        return copyCodeBlock(this.codeBlockText(renderId, codeBlockId));
    }

    private codeBlockText(renderId: string, codeBlockId: string): string {
        return this.markdownRenders.codeBlockText(renderId, codeBlockId);
    }

    private insertCodeBlock(renderId: string, codeBlockId: string): Promise<void> {
        return insertCodeBlock(this.codeBlockText(renderId, codeBlockId));
    }

    private openCodeBlock(
        renderId: string,
        codeBlockId: string,
        language?: string,
    ): Promise<void> {
        return openCodeBlock(this.codeBlockText(renderId, codeBlockId), language);
    }

    private applyCodeBlock(
        renderId: string,
        codeBlockId: string,
        language?: string,
    ): Promise<void> {
        return applyCodeBlock(this.codeBlockText(renderId, codeBlockId), language);
    }

    private schedulePostState(): void {
        if (this.stateUpdateTimer) return;
        this.stateUpdateTimer = setTimeout(() => {
            this.stateUpdateTimer = undefined;
            this.postState();
        }, 16);
    }

    private getHtml(webview: vscode.Webview): string {
        const nonce = randomUUID().replace(/-/g, "");
        const language = vscode.env.language.replace(/[^a-z0-9-]/giu, "") || "en";
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, "webview", "dist", "main.js"),
        );
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, "webview", "dist", "main.css"),
        );
        return `<!DOCTYPE html>
<html lang="${language}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
    <link rel="stylesheet" href="${styleUri}">
</head>
<body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}
