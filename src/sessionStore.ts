import { t } from "./localize";
import {
    DshHistoryEntry,
    DshHistoryEvent,
    DshHistoryResult,
    DshApprovalRequested,
    DshApprovalResolved,
    DshJobView,
    DshMuxFrame,
    DshQuestionItem,
    DshQuestionRequested,
    DshQuestionResolved,
    DshQueuedInboxItem,
    DshRpcReceipt,
    DshSessionEvent,
    DshSessionProjectionsBlock,
    HarnessStreamEnvelope,
} from "./types";
import { isRecord } from "./guards";
import type { AssistantStreamState } from "./assistantStream";

/** Exact current Harness SurfaceEventType union from @deepseek-ai/dsh-session. */
const SURFACE_EVENT_TYPES = new Set([
    "system/message",
    "user/message",
    "assistant/message",
    "tool/result",
]);

export interface SessionStoreDiagnostic {
    sessionId?: string;
    code:
        | "invalid-event"
        | "event-gap"
        | "surface-invalid"
        | "invalid-frame"
        | "unknown-frame";
    message: string;
    value?: unknown;
}

export interface StoredSessionEvent {
    event: DshSessionEvent;
    view?: unknown;
    source: "history" | "live";
}

export interface SurfaceNode extends StoredSessionEvent {
    seq: number;
    sourceEventSeqs: readonly number[];
}

export interface SurfaceFoldEvent {
    event: DshSessionEvent;
    view?: unknown;
    source?: "history" | "live";
}

export interface SurfaceReplacement {
    seq: number;
    start: number;
    end: number;
    shadowedSeqs: readonly number[];
}

export interface SessionSurfaceSnapshot {
    nodes: readonly SurfaceNode[];
    replacements: readonly SurfaceReplacement[];
    /** False while history pages leave any raw seq gap in the known window. */
    complete: boolean;
    issues: readonly string[];
}

export interface ProjectionCell {
    key: string;
    value: unknown;
    seq: number;
}

export interface AuthoritativeSnapshot<T> {
    items: readonly T[];
    revision: number;
    rpcId?: string;
    receivedAt?: number;
    source: "initial" | "frame" | "subscribed-clear";
}

export interface SessionStateSnapshot {
    sessionId: string;
    assistantStream?: AssistantStreamState;
    events: readonly StoredSessionEvent[];
    surface: SessionSurfaceSnapshot;
    projections: readonly ProjectionCell[];
    queue: AuthoritativeSnapshot<DshQueuedInboxItem>;
    jobs: AuthoritativeSnapshot<DshJobView>;
    interactions: readonly SessionInteractionSnapshot[];
    subscribedLastSeq?: number;
    needsHistoryBaseline: boolean;
}

/**
 * The projection cell for `key`, or undefined when the session has no value for
 * it. Absence is meaningful: it means the owning Harness plugin is not composed,
 * so callers must treat it as capability absence rather than an empty value.
 *
 * Accepts an absent snapshot so call sites reading a possibly-unselected session
 * do not each repeat an optional chain.
 *
 * @param snapshot - the session state, or undefined when none is selected.
 * @param key - the projection key.
 * @returns the cell, or undefined.
 */
export function projectionCell(
    snapshot: SessionStateSnapshot | undefined,
    key: string,
): ProjectionCell | undefined {
    return snapshot?.projections.find((cell) => cell.key === key);
}

/**
 * The wire value of the projection for `key`, or undefined when absent.
 *
 * @param snapshot - the session state, or undefined when none is selected.
 * @param key - the projection key.
 * @returns the value as it arrived, still unvalidated.
 */
export function projectionValue(
    snapshot: SessionStateSnapshot | undefined,
    key: string,
): unknown {
    return projectionCell(snapshot, key)?.value;
}

export type SessionInteractionStatus =
    | "pending"
    | "submitting"
    | "resolved"
    | "failed"
    | "unavailable";

interface SessionInteractionBase {
    key: string;
    rpcId: string;
    sessionId: string;
    status: SessionInteractionStatus;
    outcome?: string;
    error?: string;
    receivedAt: number;
}

export interface SessionApprovalInteraction extends SessionInteractionBase {
    kind: "approval";
    approvalId: string;
    toolName: string;
    callId?: string;
    reason?: string;
}

export interface SessionQuestionInteraction extends SessionInteractionBase {
    kind: "question";
    questions: readonly DshQuestionItem[];
}

export type SessionInteractionSnapshot =
    | SessionApprovalInteraction
    | SessionQuestionInteraction;

function isSeq(value: unknown, allowEmpty = false): value is number {
    return (
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= (allowEmpty ? -1 : 0)
    );
}

function normalizeQuestionItems(value: unknown): DshQuestionItem[] | undefined {
    if (!Array.isArray(value) || value.length === 0) return undefined;
    const result: DshQuestionItem[] = [];
    for (const candidate of value) {
        if (
            !isRecord(candidate) ||
            typeof candidate.id !== "string" ||
            typeof candidate.question !== "string" ||
            (candidate.header !== undefined && typeof candidate.header !== "string") ||
            (candidate.detail !== undefined && typeof candidate.detail !== "string") ||
            (candidate.multiSelect !== undefined && typeof candidate.multiSelect !== "boolean")
        ) {
            return undefined;
        }
        let options: DshQuestionItem["options"];
        if (candidate.options !== undefined) {
            if (!Array.isArray(candidate.options)) return undefined;
            options = [];
            for (const option of candidate.options) {
                if (
                    !isRecord(option) ||
                    typeof option.label !== "string" ||
                    (option.description !== undefined && typeof option.description !== "string")
                ) {
                    return undefined;
                }
                options.push({
                    label: option.label,
                    ...(option.description === undefined
                        ? {}
                        : { description: option.description }),
                });
            }
        }
        if (
            candidate.intent !== undefined &&
            (!isRecord(candidate.intent) || typeof candidate.intent.kind !== "string")
        ) {
            return undefined;
        }
        const intent = isRecord(candidate.intent) && typeof candidate.intent.kind === "string"
            ? { ...candidate.intent, kind: candidate.intent.kind }
            : undefined;
        result.push({
            id: candidate.id,
            question: candidate.question,
            ...(candidate.header === undefined ? {} : { header: candidate.header }),
            ...(candidate.detail === undefined ? {} : { detail: candidate.detail }),
            ...(options === undefined ? {} : { options }),
            ...(candidate.multiSelect === undefined
                ? {}
                : { multiSelect: candidate.multiSelect }),
            ...(intent === undefined ? {} : { intent }),
        });
    }
    return result;
}

