export type DshContextKind =
    | "selection"
    | "file"
    | "folder"
    | "diagnostics"
    | "git-diff"
    | "terminal"
    | "debug";

export interface DshContextItem {
    id: string;
    kind: DshContextKind;
    label: string;
    path?: string;
    language?: string;
    terminalName?: string;
    command?: string;
    exitCode?: number;
    range?: {
        startLine: number;
        endLine: number;
    };
    content: string;
    byteLength: number;
    /** True when the content was shortened before entering the prompt. */
    truncated?: boolean;
}

/** One host-resolved candidate shown by the composer `@` reference menu. */
export interface DshReferenceCandidate {
    kind: "file" | "directory" | "session" | "terminal";
    /** Readable label shown to the user. */
    label: string;
    /** Exact text inserted into the prompt when selected. */
    insertText: string;
    description?: string;
}

/** Path-only candidate returned by the Runtime `fileReferences/list` Remote. */
export interface DshFileReferenceCandidate {
    path: string;
    kind: "file" | "directory";
}

/** Mention-bearing candidate returned by `sessionReferenceResolver/candidates`. */
export interface DshSessionReferenceCandidate {
    sessionId: string;
    label: string;
    cwd?: string;
    sameWorkspace: boolean;
    createdAt: number;
    mention: string;
}

export type ChatRole = "user" | "assistant" | "system" | "tool";

export type DshImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export interface DshImageUpload {
    mediaType: DshImageMediaType;
    data: string;
    name?: string;
}

export interface ChatImageView {
    attachmentId?: string;
    mediaType: DshImageMediaType;
    bytes: number;
    width?: number;
    height?: number;
    name?: string;
    src?: string;
    loadState?: "idle" | "loading" | "error";
    error?: string;
}

export interface ChatWebSourceView {
    url: string;
    href?: string;
    domain?: string;
    title?: string;
    snippet?: string;
    publishedAt?: string;
}

export type ChatWebResultView =
    | {
          kind: "search";
          sources: ChatWebSourceView[];
          answer?: string;
          truncated: boolean;
      }
    | {
          kind: "fetch";
          url: string;
          href?: string;
          domain?: string;
          statusCode: number;
          truncated: boolean;
      };

export type ChatLspOperation =
    | "goToDefinition"
    | "findReferences"
    | "goToImplementation"
    | "hover";

export interface ChatLspLocationView {
    label: string;
    path?: string;
    line?: number;
    character?: number;
}

export type ChatLspResultView =
    | {
          kind: "locations";
          operation: Exclude<ChatLspOperation, "hover">;
          query: ChatLspLocationView;
          locations: ChatLspLocationView[];
          notices: string[];
          empty: boolean;
          truncated: boolean;
      }
    | {
          kind: "hover";
          operation: "hover";
          query: ChatLspLocationView;
          content?: string;
          empty: boolean;
          truncated: boolean;
      };

export interface ChatToolCall {
    callId: string;
    name: string;
    title: string;
    status: "running" | "completed" | "failed";
    args?: string;
    result?: string;
    durationMs?: number;
    error?: string;
    images?: ChatImageView[];
    web?: ChatWebResultView;
    lsp?: ChatLspResultView;
    /**
     * Files this call changed, when it reported a diff card. Paths only — the
     * before/after text stays host-side, because a whole-file body per edit
     * would ride every full state post into the webview.
     */
    diffPaths?: string[];
}

export interface ChatCompactionView {
    status: "running" | "success" | "failed";
    compactionId?: string;
    summary?: string;
    error?: string;
}

export interface ChatMessage {
    /**
     * Skill this user message invoked directly, by name. Present only for a
     * leading `/name` token that matched the session's skill catalog; the
     * token is removed from `text` so a surface can render the invocation as
     * itself rather than as literal prompt text.
     */
    skillInvocation?: string;
    id: string;
    role: ChatRole;
    text: string;
    /** Assistant-only thinking content, never folded into visible text. */
    reasoning?: string;
    reasoningState?: "streaming" | "complete";
    tool?: ChatToolCall;
    images?: ChatImageView[];
    /** Dedicated compaction-status/summary card rendered in the chat surface. */
    compaction?: ChatCompactionView;
    /** Fixed-vocabulary HTML produced by the extension-host safe Markdown renderer. */
    renderedHtml?: string;
    renderedReasoningHtml?: string;
    /** Opaque per-render nonce used to address host-retained code payloads. */
    renderId?: string;
    reasoningRenderId?: string;
    /** Durable assistant-message identity used by the optional feedback sidecar. */
    messageId?: string;
    /** Host-owned feedback state for this finalized assistant message. */
    feedback?: ChatMessageFeedbackView;
    createdAt: number;
    seq?: number;
    state?: "committed" | "streaming" | "pending" | "failed";
}