function normalizeEvent(value: DshHistoryEvent | DshSessionEvent): DshSessionEvent | undefined {
    const raw = value as unknown;
    if (
        !isRecord(raw) ||
        typeof raw.type !== "string" ||
        !isSeq(raw.seq) ||
        typeof raw.time !== "number" ||
        !Number.isFinite(raw.time) ||
        !("data" in raw)
    ) {
        return undefined;
    }
    return raw as unknown as DshSessionEvent;
}

function validSourceSeqs(
    value: unknown,
    currentSeq: number,
    eventType: string,
): value is number[] {
    return (
        Array.isArray(value) &&
        (value.length > 0 || eventType === "assistant/message") &&
        value.every((seq) => isSeq(seq) && seq < currentSeq) &&
        new Set(value).size === value.length
    );
}

function cloneSnapshot<T>(snapshot: AuthoritativeSnapshot<T>): AuthoritativeSnapshot<T> {
    return { ...snapshot, items: [...snapshot.items] };
}

/** Generic projection cells governed solely by the protocol's higher-seq-wins rule. */
/**
 * The call a tool result belongs to. The Runtime records it on the result
 * message's source, older shapes carry it on the content block or the event
 * data; all three are accepted so pairing never silently drops a row.
 */
export function toolResultCallId(event: StoredSessionEvent): string | undefined {
    const data = isRecord(event.event.data) ? event.event.data : undefined;
    const message = isRecord(data?.message) ? data.message : undefined;
    const source = isRecord(message?.source) ? message.source : undefined;
    const block = Array.isArray(message?.content) && isRecord(message.content[0])
        ? message.content[0]
        : undefined;
    if (typeof source?.callId === "string") return source.callId;
    if (typeof block?.toolCallId === "string") return block.toolCallId;
    return typeof data?.callId === "string" ? data.callId : undefined;
}

export class GenericProjectionStore {
    private readonly cells = new Map<string, ProjectionCell>();
    private snapshotCache: ProjectionCell[] | undefined;

    public seed(block: DshSessionProjectionsBlock): boolean {
        if (!isSeq(block.asOfSeq, true) || !isRecord(block.values)) {
            return false;
        }
        let changed = false;
        const incomingKeys = new Set(Object.keys(block.values));
        for (const [key, cell] of this.cells) {
            if (!incomingKeys.has(key) && cell.seq <= block.asOfSeq) {
                this.cells.delete(key);
                this.snapshotCache = undefined;
                changed = true;
            }
        }
        for (const [key, value] of Object.entries(block.values)) {
            changed = this.apply(key, value, block.asOfSeq) || changed;
        }
        return changed;
    }

    public apply(key: string, value: unknown, seq: number): boolean {
        if (!key || !isSeq(seq, true)) {
            return false;
        }
        const current = this.cells.get(key);
        if (current && current.seq >= seq) {
            return false;
        }
        this.cells.set(key, { key, value, seq });
        this.snapshotCache = undefined;
        return true;
    }

    public get(key: string): ProjectionCell | undefined {
        const cell = this.cells.get(key);
        return cell ? { ...cell } : undefined;
    }

    public snapshot(): ProjectionCell[] {
        if (!this.snapshotCache) {
            const cells = Array.from(this.cells.values());
            cells.sort((left, right) => left.key.localeCompare(right.key));
            this.snapshotCache = cells.map((cell) => ({ ...cell }));
        }
        return this.snapshotCache.slice();
    }
}

/** Raw, seq-addressed event log plus the independently derived current surface. */
export class SessionEventStore {
    private readonly events = new Map<number, StoredSessionEvent>();
    /**
     * `ordered()` is read far more often than the event log changes (a single publish can
     * request it for both the surface and the public snapshot). Keep the sorted, cloned view
     * until an upsert invalidates it so repeated reads do not allocate one object per event.
     */
    private orderedCache: StoredSessionEvent[] | undefined;
    private surfaceState: {
        nodes: SurfaceNode[];
        replacements: SurfaceReplacement[];
        issues: string[];
    } | undefined;
    private surfaceCache: SessionSurfaceSnapshot | undefined;
    private highestSequence = -1;
    /** Highest sequence for which every event from zero through this value is present. */
    private contiguousSequence = -1;
    private subscribedLastSeq: number | undefined;
    private gapObserved = false;

    public constructor(
        public readonly sessionId: string,
        private readonly onDiagnostic?: (diagnostic: SessionStoreDiagnostic) => void,
    ) {}

    public ingestHistory(entries: readonly DshHistoryEntry[]): boolean {
        let changed = false;
        for (const entry of entries) {
            const event = normalizeEvent(entry.event);
            if (!event) {
                this.diagnostic("invalid-event", "History contained an invalid session event", entry);
                continue;
            }
            changed = this.upsert(event, entry.view, "history") || changed;
        }
        if (this.isFullyContiguous()) {
            this.gapObserved = false;
        }
        return changed;
    }

    /**
     * Install a complete Remote follow/page history baseline.
     *
     * A generation rebaseline replaces stale history, while retaining live
     * events that arrived after the opening snapshot was read. This keeps a
     * concurrent follow stream from being truncated by a slow page request.
     */
    public replaceHistory(entries: readonly DshHistoryEntry[]): boolean {
        const incoming = new Map<number, StoredSessionEvent>();
        for (const entry of entries) {
            const event = normalizeEvent(entry.event);
            if (!event) {
                this.diagnostic("invalid-event", "Remote history contained an invalid session event", entry);
                continue;
            }
            incoming.set(event.seq, { event, view: entry.view, source: "history" });
        }
        let incomingHighest = -1;
        for (const seq of incoming.keys()) incomingHighest = Math.max(incomingHighest, seq);
        for (const [seq, stored] of this.events) {
            if (seq > incomingHighest && stored.source === "live") incoming.set(seq, stored);
        }
        this.events.clear();
        for (const [seq, stored] of incoming) this.events.set(seq, stored);
        this.highestSequence = -1;
        this.contiguousSequence = -1;
        while (this.events.has(this.contiguousSequence + 1)) this.contiguousSequence += 1;
        for (const seq of this.events.keys()) this.highestSequence = Math.max(this.highestSequence, seq);
        this.gapObserved = this.contiguousSequence < (this.subscribedLastSeq ?? -1);
        this.orderedCache = undefined;
        this.surfaceState = undefined;
        this.surfaceCache = undefined;
        return true;
    }

    public ingestLive(eventValue: DshSessionEvent, view?: unknown): boolean {
        const event = normalizeEvent(eventValue);
        if (!event) {
            this.diagnostic("invalid-event", "Live stream contained an invalid session event", eventValue);
            return false;
        }
        const highest = this.highestSequence;
        if (highest >= 0 && event.seq > highest + 1) {
            this.gapObserved = true;
            this.diagnostic(
                "event-gap",
                `Live event seq ${event.seq} arrived after ${highest}; history rebaseline required`,
                event,
            );
        }
        return this.upsert(event, view, "live");
    }

    public subscribed(lastSeq: number): void {
        if (!isSeq(lastSeq, true)) {
            this.diagnostic("invalid-frame", "session/subscribed carried an invalid lastSeq", lastSeq);
            return;
        }
        this.subscribedLastSeq = lastSeq;
        if (this.contiguousSequence < lastSeq) {
            this.gapObserved = true;
        }
    }

    /** Set the latest sequence represented by an RC follow opening snapshot. */
    public followCursor(cursor: number, incomplete = false): void {
        if (!isSeq(cursor, true)) {
            this.diagnostic("invalid-frame", "session/follow carried an invalid cursor", cursor);
            return;
        }
        this.subscribedLastSeq = cursor;
        this.highestSequence = Math.max(this.highestSequence, cursor);
        this.gapObserved = incomplete;
    }

    public get needsHistoryBaseline(): boolean {
        return this.gapObserved;
    }

    public get subscribedWatermark(): number | undefined {
        return this.subscribedLastSeq;
    }

    public ordered(): StoredSessionEvent[] {
        if (this.orderedCache) {
            // Preserve the historical defensive array-copy behavior without cloning every
            // StoredSessionEvent on each read.
            return this.orderedCache.slice();
        }

        const ordered = Array.from(this.events.values());
        ordered.sort((left, right) => left.event.seq - right.event.seq);
        this.orderedCache = ordered.map((stored) => ({ ...stored }));
        return this.orderedCache.slice();
    }

    public surface(): SessionSurfaceSnapshot {
        if (this.surfaceCache) {
            return this.surfaceCache;
        }
        if (!this.surfaceState) {
            const folded = foldSessionSurface(this.ordered(), (issue) =>
                this.diagnostic("surface-invalid", issue),
            );
            this.surfaceState = {
                nodes: [...folded.nodes],
                replacements: [...folded.replacements],
                issues: [...folded.issues],
            };
        }
        this.surfaceCache = {
            nodes: this.surfaceState.nodes.slice(),
            replacements: this.surfaceState.replacements.slice(),
            issues: this.surfaceState.issues.slice(),
            complete: this.isFullyContiguous(),
        };
        return this.surfaceCache;
    }

    private upsert(
        event: DshSessionEvent,
        view: unknown,
        source: "history" | "live",
    ): boolean {
        const existing = this.events.get(event.seq);
        if (!existing) {
            const previousHighest = this.highestSequence;
            const stored = { event, view, source } satisfies StoredSessionEvent;
            this.events.set(event.seq, stored);
            this.highestSequence = Math.max(this.highestSequence, event.seq);
            if (event.seq === this.contiguousSequence + 1) {
                while (this.events.has(this.contiguousSequence + 1)) {
                    this.contiguousSequence += 1;
                }
            }

            if (this.orderedCache && event.seq > previousHighest) {
                this.orderedCache.push({ ...stored });
            } else {
                this.orderedCache = undefined;
            }
            this.extendSurfaceCache(stored, event.seq > previousHighest);
            return true;
        }

        const shouldReplaceEvent = existing.source === "history" && source === "live";
        const shouldReplaceView = view !== undefined && view !== existing.view;
        if (!shouldReplaceEvent && !shouldReplaceView) {
            return false;
        }
        const stored = {
            event: shouldReplaceEvent ? event : existing.event,
            view: shouldReplaceView ? view : existing.view,
            source: shouldReplaceEvent ? source : existing.source,
        } satisfies StoredSessionEvent;
        this.events.set(event.seq, stored);
        if (this.orderedCache) {
            const index = this.findOrderedIndex(event.seq);
            if (index >= 0) {
                this.orderedCache[index] = { ...stored };
            } else {
                this.orderedCache = undefined;
            }
        }
        this.surfaceState = undefined;
        this.surfaceCache = undefined;
        return true;
    }