export type DshMessageFeedbackRating = "positive" | "negative";

export interface DshMessageFeedbackItem {
    messageId: string;
    rating: DshMessageFeedbackRating;
    note?: string;
    version: string;
    createdAt: number;
    updatedAt: number;
}

export interface DshMessageFeedbackListRequest {
    sessionId: string;
}

export type DshMessageFeedbackListResult =
    | { ok: true; value: { items: DshMessageFeedbackItem[] } }
    | { ok: false; error: DshMessageFeedbackError };

export interface DshMessageFeedbackPutRequest {
    sessionId: string;
    messageId: string;
    rating: DshMessageFeedbackRating;
    note?: string;
    ifVersion: string | null;
}

export type DshMessageFeedbackPutResult =
    | { ok: true; value: DshMessageFeedbackItem }
    | { ok: false; error: DshMessageFeedbackError };

export interface DshMessageFeedbackDeleteRequest {
    sessionId: string;
    messageId: string;
    ifVersion: string;
}

export type DshMessageFeedbackDeleteResult =
    | { ok: true; value: { absent: true } }
    | { ok: false; error: DshMessageFeedbackError };

export interface DshMessageFeedbackError {
    code: string;
    sessionId?: string;
    messageId?: string;
    current?: DshMessageFeedbackItem | null;
    maxBytes?: number;
    actualBytes?: number;
}

export type DshMessageFeedbackStatus = "loading" | "ready" | "error" | "unavailable";

/** Serializable Session-level feedback cache used by the Webview controls. */
export interface DshMessageFeedbackStateView {
    status: DshMessageFeedbackStatus;
    items: Record<string, DshMessageFeedbackItem>;
    pending: Record<string, true>;
    errors: Record<string, string>;
    error?: string;
}

export interface ChatMessageFeedbackView {
    status: Exclude<DshMessageFeedbackStatus, "unavailable">;
    rating?: DshMessageFeedbackRating;
    note?: string;
    pending?: boolean;
    error?: string;
}

export type RuntimeState = "stopped" | "starting" | "running" | "error";

export interface RuntimeStatus {
    state: RuntimeState;
    url?: string;
    message?: string;
}

export interface DshRpcError {
    code: string;
    message: string;
    details?: unknown;
    [key: string]: unknown;
}

export type DshRpcResult<T = unknown> =
    | {
          ok: true;
          value?: T;
      }
    | {
          ok: false;
          error?: DshRpcError | unknown;
      };

export interface DshServerRequest<T = unknown> {
    type: "server-request";
    rpcId: string;
    method: string;
    payload: T;
}

export interface DshClientResponse<T = unknown> {
    type: "client-response";
    rpcId: string;
    result: DshRpcResult<T>;
}

export type DshRpcReceipt =
    | { accepted: true }
    | { accepted: false; reason: "not-pending" | "bad-response" | string };

export interface DshSurfaceReplaceOp {
    op: "replace";
    /** Inclusive seq of the first surface node being replaced. */
    start: number;
    /** Inclusive seq of the last surface node being replaced. */
    end: number;
}

export type DshSurfaceOp = "append" | DshSurfaceReplaceOp;

export interface DshSessionEvent {
    type: string;
    seq: number;
    time: number;
    data: unknown;
    sourceEventSeqs?: number[];
    surfaceOp?: DshSurfaceOp;
    ignorable?: true;
}

export interface DshHistoryEvent {
    type?: string;
    seq?: number;
    time?: number;
    data?: unknown;
    sourceEventSeqs?: number[];
    surfaceOp?: DshSurfaceOp;
    ignorable?: true;
}

export interface DshHistoryEntry {
    event: DshHistoryEvent;
    view?: unknown;
}

export interface DshHistoryResult {
    events: DshHistoryEntry[];
    hasMore?: boolean;
    projections?: DshSessionProjectionsBlock;
}

export interface DshSessionProjectionsBlock {
    /** Last committed event reflected by every value; -1 for an empty log. */
    asOfSeq: number;
    /** Complete current value for every projection registered by the host. */
    values: Record<string, unknown>;
}