    private extendSurfaceCache(stored: StoredSessionEvent, appended: boolean): void {
        if (!this.surfaceState) {
            return;
        }
        if (!appended) {
            this.surfaceState = undefined;
            this.surfaceCache = undefined;
            return;
        }

        if (surfaceEventMayChange(stored.event)) {
            applySurfaceEvent(
                stored,
                this.surfaceState.nodes,
                this.surfaceState.replacements,
                this.surfaceState.issues,
                (issue) => this.diagnostic("surface-invalid", issue),
            );
        }
        this.surfaceCache = undefined;
    }

    private findOrderedIndex(seq: number): number {
        const ordered = this.orderedCache;
        if (!ordered) return -1;
        let low = 0;
        let high = ordered.length - 1;
        while (low <= high) {
            const middle = (low + high) >>> 1;
            const candidate = ordered[middle].event.seq;
            if (candidate === seq) return middle;
            if (candidate < seq) {
                low = middle + 1;
            } else {
                high = middle - 1;
            }
        }
        return -1;
    }

    private isFullyContiguous(): boolean {
        return this.contiguousSequence === this.highestSequence;
    }

    private diagnostic(
        code: SessionStoreDiagnostic["code"],
        message: string,
        value?: unknown,
    ): void {
        this.onDiagnostic?.({ sessionId: this.sessionId, code, message, value });
    }
}

function surfaceEventMayChange(event: DshSessionEvent): boolean {
    const raw = event as unknown as Record<string, unknown>;
    return (
        SURFACE_EVENT_TYPES.has(event.type) ||
        raw.surfaceOp !== undefined ||
        raw.sourceEventSeqs !== undefined
    );
}

function toSurfaceNode(stored: SurfaceFoldEvent): SurfaceNode {
    return {
        ...stored,
        source: stored.source ?? "history",
        seq: stored.event.seq,
        sourceEventSeqs: Array.isArray(stored.event.sourceEventSeqs)
            ? [...stored.event.sourceEventSeqs]
            : [],
    };
}

function applySurfaceEvent(
    stored: SurfaceFoldEvent,
    nodes: SurfaceNode[],
    replacements: SurfaceReplacement[],
    issues: string[],
    onIssue?: (message: string) => void,
): void {
    const event = stored.event;
    const raw = event as unknown as Record<string, unknown>;
    const operation = raw.surfaceOp;
    const report = (message: string): void => {
        issues.push(message);
        onIssue?.(message);
    };

    if (!SURFACE_EVENT_TYPES.has(event.type)) {
        if (operation !== undefined || raw.sourceEventSeqs !== undefined) {
            report(
                `Event ${event.seq} (${event.type}) is not surface-eligible but carries surface metadata`,
            );
        }
        return;
    }
    if (operation === "append") {
        if (
            raw.sourceEventSeqs !== undefined &&
            !validSourceSeqs(raw.sourceEventSeqs, event.seq, event.type)
        ) {
            report(`Event ${event.seq} carries invalid sourceEventSeqs`);
            return;
        }
        nodes.push(toSurfaceNode(stored));
        return;
    }
    if (
        !isRecord(operation) ||
        operation.op !== "replace" ||
        Object.keys(operation).length !== 3 ||
        !isSeq(operation.start) ||
        !isSeq(operation.end)
    ) {
        report(`Surface event ${event.seq} carries an invalid surfaceOp`);
        return;
    }
    const startIndex = nodes.findIndex((node) => node.event.seq === operation.start);
    const endIndex = nodes.findIndex((node) => node.event.seq === operation.end);
    if (startIndex < 0 || endIndex < startIndex) {
        report(
            `Surface replacement ${event.seq} cannot resolve range ${operation.start}-${operation.end}`,
        );
        return;
    }
    const shadowed = nodes.slice(startIndex, endIndex + 1);
    if (!validSourceSeqs(raw.sourceEventSeqs, event.seq, event.type)) {
        report(`Surface replacement ${event.seq} carries invalid sourceEventSeqs`);
        return;
    }
    const sources = new Set(raw.sourceEventSeqs);
    const missing = shadowed
        .map((node) => node.event.seq)
        .filter((seq) => !sources.has(seq));
    if (missing.length) {
        report(`Surface replacement ${event.seq} omits shadowed seqs ${missing.join(", ")}`);
        return;
    }
    nodes.splice(startIndex, endIndex - startIndex + 1, toSurfaceNode(stored));
    replacements.push({
        seq: event.seq,
        start: operation.start,
        end: operation.end,
        shadowedSeqs: shadowed.map((node) => node.event.seq),
    });
}

/**
 * Pure replay of Harness' current SurfaceEventType contract. Invalid replacement metadata is
 * diagnosed and skipped atomically, keeping the last reconstructable surface available.
 */
export function foldSessionSurface(
    input: readonly SurfaceFoldEvent[],
    onIssue?: (message: string) => void,
): Omit<SessionSurfaceSnapshot, "complete"> {
    // SessionEventStore already supplies seq-ordered input. Avoid a second full-array copy
    // and sort in that hot path, while retaining sorting for standalone unsorted callers.
    let ordered = input;
    for (let index = 1; index < input.length; index += 1) {
        if (input[index - 1].event.seq > input[index].event.seq) {
            ordered = [...input].sort((left, right) => left.event.seq - right.event.seq);
            break;
        }
    }
    const nodes: SurfaceNode[] = [];
    const replacements: SurfaceReplacement[] = [];
    const issues: string[] = [];

    for (const stored of ordered) {
        applySurfaceEvent(stored, nodes, replacements, issues, onIssue);
    }
    return {
        nodes,
        replacements,
        issues,
    };
}

class SessionState {
    public assistantStream: AssistantStreamState | undefined;
    private readonly assistantSettlements = new Map<string, number>();
    public readonly projections = new GenericProjectionStore();
    public readonly events: SessionEventStore;
    private queueState: AuthoritativeSnapshot<DshQueuedInboxItem> = {
        items: [],
        revision: 0,
        source: "initial",
    };
    private jobsState: AuthoritativeSnapshot<DshJobView> = {
        items: [],
        revision: 0,
        source: "initial",
    };
    private readonly interactions = new Map<string, SessionInteractionSnapshot>();

    public constructor(
        public readonly sessionId: string,
        onDiagnostic?: (diagnostic: SessionStoreDiagnostic) => void,
    ) {
        this.events = new SessionEventStore(sessionId, onDiagnostic);
    }

    public recordAssistantSettlement(value: DshHistoryEvent): void {
        const event = normalizeEvent(value);
        if (!event || (event.type !== "assistant/attempt" && event.type !== "assistant/message") ||
            (event.type === "assistant/message" && event.surfaceOp !== "append") ||
            !isSeq(event.seq) || !isRecord(event.data) ||
            !isSeq(event.data.turn) || !isSeq(event.data.step)) return;
        const key = `${event.data.turn}:${event.data.step}`;
        this.assistantSettlements.set(key, Math.max(this.assistantSettlements.get(key) ?? -1, event.seq));
    }

    public rebuildAssistantSettlements(): void {
        this.assistantSettlements.clear();
        for (const stored of this.events.ordered()) this.recordAssistantSettlement(stored.event);
    }

    private visibleAssistantStream(): AssistantStreamState | undefined {
        const stream = this.assistantStream;
        if (!stream) return undefined;
        const settledAt = this.assistantSettlements.get(`${stream.turn}:${stream.step}`);
        // A concurrent history read can learn the settlement before the follow stream.
        // Keep its internal attempt available for end-frame validation, but hide its prefix.
        return settledAt !== undefined && settledAt > stream.startedAfterSeq ? undefined : stream;
    }

    public clearTransientOnSubscribe(receivedAt: number, rpcId: string): void {
        this.queueState = {
            items: [],
            revision: this.queueState.revision + 1,
            rpcId,
            receivedAt,
            source: "subscribed-clear",
        };
        this.jobsState = {
            items: [],
            revision: this.jobsState.revision + 1,
            rpcId,
            receivedAt,
            source: "subscribed-clear",
        };
        // The mux open contract emits subscribed first, then replays every still-pending
        // request with its stable rpcId. Clearing here makes absence authoritative without
        // racing a replay that may have arrived before the connection callback.
        this.interactions.clear();
    }

    public requestApproval(
        frame: DshApprovalRequested,
        rpcId: string,
        receivedAt: number,
    ): void {
        const key = `a:${rpcId}`;
        const current = this.interactions.get(key);
        this.interactions.set(key, {
            kind: "approval",
            key,
            rpcId,
            sessionId: frame.sessionId,
            approvalId: frame.approvalId,
            toolName: frame.toolName,
            ...(frame.callId === undefined ? {} : { callId: frame.callId }),
            ...(frame.reason === undefined ? {} : { reason: frame.reason }),
            // A reconnect may replay the same Gateway event id. Re-open cards
            // that were made unavailable by the dead generation, while
            // preserving an in-flight submission against duplicate delivery.
            status: current?.status === "unavailable" || current?.status === "failed"
                ? "pending"
                : current?.status ?? "pending",
            ...(current?.outcome === undefined ? {} : { outcome: current.outcome }),
            ...(current?.error === undefined ? {} : { error: current.error }),
            receivedAt,
        });
    }

    public resolveApproval(frame: DshApprovalResolved): void {
        for (const [key, interaction] of this.interactions) {
            if (interaction.kind !== "approval" || interaction.approvalId !== frame.approvalId) {
                continue;
            }
            this.interactions.set(key, {
                ...interaction,
                status: "resolved",
                outcome: frame.outcome,
                error: undefined,
            });
        }
    }

    public requestQuestion(
        frame: DshQuestionRequested,
        rpcId: string,
        receivedAt: number,
    ): void {
        const key = `q:${rpcId}`;
        const current = this.interactions.get(key);
        this.interactions.set(key, {
            kind: "question",
            key,
            rpcId,
            sessionId: frame.sessionId,
            questions: frame.questions.map((question) => ({ ...question })),
            status: current?.status === "unavailable" || current?.status === "failed"
                ? "pending"
                : current?.status ?? "pending",
            ...(current?.outcome === undefined ? {} : { outcome: current.outcome }),
            ...(current?.error === undefined ? {} : { error: current.error }),
            receivedAt,
        });
    }

    public resolveQuestion(frame: DshQuestionResolved): void {
        const key = `q:${frame.questionRpcId}`;
        const interaction = this.interactions.get(key);
        if (!interaction || interaction.kind !== "question") {
            return;
        }
        this.interactions.set(key, {
            ...interaction,
            status: "resolved",
            outcome: frame.outcome,
            error: undefined,
        });
    }