export interface DshSessionCreateResult {
    sessionId: string;
    agentPreset?: string;
}

export interface DshSessionPromptResult {
    accepted?: boolean;
    command?: unknown;
}

export interface DshImageAttachmentResult {
    attachment: {
        attachmentId: string;
        mediaType: DshImageMediaType;
        bytes: number;
        width: number;
        height: number;
        name?: string;
    };
    data: string;
}

export interface DshSessionSummary {
    sessionId: string;
    title?: string;
    cwd?: string;
    createdAt?: number;
    updatedAt?: number;
    running?: boolean;
    blank?: boolean;
    parentSessionId?: string;
    origin?: "subagent";
    agentPreset?: string;
    projections?: DshSessionProjectionsBlock;
    [key: string]: unknown;
}

export interface DshSessionListResult {
    items: DshSessionSummary[];
    nextCursor?: string;
    [key: string]: unknown;
}

export interface DshSessionListPayload {
    cursor?: string;
}

export interface DshSessionSearchItem {
    sessionId: string;
    snippet: string;
}

export interface DshSessionSearchResult {
    items: DshSessionSearchItem[];
    hasMore: boolean;
}

export interface DshModelSelection {
    provider: string;
    model: string;
    reasoningEffort?: string;
    [key: string]: unknown;
}

export interface DshModelProviderModel {
    id: string;
    name: string;
    description?: string;
    reasoning?: {
        efforts: Array<{ id: string; name: string; description?: string }>;
        defaultEffort?: string;
    };
}

export interface DshModelProviderGroup {
    id: string;
    name: string;
    models: DshModelProviderModel[];
}

export interface DshModelCatalogFailure {
    id: string;
    name: string;
    message: string;
}

export interface DshSessionModelsResult {
    current: DshModelSelection;
    routable: boolean;
    groups: DshModelProviderGroup[];
    failures: DshModelCatalogFailure[];
    [key: string]: unknown;
}

export interface DshSessionSelectModelResult {
    selected: DshModelSelection;
    [key: string]: unknown;
}

export interface DshReasoningEffortOption {
    id: string;
    label: string;
    /** Optional webview-safe image URI used as the slider knob. */
    image?: string;
}

export interface ReasoningEffortView {
    current?: string;
    options: DshReasoningEffortOption[];
}

export interface DshAgentPresetEntry {
    id: string;
    trust: "system" | "user";
    isDefault: boolean;
    name?: string;
    description?: string;
    broken?: string;
}

export interface DshAgentPresetListResult {
    presets: DshAgentPresetEntry[];
    authorable: boolean;
    hasDocument: boolean;
}

export interface DshAgentPresetSelectResult {
    agentPreset: string;
}

export interface DshAgentPresetReadResult {
    agentPreset: string;
    trust: "system" | "user";
    content: string;
    name?: string;
    description?: string;
}

export type DshPluginFiberPhase =
    | "pending"
    | "loading"
    | "active"
    | "failed"
    | "unloading"
    | null;

export interface DshPluginInventoryEntry {
    entryId: string;
    moduleName: string;
    enabled: boolean;
    fiberPhase: DshPluginFiberPhase;
}

export type DshPluginPresetEnablement = boolean | "conditional";

export interface DshPluginInventoryRow {
    entryId: string | null;
    moduleName: string;
    enabled: DshPluginPresetEnablement;
    condition?: string;
    fiberPhase: DshPluginFiberPhase;
}

export interface DshPluginInventoryPreset {
    id: string;
    trust: "system" | "user";
    name?: string;
    isDefault: boolean;
    broken?: string;
    rows: DshPluginInventoryRow[];
}

export interface DshPluginInventorySnapshot {
    entries: DshPluginInventoryEntry[];
    agentPresets?: DshPluginInventoryPreset[];
}

/** Settings-owned state for the read-only plugin inventory tab. */
export interface DshPluginInventoryPanelView extends DshPluginInventorySnapshot {
    loading?: boolean;
    error?: string;
}

export type DshDynamicPluginRunMode = "run" | "update";

export type DshDynamicPluginRunStatus =
    | "awaiting-approval"
    | "starting-host"
    | "client-pending"
    | "running"
    | "waiting"
    | "rejected"
    | "failed"
    | "cancelled"
    | "stopped";

export type DshDynamicPluginHalfStatus =
    | "absent"
    | "pending"
    | "stopped"
    | "running"
    | "waiting"
    | "failed";

export interface DshDynamicPluginPackage {
    packageId: string;
    name: string;
    purpose: string;
    hasHostHalf: boolean;
    hasClientHalf: boolean;
}

export interface DshDynamicPluginHalf {
    status: DshDynamicPluginHalfStatus;
    waitingFor: string[];
    error?: string;
}

export type DshDynamicPluginDiagnosticPhase =
    | "approval"
    | "host-load"
    | "host-apply"
    | "client-load"
    | "client-apply"
    | "client-render";

export interface DshDynamicPluginDiagnostic {
    phase: DshDynamicPluginDiagnosticPhase;
    message: string;
    stack?: string;
    pluginId: string;
    packageId: string;
    pluginRunId: string;
}

export interface DshDynamicPluginRunAttempt {
    pluginRunId: string;
    packageId: string;
    mode: DshDynamicPluginRunMode;
    status: DshDynamicPluginRunStatus;
    approvalRequestId?: string;
    requiresApproval?: boolean;
    host: DshDynamicPluginHalf;
    client: DshDynamicPluginHalf;
    error?: DshDynamicPluginDiagnostic;
}

export interface DshDynamicPluginActiveRun {
    pluginRunId: string;
    packageId: string;
}

export interface DshDynamicPluginRow {
    pluginId: string;
    agentId: string;
    packages: DshDynamicPluginPackage[];
    currentPackageId?: string;
    nextPackageId?: string;
    activeRun?: DshDynamicPluginActiveRun;
    latestRun?: DshDynamicPluginRunAttempt;
}

/** Activity-dock state for the optional dynamic Cordis plugin runner. */
export interface DshDynamicPluginPanelView {
    rows: DshDynamicPluginRow[];
    loading?: boolean;
    error?: string;
}

export type DshDynamicPluginStopResult =
    | { ok: true }
    | { ok: false; reason: "plugin-missing" | "not-running"; message: string };

export type DshDynamicPluginRemoveResult =
    | { ok: true; wasRunning: boolean }
    | { ok: false; reason: "plugin-missing"; message: string };

export interface DshDynamicPluginResolveResult {
    accepted: boolean;
}

export type DshAgentPresetOpenResult =
    | { opened: true }
    | { opened: false; path: string };

export interface DshSessionRenameResult {
    title: string;
    seq: number;
    [key: string]: unknown;
}

export interface DshSessionForkResult {
    sessionId: string;
    [key: string]: unknown;
}

export interface DshGoalRef {
    id: string;
    revision: number;
}

export type DshGoalPhase = "active" | "paused" | "blocked" | "complete";

export interface DshGoalBlockReason {
    code: string;
    message: string;
}

export interface DshGoalSnapshot extends DshGoalRef {
    objective: string;
    phase: DshGoalPhase;
    blockedReason?: DshGoalBlockReason;
    maxGoalRounds: number;
}

/** Exact whole value carried by the public `goal` session projection. */
export interface DshGoalProjection {
    goal: DshGoalSnapshot;
    roundsStarted: number;
    createdAt: number;
    updatedAt: number;
}

/** Exact public value carried by the optional `plan` session projection. */
export interface DshPlanProjection {
    active: boolean;
    pending: boolean;
}

export interface DshGoalRefResult {
    ref: DshGoalRef;
}

export type DshSubagentListEntry =
    | ({
          kind: "child";
          id: string;
          activity: "running" | "inactive";
          hasChildren: boolean;
      } &
          (
              | { mode: "one-shot"; label?: string }
              | { mode: "continuable"; label: string }
          ))
    | {
          kind: "diagnostic";
          id: string;
          reason: "corrupt" | "unsupported" | "unavailable";
      };

export interface DshSubagentCatalog {
    entries: DshSubagentListEntry[];
    parentAvailable: boolean;
}

export type DshSubagentAddress = {
    parentSessionId: string;
    childSessionId: string;
} & ({ mode: "one-shot" } | { mode: "continuable" });

export interface DshSubagentHistoryResult extends DshHistoryResult {
    hasMore: boolean;
}

/** Exact public value carried by the optional `subagentTiming` projection. */
export interface SubagentTimingView {
    settledMs: number;
    active?: {
        since: number;
        through: number;
    };
}

export interface DshSubagentPromptResult {
    messageId: string;
}

export interface DshSkillEntry {
    name: string;
    description: string;
    whenToUse?: string;
    modelInvocable: boolean;
    [key: string]: unknown;
}

export interface DshSkillListResult {
    skills: DshSkillEntry[];
    [key: string]: unknown;
}