    public claimInteraction(key: string): SessionInteractionSnapshot | undefined {
        const interaction = this.interactions.get(key);
        if (!interaction || interaction.status !== "pending") {
            return undefined;
        }
        const claimed: SessionInteractionSnapshot = {
            ...interaction,
            status: "submitting",
            error: undefined,
        };
        this.interactions.set(key, claimed);
        return { ...claimed };
    }

    public settleInteractionReceipt(key: string, receipt: DshRpcReceipt): void {
        const interaction = this.interactions.get(key);
        if (!interaction || interaction.status !== "submitting" || receipt.accepted) {
            return;
        }
        this.interactions.set(key, {
            ...interaction,
            status: receipt.reason === "not-pending" ? "unavailable" : "failed",
            error:
                receipt.reason === "not-pending"
                    ? t("The request is no longer waiting for an answer.")
                    : t("The answer was rejected by Harness: {reason}", { reason: receipt.reason }),
        });
    }

    public failInteraction(key: string, message: string): void {
        const interaction = this.interactions.get(key);
        if (!interaction || interaction.status !== "submitting") {
            return;
        }
        // A transport failure is ambiguous: the host may have accepted the response. Keep
        // the card inert until an authoritative resolved frame or reconnect replay arrives.
        this.interactions.set(key, {
            ...interaction,
            status: "failed",
            error: message,
        });
    }

    public replaceQueue(items: readonly DshQueuedInboxItem[], receivedAt: number, rpcId: string): void {
        this.queueState = {
            items: [...items],
            revision: this.queueState.revision + 1,
            rpcId,
            receivedAt,
            source: "frame",
        };
    }

    public replaceJobs(items: readonly DshJobView[], receivedAt: number, rpcId: string): void {
        this.jobsState = {
            items: [...items],
            revision: this.jobsState.revision + 1,
            rpcId,
            receivedAt,
            source: "frame",
        };
    }

    /** Mark an RC Remote-event answer as accepted without depending on a legacy receipt frame. */
    public settleRemoteInteraction(key: string): void {
        const interaction = this.interactions.get(key);
        if (!interaction || interaction.status !== "submitting") return;
        this.interactions.set(key, {
            ...interaction,
            status: "resolved",
            error: undefined,
        });
    }

    /** Cancel one pending Remote waterfall by its event id (used on reconnect/withdrawal). */
    public cancelRemoteInteraction(eventId: string): void {
        for (const [key, interaction] of this.interactions) {
            if (interaction.rpcId !== eventId) continue;
            this.interactions.set(key, {
                ...interaction,
                status: "unavailable",
                error: t("The request is no longer waiting for an answer."),
            });
        }
    }

    /**
     * A Remote generation is gone, so no pending waterfall answer can be
     * submitted safely against it. Keep the card visible but inert until the
     * next generation replays an authoritative request.
     */
    public markRemoteInteractionsUnavailable(): boolean {
        let changed = false;
        for (const [key, interaction] of this.interactions) {
            if (interaction.status !== "pending" && interaction.status !== "submitting") continue;
            this.interactions.set(key, {
                ...interaction,
                status: "unavailable",
                error: t("The Remote connection was reset before the request received an answer."),
            });
            changed = true;
        }
        return changed;
    }

    public snapshot(): SessionStateSnapshot {
        return {
            sessionId: this.sessionId,
            assistantStream: this.visibleAssistantStream(),
            events: this.events.ordered(),
            surface: this.events.surface(),
            projections: this.projections.snapshot(),
            queue: cloneSnapshot(this.queueState),
            jobs: cloneSnapshot(this.jobsState),
            interactions: [...this.interactions.values()]
                .sort((left, right) => left.receivedAt - right.receivedAt)
                .map((interaction) => ({ ...interaction })),
            subscribedLastSeq: this.events.subscribedWatermark,
            needsHistoryBaseline: this.events.needsHistoryBaseline,
        };
    }
}

export type SessionStateListener = (sessionId: string, snapshot: SessionStateSnapshot) => void;

/** Routes mux frames into isolated per-session state containers. */
export class HarnessSessionStore {
    private readonly sessions = new Map<string, SessionState>();
    private readonly listeners = new Set<SessionStateListener>();
    private readonly pendingPublishes = new Set<SessionState>();
    private publishHandle: ReturnType<typeof setImmediate> | undefined;

    public constructor(
        private readonly onDiagnostic?: (diagnostic: SessionStoreDiagnostic) => void,
        private readonly now: () => number = Date.now,
    ) {}