/**
 * Handler-free view of one host-registered slash command
 * (`@deepseek-ai/dsh-commands` CommandDescriptor).
 */
export interface DshCommandDescriptor {
    /** Lowercase name without the leading slash. */
    name: string;
    description: string;
    /** Present when the command accepts free-form input after its name. */
    input?: {
        hint: string;
        /** Whether composer image attachments may accompany an invocation. */
        images?: boolean;
    };
    [key: string]: unknown;
}

/** Normalized outcome of one settled command handler. */
export interface DshCommandResult {
    kind: "success" | "error";
    text?: string;
    /** Earlier domain event that owns a richer presentation of this outcome. */
    sourceEventSeq?: number;
    [key: string]: unknown;
}

/**
 * One settled execution. `commandId` pairs the acknowledgment with the
 * `command/run` / `command/done` events the host logs for it.
 */
export interface DshCommandExecution {
    commandId: string;
    result: DshCommandResult;
    [key: string]: unknown;
}

export interface DshConfigurableProvider {
    provider: string;
    displayName: string;
    settingsNs: string;
    settingsPath: string[];
    active: boolean;
    declared?: boolean;
}

export interface DshProviderListResult {
    providers: DshConfigurableProvider[];
}

/** Host-scoped model catalog returned by `llm.models`. */
export interface DshLlmModelsResult {
    groups: DshModelProviderGroup[];
    failures: DshModelCatalogFailure[];
}

/** One model candidate returned by the configuration-time discovery flow. */
export interface DshDiscoveredModel {
    id: string;
    name?: string;
    contextWindow?: number;
    maxTokens?: number;
}

/** Result of interrogating a provider endpoint with an unsaved draft. */
export interface DshLlmDiscoverModelsResult {
    models: DshDiscoveredModel[];
}

export interface DshCredentialView {
    configured: boolean;
    source?: string;
    writable: boolean;
}

export interface DshCredentialDescribeResult {
    credentials: Record<string, DshCredentialView>;
}

export interface DshSettingsNamespaceView {
    ns: string;
    schema: unknown;
    value: unknown;
    base?: unknown;
    user?: unknown;
    applies: "live" | "restart";
    secrets: Array<{ path: string[]; set: boolean }>;
    revision: number;
}

export interface DshSettingsDescribeResult {
    writable: boolean;
    hasDocument: boolean;
    namespaces: DshSettingsNamespaceView[];
}

export type DshSettingFieldType = "boolean" | "number" | "string" | "json";

export interface DshSettingFieldView {
    path: string[];
    label: string;
    description?: string;
    type: DshSettingFieldType;
    value: string;
    overridden: boolean;
    secret: boolean;
    secretSet: boolean;
}

export interface DshSettingsCardView {
    ns: string;
    title: string;
    applies: "live" | "restart";
    writable: boolean;
    revision: number;
    fields: DshSettingFieldView[];
}

export interface DshSettingsPanelView {
    open: boolean;
    loading?: boolean;
    writable: boolean;
    hasDocument: boolean;
    cards: DshSettingsCardView[];
    pluginInventory?: DshPluginInventoryPanelView;
    error?: string;
}

export type DshSettingsPathOperation =
    | { op: "set"; path: string[]; value: unknown }
    | { op: "unset"; path: string[] };

export interface DshApprovalRequested {
    type: "approval/requested";
    sessionId: string;
    approvalId: string;
    toolName: string;
    callId?: string;
    reason?: string;
}

export interface DshApprovalResolved {
    type: "approval/resolved";
    sessionId: string;
    approvalId: string;
    outcome: "allowed-once" | "rejected" | "cancelled" | "unavailable" | string;
}

export type DshApprovalOutcome = "allowed-once" | "rejected";

export interface DshApprovalResponse {
    sessionId: string;
    approvalId: string;
    outcome: DshApprovalOutcome;
}

export interface DshQuestionOption {
    label: string;
    description?: string;
}

export interface DshQuestionIntent {
    kind: string;
    [key: string]: unknown;
}

export interface DshQuestionItem {
    id: string;
    question: string;
    header?: string;
    detail?: string;
    options?: DshQuestionOption[];
    multiSelect?: boolean;
    intent?: DshQuestionIntent;
}

export interface DshQuestionRequested {
    type: "question/requested";
    sessionId: string;
    questions: DshQuestionItem[];
}

export interface DshQuestionResolved {
    type: "question/resolved";
    sessionId: string;
    questionRpcId: string;
    outcome: "answered" | "cancelled" | string;
}

export interface DshQuestionAnswerItem {
    id: string;
    selected: string[];
    custom?: string;
}

export interface DshQuestionResponse {
    sessionId: string;
    answer: {
        answers: DshQuestionAnswerItem[];
    };
}

export interface DshSessionEventFrame {
    type: "session/event";
    sessionId: string;
    event: DshSessionEvent;
    view?: unknown;
}

export interface DshSessionSubscribedFrame {
    type: "session/subscribed";
    sessionId: string;
    lastSeq: number;
}

export interface DshQueuedInboxItem {
    id: string;
    placement: "queued" | "steering" | "context";
    /** Message is merge-extensible in Harness, so clients retain it losslessly. */
    message: unknown;
}

export interface DshSessionQueueFrame {
    type: "session/queue";
    sessionId: string;
    items: DshQueuedInboxItem[];
}

export interface DshJobView {
    id: string;
    /** Producer kinds are plugin-extensible and intentionally not enumerated. */
    kind: string;
    label: string;
    status: "running" | "stopping" | "completed" | "killed" | "failed";
    detail?: string;
    startedAt: number;
    finishedAt?: number;
}

export interface DshSessionJobsFrame {
    type: "session/jobs";
    sessionId: string;
    jobs: DshJobView[];
}

export interface DshSessionProjectionFrame {
    type: "session/projection";
    sessionId: string;
    key: string;
    value: unknown;
    seq: number;
}

export interface DshStreamErrorFrame {
    type: "stream/error";
    error: DshRpcError | unknown;
}

export interface DshUnknownMuxFrame {
    type: string;
    [key: string]: unknown;
}

export type DshMuxFrame =
    | DshSessionEventFrame
    | DshSessionSubscribedFrame
    | DshApprovalRequested
    | DshApprovalResolved
    | DshQuestionRequested
    | DshQuestionResolved
    | DshSessionQueueFrame
    | DshSessionJobsFrame
    | DshSessionProjectionFrame
    | DshStreamErrorFrame
    | DshUnknownMuxFrame;

export type DshEvent = DshMuxFrame;

export interface DshHostSessionAddedFrame {
    type: "host/session-added";
    sessionId: string;
    blank: boolean;
    parentSessionId?: string;
    origin?: "subagent";
    cwd?: string;
    agentPreset?: string;
}

export interface DshHostSessionRemovedFrame {
    type: "host/session-removed";
    sessionId: string;
}

export interface DshHostSessionStatusFrame {
    type: "host/session-status";
    sessionId: string;
    running: boolean;
}

export interface DshHostAgentErrorFrame {
    type: "host/agent-error";
    sessionId: string;
    message: string;
}

export interface DshWorkspaceView {
    workspaceId: string;
    path: string;
    title: string;
    sessionIds: string[];
    createdAt: string;
    updatedAt: string;
    [key: string]: unknown;
}

export interface DshWorkspaceListResult {
    items: DshWorkspaceView[];
    archivedSessionIds: string[];
}

export interface DshWorkspaceCreateResult {
    workspace: DshWorkspaceView;
    created: boolean;
}

/** Client-safe directory browser rows returned by the RC picker capability. */
export interface DshDirectoryEntry {
    name: string;
    path: string;
    hidden: boolean;
}

/** One directory level and its breadcrumb ancestry. */
export interface DshDirectoryListing {
    path: string;
    home: string;
    crumbs: DshDirectoryEntry[];
    entries: DshDirectoryEntry[];
    truncated: boolean;
}

export interface DshHostWorkspaceChangedFrame {
    type: "host/workspace-changed";
    workspace: DshWorkspaceView;
}

export interface DshHostWorkspaceRemovedFrame {
    type: "host/workspace-removed";
    workspaceId: string;
}

export interface DshHostWorkspaceOrderChangedFrame {
    type: "host/workspace-order-changed";
    workspaceIds: string[];
}

export interface DshHostArchivedSessionsChangedFrame {
    type: "host/archived-sessions-changed";
    archivedSessionIds: string[];
}

export interface DshHostRemoteEventFrame {
    type: "host/remote-event";
    event: string;
    args: unknown[];
}

export interface DshUnknownHostFrame {
    type: string;
    [key: string]: unknown;
}