    /**
     * Returns a plain unsubscribe function rather than a `vscode.Disposable`:
     * this module stays free of the editor API so `test/` can load it from
     * `dist/` under `node --test`. Callers that need a Disposable wrap it
     * themselves (see chatView.ts pushing `new vscode.Disposable(...)`).
     */
    public onDidChange(listener: SessionStateListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    public rebaseline(sessionId: string, history: DshHistoryResult): SessionStateSnapshot {
        const state = this.state(sessionId);
        state.events.ingestHistory(history.events);
        for (const entry of history.events) state.recordAssistantSettlement(entry.event);
        if (history.projections) {
            state.projections.seed(history.projections);
        }
        return this.publish(state);
    }

    /** Install a generation-scoped RC follow baseline and clear stale stream state. */
    public replaceRemoteBaseline(
        sessionId: string,
        history: DshHistoryResult,
        cursor?: number,
    ): SessionStateSnapshot {
        const state = this.state(sessionId);
        state.events.replaceHistory(history.events);
        state.rebuildAssistantSettlements();
        if (cursor !== undefined) state.events.followCursor(cursor, history.hasMore === true);
        if (history.projections) state.projections.seed(history.projections);
        return this.publish(state);
    }

    /** Apply an RC journal event after its Remote envelope has been decoded. */
    public applyRemoteEvent(sessionId: string, event: unknown): void {
        if (!isRecord(event)) {
            this.diagnostic("invalid-frame", "Remote session event is malformed", event);
            return;
        }
        const state = this.state(sessionId);
        state.events.ingestLive(event as unknown as DshSessionEvent);
        state.recordAssistantSettlement(event as unknown as DshSessionEvent);
        this.schedulePublish(state);
    }

    /** Update transient model output without consuming a durable journal sequence. */
    public applyRemoteAssistantStream(sessionId: string, stream: AssistantStreamState | undefined): void {
        const state = this.state(sessionId);
        state.assistantStream = stream;
        this.schedulePublish(state);
    }

    public clearRemoteAssistantStreams(): void {
        for (const state of this.sessions.values()) {
            if (!state.assistantStream) continue;
            state.assistantStream = undefined;
            this.schedulePublish(state);
        }
    }

    public applyRemoteProjection(sessionId: string, key: string, value: unknown, seq: number): void {
        const state = this.state(sessionId);
        if (state.projections.apply(key, value, seq)) this.schedulePublish(state);
    }

    public applyRemoteQueue(sessionId: string, items: unknown[]): void {
        const state = this.state(sessionId);
        state.replaceQueue(items as unknown as DshQueuedInboxItem[], this.now(), "remote-control");
        this.schedulePublish(state);
    }

    public applyRemoteJobs(sessionId: string, jobs: unknown[]): void {
        const state = this.state(sessionId);
        state.replaceJobs(jobs as unknown as DshJobView[], this.now(), "remote-control");
        this.schedulePublish(state);
    }

    public applyRemoteControl(
        sessionId: string,
        queue: unknown[],
        jobs: unknown[],
        projections: DshSessionProjectionsBlock | undefined,
    ): void {
        const state = this.state(sessionId);
        state.replaceQueue(queue as unknown as DshQueuedInboxItem[], this.now(), "remote-control");
        state.replaceJobs(jobs as unknown as DshJobView[], this.now(), "remote-control");
        if (projections) state.projections.seed(projections);
        this.schedulePublish(state);
    }

    public applyRemoteApproval(sessionId: string, eventId: string, request: Record<string, unknown>): boolean {
        if (typeof request.toolName !== "string") return false;
        const state = this.state(sessionId);
        state.requestApproval({
            type: "approval/requested",
            sessionId,
            approvalId: eventId,
            toolName: request.toolName,
            ...(typeof request.callId === "string" ? { callId: request.callId } : {}),
            ...(typeof request.reason === "string" ? { reason: request.reason } : {}),
        }, eventId, this.now());
        this.schedulePublish(state);
        return true;
    }

    public applyRemoteQuestion(sessionId: string, eventId: string, request: Record<string, unknown>): boolean {
        const questions = normalizeQuestionItems(request.questions);
        if (!questions) return false;
        const state = this.state(sessionId);
        state.requestQuestion({ type: "question/requested", sessionId, questions }, eventId, this.now());
        this.schedulePublish(state);
        return true;
    }

    public cancelRemoteInteraction(eventId: string): void {
        for (const state of this.sessions.values()) {
            state.cancelRemoteInteraction(eventId);
            this.schedulePublish(state);
        }
    }

    /** Mark all in-flight Remote waterfall cards unavailable after a generation loss. */
    public markRemoteInteractionsUnavailable(): void {
        for (const state of this.sessions.values()) {
            if (state.markRemoteInteractionsUnavailable()) this.schedulePublish(state);
        }
    }

    public settleRemoteInteraction(sessionId: string, key: string): void {
        const state = this.sessions.get(sessionId);
        if (!state) return;
        state.settleRemoteInteraction(key);
        this.publish(state);
    }

    /**
     * Reports a frame that failed its per-type validation.
     *
     * The type is read from the frame rather than spelled out per call site, so
     * the diagnostic cannot drift from the `case` label it belongs to.
     */
    private malformedFrame(frame: Record<string, unknown>): void {
        this.diagnostic("invalid-frame", `${String(frame.type)} frame is malformed`, frame);
    }

    public applyMuxEnvelope(envelope: HarnessStreamEnvelope<DshMuxFrame>): void {
        const frame = envelope.payload as unknown;
        if (!isRecord(frame) || typeof frame.type !== "string") {
            this.diagnostic("invalid-frame", "Mux stream carried an invalid frame", frame);
            return;
        }
        const sessionId = typeof frame.sessionId === "string" ? frame.sessionId : undefined;

        switch (frame.type) {
            case "session/event": {
                if (!sessionId || !isRecord(frame.event)) {
                    this.malformedFrame(frame);
                    return;
                }
                const state = this.state(sessionId);
                state.events.ingestLive(frame.event as unknown as DshSessionEvent, frame.view);
                state.recordAssistantSettlement(frame.event as unknown as DshSessionEvent);
                this.schedulePublish(state);
                return;
            }
            case "session/subscribed": {
                if (!sessionId || !isSeq(frame.lastSeq, true)) {
                    this.malformedFrame(frame);
                    return;
                }
                const state = this.state(sessionId);
                state.events.subscribed(frame.lastSeq);
                state.clearTransientOnSubscribe(this.now(), envelope.rpcId);
                this.schedulePublish(state);
                return;
            }
            case "session/projection": {
                if (
                    !sessionId ||
                    typeof frame.key !== "string" ||
                    !isSeq(frame.seq, true) ||
                    !("value" in frame)
                ) {
                    this.malformedFrame(frame);
                    return;
                }
                const state = this.state(sessionId);
                if (state.projections.apply(frame.key, frame.value, frame.seq)) {
                    this.schedulePublish(state);
                }
                return;
            }
            case "session/queue": {
                if (!sessionId || !Array.isArray(frame.items)) {
                    this.malformedFrame(frame);
                    return;
                }
                const state = this.state(sessionId);
                state.replaceQueue(
                    frame.items as unknown as DshQueuedInboxItem[],
                    this.now(),
                    envelope.rpcId,
                );
                this.schedulePublish(state);
                return;
            }
            case "session/jobs": {
                if (!sessionId || !Array.isArray(frame.jobs)) {
                    this.malformedFrame(frame);
                    return;
                }
                const state = this.state(sessionId);
                state.replaceJobs(
                    frame.jobs as unknown as DshJobView[],
                    this.now(),
                    envelope.rpcId,
                );
                this.schedulePublish(state);
                return;
            }
            case "approval/requested": {
                if (
                    !sessionId ||
                    typeof frame.approvalId !== "string" ||
                    typeof frame.toolName !== "string" ||
                    (frame.callId !== undefined && typeof frame.callId !== "string") ||
                    (frame.reason !== undefined && typeof frame.reason !== "string")
                ) {
                    this.malformedFrame(frame);
                    return;
                }
                const state = this.state(sessionId);
                state.requestApproval(
                    {
                        type: "approval/requested",
                        sessionId,
                        approvalId: frame.approvalId,
                        toolName: frame.toolName,
                        ...(frame.callId === undefined ? {} : { callId: frame.callId }),
                        ...(frame.reason === undefined ? {} : { reason: frame.reason }),
                    },
                    envelope.rpcId,
                    this.now(),
                );
                this.schedulePublish(state);
                return;
            }
            case "approval/resolved": {
                if (
                    !sessionId ||
                    typeof frame.approvalId !== "string" ||
                    typeof frame.outcome !== "string"
                ) {
                    this.malformedFrame(frame);
                    return;
                }
                const state = this.state(sessionId);
                state.resolveApproval({
                    type: "approval/resolved",
                    sessionId,
                    approvalId: frame.approvalId,
                    outcome: frame.outcome,
                });
                this.schedulePublish(state);
                return;
            }
            case "question/requested": {
                const questions = normalizeQuestionItems(frame.questions);
                if (!sessionId || !questions) {
                    this.malformedFrame(frame);
                    return;
                }
                const state = this.state(sessionId);
                state.requestQuestion(
                    { type: "question/requested", sessionId, questions },
                    envelope.rpcId,
                    this.now(),
                );
                this.schedulePublish(state);
                return;
            }
            case "question/resolved": {
                if (
                    !sessionId ||
                    typeof frame.questionRpcId !== "string" ||
                    typeof frame.outcome !== "string"
                ) {
                    this.malformedFrame(frame);
                    return;
                }
                const state = this.state(sessionId);
                state.resolveQuestion({
                    type: "question/resolved",
                    sessionId,
                    questionRpcId: frame.questionRpcId,
                    outcome: frame.outcome,
                });
                this.schedulePublish(state);
                return;
            }
            case "stream/error":
                return;
            default:
                this.diagnostic("unknown-frame", `Unknown mux frame ${frame.type}`, frame);
        }
    }

    public get(sessionId: string): SessionStateSnapshot | undefined {
        return this.sessions.get(sessionId)?.snapshot();
    }

    public list(): SessionStateSnapshot[] {
        return [...this.sessions.values()].map((state) => state.snapshot());
    }

    /** Atomically claims an answerable request; a second click receives undefined. */
    public claimInteraction(
        sessionId: string,
        key: string,
    ): SessionInteractionSnapshot | undefined {
        const state = this.sessions.get(sessionId);
        if (!state) {
            return undefined;
        }
        const interaction = state.claimInteraction(key);
        if (interaction) {
            this.publish(state);
        }
        return interaction;
    }

    public settleInteractionReceipt(
        sessionId: string,
        key: string,
        receipt: DshRpcReceipt,
    ): void {
        const state = this.sessions.get(sessionId);
        if (!state) {
            return;
        }
        state.settleInteractionReceipt(key, receipt);
        this.publish(state);
    }

    public failInteraction(sessionId: string, key: string, message: string): void {
        const state = this.sessions.get(sessionId);
        if (!state) {
            return;
        }
        state.failInteraction(key, message);
        this.publish(state);
    }

    private state(sessionId: string): SessionState {
        let state = this.sessions.get(sessionId);
        if (!state) {
            state = new SessionState(sessionId, this.onDiagnostic);
            this.sessions.set(sessionId, state);
        }
        return state;
    }

    /** Coalesce a burst of mux frames into one snapshot and listener notification per session. */
    private schedulePublish(state: SessionState): void {
        this.pendingPublishes.add(state);
        if (this.publishHandle) {
            return;
        }
        this.publishHandle = setImmediate(() => {
            this.publishHandle = undefined;
            const pending = Array.from(this.pendingPublishes);
            this.pendingPublishes.clear();
            for (const pendingState of pending) {
                this.publish(pendingState);
            }
        });
    }

    private publish(state: SessionState): SessionStateSnapshot {
        this.pendingPublishes.delete(state);
        const snapshot = state.snapshot();
        for (const listener of this.listeners) {
            listener(state.sessionId, snapshot);
        }
        return snapshot;
    }

    private diagnostic(
        code: SessionStoreDiagnostic["code"],
        message: string,
        value?: unknown,
    ): void {
        this.onDiagnostic?.({ code, message, value });
    }
}