export type DshHostFrame =
    | DshHostSessionAddedFrame
    | DshHostSessionRemovedFrame
    | DshHostSessionStatusFrame
    | DshHostAgentErrorFrame
    | DshHostWorkspaceChangedFrame
    | DshHostWorkspaceRemovedFrame
    | DshHostWorkspaceOrderChangedFrame
    | DshHostArchivedSessionsChangedFrame
    | DshHostRemoteEventFrame
    | DshStreamErrorFrame
    | DshUnknownHostFrame;

export type DshReceivedEvent = DshMuxFrame & {
    rpcId: string;
    method: string;
    payload: DshMuxFrame;
};

export type DshEventListener = (event: DshReceivedEvent) => void | Promise<void>;

export interface DshAssistantMessage {
    text: string;
    seq?: number;
}

export interface ChatViewState {
    messages: ChatMessage[];
    context: DshContextItem[];
    fileReferenceCandidates?: DshReferenceCandidate[];
    settings?: DshSettingsPanelView;
    dynamicPlugins?: DshDynamicPluginPanelView;
    selection?: DshContextItem;
    selectionEnabled: boolean;
    status: RuntimeStatus;
    busy: boolean;
    /** Plugin-provided label for the current streaming assistant state. */
    agentStatusLabel?: string;
    submitting: boolean;
    cancelling: boolean;
    focusMode: boolean;
    workspaceName?: string;
    currentWorkspace?: {
        workspaceId?: string;
        title: string;
    };
    skills: DshSkillEntry[];
    /**
     * Host-registered slash commands for the current session. Empty when no
     * session is open, or when the connected Runtime exposes no command
     * registry — the composer then offers only its IDE-local commands.
     */
    commands: DshCommandDescriptor[];
    host?: HostBaselineView;
    sessionId?: string;
    agentPreset?: string;
    agentPresetLabel?: string;
    draftWorkspaceId?: string;
    draftWorkspaceTitle?: string;
    sessions: Array<{
        sessionId: string;
        title: string;
        workspaceId?: string;
        workspaceTitle?: string;
        running: boolean;
        attention: boolean;
        archived: boolean;
    }>;
    sessionStatus?: {
        running: boolean;
        attention: boolean;
        turn: TurnStatusView;
        error?: string;
    };
    tokenUsage?: TokenUsageView;
    sessionStats?: SessionStatsView;
    reasoningEffort?: ReasoningEffortView;
    permissions?: PermissionProjectionView;
    todos?: DshTodoItemView[];
    schedule?: DshScheduleItem[];
    imageLimits?: DshImageLimitsView;
    plan?: DshPlanProjection;
    messageFeedback?: DshMessageFeedbackStateView;
    interactions: Array<{
        key: string;
        kind: "approval" | "question" | "plan-review";
        status: "pending" | "submitting" | "resolved" | "failed" | "unavailable";
        toolName?: string;
        reason?: string;
        /** What a pending approval would actually do; absent when unknown. */
        call?: ApprovalCallView;
        questions?: DshQuestionItem[];
        review?: {
            id: string;
            question: string;
            plan: string;
            approve: string;
            decline?: string;
        };
        planHtml?: string;
        outcome?: string;
        error?: string;
    }>;
    queue: Array<{
        id: string;
        placement: "queued" | "steering";
        preview: string;
        editableText?: string;
    }>;
    goal?: GoalHudView;
    subagents?: SubagentTreeView;
    subagentPreview?: SubagentHistoryPreview;
    jobs: JobCenterItem[];
    changeReviews: ChangeReviewView[];
}

export interface DshImageLimitsView {
    maxImageBytes: number;
    maxImagesPerMessage: number;
    maxMessageImageBytes: number;
    mediaTypes: DshImageMediaType[];
}

export interface DshTodoItemView {
    content: string;
    status: "pending" | "in_progress" | "completed";
}

/** Active reminder record projected by the Runtime Schedule package. */
export type DshScheduleItem =
    | {
          id: string;
          kind: "after";
          prompt: string;
          afterSeconds: number;
          scheduledAt: string;
      }
    | {
          id: string;
          kind: "at";
          prompt: string;
          scheduledAt: string;
      }
    | {
          id: string;
          kind: "every";
          prompt: string;
          everySeconds: number;
          scheduledAt: string;
      };

export interface ChangeReviewView {
    turn: number;
    state: "capturing" | "ready" | "error";
    files: Array<{
        id: string;
        status: "added" | "modified" | "deleted" | "renamed";
        path: string;
        oldPath?: string;
        restorable: boolean;
    }>;
    restored: boolean;
    error?: string;
}

export interface TokenUsageView {
    route: {
        provider?: string;
        model?: string;
        reasoningEffort?: string;
    };
    billing?: {
        uncachedInputTokens: number;
        outputTokens: number;
        reasoningTokens?: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
    };
    context?: {
        /** Provider-reported prompt size for the most recently completed request. */
        pressureTokens?: number;
        /** Provider-anchored estimate of the next request's prompt size. */
        projectedTokens?: number;
        contextWindow?: number;
    };
    /**
     * Heuristic attribution of what currently occupies the context, from the
     * `contextBreakdown` projection. These are the Harness estimator's figures,
     * not provider-billed counts, so they answer "what is filling the window"
     * rather than "what was charged".
     */
    breakdown?: {
        systemTokens: number;
        toolsTokens: number;
        messageTokens: number;
    };
}

export interface SessionStatsView {
    turns: number;
    steps: number;
    llmMs: number;
    toolMs: number;
    ttftMs: number;
    ttftSteps: number;
    decodeMs: number;
    decodeTokens: number;
}

/**
 * What a pending approval would actually do, read off the tool's own call
 * presentation. An approval frame names only the tool, which is not enough to
 * decide on — a reader needs the command, or the files, in front of them.
 */
export interface ApprovalCallView {
    callId: string;
    /** Header the tool chose for this call. */
    title?: string;
    /** The shell command, for a call that IS a command. */
    command?: string;
    cwd?: string;
    /** Files the call would change, for a call that writes. */
    diffPaths?: string[];
    /** Salient input for any other kind of call. */
    detail?: string;
}

export interface PermissionProjectionView {
    currentValue: string;
    currentLabel: string;
    options: Array<{
        value: string;
        label: string;
        description?: string;
    }>;
}

export interface TurnStatusView {
    phase: "queued" | "running" | "waiting" | "completed" | "cancelled" | "failed";
    turn?: number;
    detail?: string;
}

export interface HarnessHostDescription {
    version: string;
    cwd: string;
    provider?: string;
    model?: string;
    attachedSessions: number;
    canOpenPath: boolean;
}

/** Official goal.edit constraint: at least one replacement must be present. */
export type HarnessGoalEditChanges =
    | { objective: string; maxGoalRounds?: number }
    | { objective?: never; maxGoalRounds: number };

export type HarnessQueueAction =
    | { kind: "edit"; content: Array<Record<string, unknown>> }
    | { kind: "remove" }
    | { kind: "steer" };

/** Store-level record envelope: one host event with its identity and payload. */
export interface HarnessStreamEnvelope<F> {
    rpcId: string;
    method: string;
    payload: F;
}

export interface HostBaselineView {
    version: string;
    cwd: string;
    provider?: string;
    model?: string;
    attachedSessions: number;
    canOpenPath: boolean;
}

export interface GoalHudView {
    state: "empty" | "present" | "invalid";
    goal?: DshGoalSnapshot;
    roundsStarted?: number;
    createdAt?: number;
    updatedAt?: number;
    pending?: boolean;
    pendingOperation?:
        | "create"
        | "edit"
        | "pause"
        | "resume"
        | "complete"
        | "clear";
    error?: string;
}

export interface SubagentTreeNodeView {
    kind: "child" | "diagnostic";
    id: string;
    parentSessionId: string;
    depth: number;
    parentAvailable: boolean;
    label?: string;
    mode?: "one-shot" | "continuable";
    activity?: "running" | "inactive";
    timing?: SubagentTimingView;
    hasChildren?: boolean;
    reason?: "corrupt" | "unsupported" | "unavailable";
}

export interface SubagentTreeView {
    rootSessionId: string;
    state: "loading" | "ready" | "error";
    nodes: SubagentTreeNodeView[];
    error?: string;
}

export interface SubagentHistoryPreview {
    rootSessionId: string;
    childSessionId: string;
    label: string;
    mode: "one-shot" | "continuable";
    parentAvailable: boolean;
    activity: "running" | "inactive";
    timing?: SubagentTimingView;
    state: "loading" | "ready" | "error";
    messages: ChatMessage[];
    pendingAction?: "follow-up" | "interrupt";
    error?: string;
}

export interface JobCenterItem {
    id: string;
    kind: string;
    label: string;
    ownerSessionId: string;
    status: DshJobView["status"];
    outputSummary?: string;
    startedAt: number;
    finishedAt?: number;
}
