import type { RemoteEventFrame, RemoteEventReadyFrame } from "./contracts";
import { RemoteConnectionController, type RemoteConnectionState } from "./connection";
import { RemoteUnaryClient } from "./unaryClient";
import {
    historyEntries as remoteHistoryEntries,
    projectionBlock as remoteProjectionBlock,
    sessionCursor,
    type RemoteSessionAddress,
} from "./sessionState";
import { workspaceBaseline, workspaceView } from "./workspaceState";
import { RemoteAssistantStream } from "../assistantStream";
import { RUNTIME_DEFAULT_VERSION } from "../managedRuntime/types";
import { HarnessCatalogStore } from "../sessionCatalog";
import { HarnessSessionStore, type SessionStateSnapshot } from "../sessionStore";
import type {
    DshHostFrame,
    DshHistoryEntry,
    DshHistoryResult,
    DshSessionListResult,
    DshSessionProjectionsBlock,
    DshSessionSummary,
} from "../types";

export interface RemoteStateCoordinatorSinks {
    onConnectionState?: (state: RemoteConnectionState) => void;
    onHostDescription?: (description: {
        version: string;
        cwd: string;
        attachedSessions: number;
        canOpenPath: boolean;
    }) => void;
    onHostFrame?: (frame: DshHostFrame) => void;
    onSessionChange?: (sessionId: string, snapshot: SessionStateSnapshot) => void;
    onRemoteEvent?: (event: string) => void;
    onDiagnostic?: (message: string, cause?: unknown) => void;
}

export interface RemoteStateCoordinatorOptions {
    historyPageSize?: number;
    runtimeVersion?: string;
}

interface Deferred {
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: unknown) => void;
}

function deferred(): Deferred {
    let resolvePromise!: () => void;
    let rejectPromise!: (error: unknown) => void;
    const promise = new Promise<void>((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
    });
    return { promise, resolve: resolvePromise, reject: rejectPromise };
}

/**
 * Reconnect-safe domain coordinator for the RC Remote streams.  Wire frames
 * are decoded here and converted into the existing editor-facing stores; the
 * stores themselves remain unaware of HTTP/WebSocket details.
 */
export class RemoteStateCoordinator implements AsyncDisposable {
    public readonly sessions: HarnessSessionStore;
    public readonly catalog: HarnessCatalogStore;
    private readonly historyPageSize: number;
    private readonly syncing = new Map<string, Promise<void>>();
    private readonly historyAborts = new Set<AbortController>();
    private readonly connection: RemoteConnectionController;
    private readonly unary: RemoteUnaryClient;
    private readonly sinks: RemoteStateCoordinatorSinks;
    private generationAbort: AbortController | undefined;
    /** Addresses explicitly requested by a visible surface (chat/trace/subagent). */
    private readonly desiredAddresses = new Map<string, RemoteSessionAddress>();
    /** Addresses with a live follow stream in the current physical generation. */
    private readonly followedAddresses = new Set<string>();
    private generationReady = false;
    private controlBaseline:
        { queues: Record<string, unknown>; jobs: Record<string, unknown>; projections: Record<string, unknown> }
        | undefined;
    private runtimeVersion: string;
    private stopped = false;

    public constructor(
        connection: RemoteConnectionController,
        sinks: RemoteStateCoordinatorSinks = {},
        options: RemoteStateCoordinatorOptions = {},
    ) {
        this.sinks = sinks;
        this.connection = connection;
        this.unary = connection.unary;
        this.historyPageSize = Math.max(1, options.historyPageSize ?? 100);
        this.runtimeVersion = options.runtimeVersion ?? RUNTIME_DEFAULT_VERSION;
        this.catalog = new HarnessCatalogStore();
        this.sessions = new HarnessSessionStore((diagnostic) =>
            sinks.onDiagnostic?.(diagnostic.message, diagnostic.value),
        );
        this.sessions.onDidChange((sessionId, snapshot) => {
            const active = snapshot.interactions.filter(
                (interaction) => interaction.status === "pending" || interaction.status === "submitting",
            );
            this.catalog.setPendingInteraction(
                sessionId,
                active.some((interaction) => interaction.kind === "approval")
                    ? "approval"
                    : active.some((interaction) => interaction.kind === "question")
                        ? "question"
                        : undefined,
            );
            sinks.onSessionChange?.(sessionId, snapshot);
            if (snapshot.needsHistoryBaseline && !this.stopped) void this.syncHistory(sessionId);
        });
        connection.onConnected((ready, generation) => this.onConnected(ready, generation));
        connection.onEvent((frame) => this.onRemoteEvent(frame));
        connection.onStateChange((state) => {
            if (state === "reconnecting" || state === "stopped") {
                this.generationAbort?.abort();
                this.generationReady = false;
                this.sessions.clearRemoteAssistantStreams();
                this.sessions.markRemoteInteractionsUnavailable();
            }
            this.sinks.onConnectionState?.(state);
        });
    }

    public start(): void {
        this.stopped = false;
        this.connection.start();
    }

    public async stop(): Promise<void> {
        this.stopped = true;
        this.generationAbort?.abort();
        for (const abort of this.historyAborts) abort.abort();
        await this.connection.stop();
        await Promise.allSettled(this.syncing.values());
    }

    public async [Symbol.asyncDispose](): Promise<void> {
        await this.stop();
    }

    public syncHistory(sessionId: string): Promise<void> {
        this.watchSession(sessionId);
        const current = this.syncing.get(sessionId);
        if (current) return current;
        const sync = this.readCompleteHistory(sessionId)
            .catch((error) => {
                if (!this.stopped) this.diagnostic(`Failed to rebaseline session ${sessionId}`, error);
            })
            .finally(() => {
                if (this.syncing.get(sessionId) === sync) this.syncing.delete(sessionId);
            });
        this.syncing.set(sessionId, sync);
        return sync;
    }

    /** Keep one ordinary Session live while a UI surface has it open. */
    public watchSession(sessionId: string): void {
        if (!sessionId) return;
        const address: RemoteSessionAddress = { kind: "session", sessionId };
        this.desiredAddresses.set(addressKey(address), address);
        this.startAddressFollow(address);
    }

    /** Keep one addressed subagent live while its trace/preview is visible. */
    public watchSubagent(address: Extract<RemoteSessionAddress, { kind: "subagent" }>): void {
        if (!address.parentSessionId || !address.childSessionId) return;
        this.desiredAddresses.set(addressKey(address), { ...address });
        this.startAddressFollow(address);
    }

    public async refreshCatalog(signal?: AbortSignal): Promise<void> {
        // The RC descriptor intentionally names this reserved parameter
        // `_request`; it is not the old `request` payload convention.
        const value = await this.unary.call<unknown>("session/list", { _request: {} }, signal);
        if (signal?.aborted) return;
        const result = toSessionList(value);
        // Every RC list response is a complete generation-independent baseline.
        // Replacing it also removes sessions that disappeared while the UI was
        // offline; the old revision-merge path belonged to the legacy host
        // stream and could leave stale rows behind on an explicit refresh.
        this.catalog.replaceRemoteSessions(result);
        this.applyControlBaseline();
    }

    private async readCompleteHistory(sessionId: string): Promise<void> {
        const openingAbort = new AbortController();
        const historyAbort = new AbortController();
        this.historyAborts.add(historyAbort);
        try {
            await this.readHistoryWindow(sessionId, historyAbort.signal, openingAbort);
        } finally {
            openingAbort.abort();
            this.historyAborts.delete(historyAbort);
        }
    }

    private async readHistoryWindow(sessionId: string, lifetime: AbortSignal, openingAbort: AbortController): Promise<void> {
        let generation = this.connection.currentGeneration;
        let signal = AbortSignal.any([lifetime, ...(this.generationAbort ? [this.generationAbort.signal] : [])]);
        const openingSignal = AbortSignal.any([openingAbort.signal, signal]);
        let tail: ParsedSessionSnapshot | undefined;
        try {
            for await (const value of this.connection.open("session/follow", {
                request: {
                    address: { kind: "session", sessionId },
                    maxMessages: this.historyPageSize,
                },
            }, openingSignal)) {
                tail = parseSessionSnapshot(sessionId, value);
                // A caller may request history before the first connection is ready.
                // Capture the generation that actually supplied the opening frame.
                generation = this.connection.currentGeneration;
                signal = AbortSignal.any([lifetime, ...(this.generationAbort ? [this.generationAbort.signal] : [])]);
                break;
            }
        } finally {
            openingAbort.abort();
        }
        if (!tail) throw new Error(`Remote session ${sessionId} did not provide a follow snapshot`);
        const pages: DshHistoryEntry[][] = [tail.events];
        let hasMore = tail.hasMore;
        let beforeSeq = lowestSeq(tail.events);
        while (hasMore) {
            if (beforeSeq === undefined || beforeSeq <= 0) {
                throw new Error(`Remote session ${sessionId} advertised more history without a backwards cursor`);
            }
            const page = toHistory(await this.unary.call<unknown>("session/page", {
                request: {
                    address: { kind: "session", sessionId },
                    throughSeq: tail.cursor,
                    beforeSeq,
                    maxMessages: this.historyPageSize,
                },
            }, signal));
            validateHistoryPage(page, beforeSeq, sessionId);
            pages.push(page.events);
            const next = lowestSeq(page.events);
            if (next === undefined || next >= beforeSeq) {
                throw new Error(`Remote session ${sessionId} returned a non-advancing history page`);
            }
            beforeSeq = next;
            hasMore = page.hasMore === true;
        }
        if (signal.aborted || this.stopped || generation !== this.connection.currentGeneration) return;
        this.catalog.applyProjectionBaseline(sessionId, tail.projections);
        this.sessions.replaceRemoteBaseline(sessionId, {
            events: pages.flat(),
            hasMore: false,
            projections: tail.projections,
        }, tail.cursor);
    }

    private onConnected(ready: RemoteEventReadyFrame, generation: number): void {
        this.generationAbort?.abort();
        this.followedAddresses.clear();
        this.generationReady = false;
        this.controlBaseline = undefined;
        this.catalog.beginRemoteBaseline();
        this.catalog.resetRemoteGeneration();
        const abort = new AbortController();
        this.generationAbort = abort;
        void this.openGenerationStreams(abort.signal, generation, ready)
            .catch((error) => {
                if (abort.signal.aborted || this.stopped || generation !== this.connection.currentGeneration) return;
                this.diagnostic("Remote generation baseline failed", error);
                this.connection.reconnect();
            });
    }

    private async openGenerationStreams(
        signal: AbortSignal,
        generation: number,
        ready: RemoteEventReadyFrame,
    ): Promise<void> {
        let baselinePublished = false;
        const controlReady = deferred();
        const workspaceReady = deferred();
        const tasks: Promise<void>[] = [
            this.consumeControl(signal, controlReady),
            this.consumeWorkspace(signal, workspaceReady),
        ];
        try {
            await Promise.all([controlReady.promise, workspaceReady.promise]);
            if (signal.aborted || generation !== this.connection.currentGeneration) return;
            await this.refreshCatalog(signal);
            if (signal.aborted || generation !== this.connection.currentGeneration) return;
            let canOpenPath = true;
            try {
                canOpenPath = await this.unary.call<boolean>("session/canOpenWorkspacePath", {}, signal);
            } catch {
                // The capability endpoint is optional in a minimally composed
                // Host; opening a path will report the precise Remote failure.
            }
            if (signal.aborted || generation !== this.connection.currentGeneration) return;
            this.sinks.onHostDescription?.({
                version: this.runtimeVersion,
                cwd: ready.host.home || process.cwd(),
                attachedSessions: this.catalog.snapshot().sessions.length,
                canOpenPath,
            });
            this.generationReady = true;
            for (const address of this.desiredAddresses.values()) this.startAddressFollow(address);
            this.catalog.endRemoteBaseline();
            baselinePublished = true;
            await Promise.all(tasks);
        } finally {
            if (!baselinePublished) this.catalog.endRemoteBaseline();
        }
    }

    private async consumeControl(signal: AbortSignal, ready?: Deferred): Promise<void> {
        let opened = false;
        try {
            for await (const value of this.connection.open("session/control", {}, signal)) {
                if (signal.aborted) return;
                if (!opened) {
                    if (
                        !isRecord(value) ||
                        value.type !== "baseline" ||
                        !isRecord(value.value) ||
                        !isRecord(value.value.queues) ||
                        !isRecord(value.value.jobs) ||
                        !isRecord(value.value.projections)
                    ) {
                        ready?.reject(new Error("Remote session control stream did not begin with a baseline"));
                        return;
                    }
                    opened = true;
                    ready?.resolve();
                }
                this.applyControl(value);
            }
            if (!opened) ready?.reject(new Error("Remote session control stream ended before baseline"));
            else if (!signal.aborted) throw new Error("Remote session control stream ended unexpectedly");
        } catch (error) {
            if (!opened) ready?.reject(error);
            if (!signal.aborted) {
                this.diagnostic("Remote session control stream failed", error);
                throw error;
            }
        }
    }

    private async consumeWorkspace(signal: AbortSignal, ready?: Deferred): Promise<void> {
        let opened = false;
        try {
            for await (const value of this.connection.open("workspace/follow", {}, signal)) {
                if (signal.aborted) return;
                if (!opened) {
                    if (!isRecord(value) || value.type !== "baseline" || workspaceBaseline(value.value) === undefined) {
                        ready?.reject(new Error("Remote workspace stream did not begin with a baseline"));
                        return;
                    }
                    opened = true;
                    ready?.resolve();
                }
                this.applyWorkspace(value);
            }
            if (!opened) ready?.reject(new Error("Remote workspace stream ended before baseline"));
            else if (!signal.aborted) throw new Error("Remote workspace stream ended unexpectedly");
        } catch (error) {
            if (!opened) ready?.reject(error);
            if (!signal.aborted) {
                this.diagnostic("Remote workspace stream failed", error);
                throw error;
            }
        }
    }

    private async consumeSession(address: RemoteSessionAddress, signal: AbortSignal): Promise<void> {
        const sessionId = address.kind === "session" ? address.sessionId : address.childSessionId;
        const assistant = new RemoteAssistantStream();
        let cursor: number | undefined;
        try {
            for await (const value of this.connection.open("session/follow", {
                request: {
                    address,
                    maxMessages: this.historyPageSize,
                    assistantStream: true,
                },
            }, signal)) {
                if (signal.aborted) return;
                if (isRecord(value) && value.type === "snapshot") {
                    if (cursor !== undefined) throw new Error("Remote session repeated its opening snapshot");
                    const snapshot = parseSessionSnapshot(sessionId, value);
                    cursor = snapshot.cursor;
                    assistant.replace(value.assistantStream, cursor);
                    this.sessions.applyRemoteAssistantStream(sessionId, assistant.snapshot);
                } else {
                    if (cursor === undefined) throw new Error("Remote session follow omitted its opening snapshot");
                    if (isRecord(value) && value.type === "assistant-stream") {
                        assistant.acceptFrame(value.frame, cursor);
                        this.sessions.applyRemoteAssistantStream(sessionId, assistant.snapshot);
                        continue;
                    }
                    const event = isRecord(value) && value.type === "event"
                        ? remoteHistoryEntries([value])[0]?.event : undefined;
                    if (!event || typeof event.seq !== "number") throw new Error("Remote session event frame is malformed");
                    if (event.seq <= cursor) continue;
                    if (event.seq !== cursor + 1) throw new Error(`Remote session skipped sequence ${cursor + 1}`);
                    cursor = event.seq;
                    assistant.acceptEvent(event as import("../types").DshSessionEvent);
                    this.sessions.applyRemoteAssistantStream(sessionId, assistant.snapshot);
                }
                this.applySession(sessionId, value);
            }
            if (!signal.aborted) throw new Error(`Remote session stream for ${sessionId} ended unexpectedly`);
        } catch (error) {
            if (!signal.aborted) {
                this.diagnostic(`Remote session stream failed for ${sessionId}`, error);
                throw error;
            }
        }
    }

    private startAddressFollow(address: RemoteSessionAddress): void {
        if (!this.generationReady || this.stopped) return;
        const signal = this.generationAbort?.signal;
        if (!signal || signal.aborted) return;
        const key = addressKey(address);
        if (this.followedAddresses.has(key)) return;
        this.followedAddresses.add(key);
        void this.consumeSession(address, signal).finally(() => {
            // An old follow can finish after the next generation already opened this address.
            if (this.generationAbort?.signal === signal) this.followedAddresses.delete(key);
        }).catch((error) => {
            if (!signal.aborted && !this.stopped) {
                this.diagnostic(`Remote session follow stopped for ${key}`, error);
                this.connection.reconnect();
            }
        });
    }

    private applyControl(value: unknown): void {
        if (!isRecord(value) || typeof value.type !== "string") {
            throw new Error("Remote session control frame is malformed");
        }
        if (value.type === "baseline" && isRecord(value.value)) {
            if (!isRecord(value.value.queues) || !isRecord(value.value.jobs) || !isRecord(value.value.projections)) {
                throw new Error("Remote session control baseline is malformed");
            }
            const queues = value.value.queues;
            const jobs = value.value.jobs;
            const projections = value.value.projections;
            this.controlBaseline = { queues, jobs, projections };
            this.applyControlBaseline();
            return;
        }
        if (typeof value.sessionId !== "string") throw new Error("Remote session control frame has no sessionId");
        if (value.type === "queue" && Array.isArray(value.items)) {
            if (this.controlBaseline) this.controlBaseline.queues[value.sessionId] = value.items;
            this.sessions.applyRemoteQueue(value.sessionId, value.items);
        } else if (value.type === "jobs" && Array.isArray(value.jobs)) {
            if (this.controlBaseline) this.controlBaseline.jobs[value.sessionId] = value.jobs;
            this.sessions.applyRemoteJobs(value.sessionId, value.jobs);
        } else if (value.type === "projection" && typeof value.key === "string" && typeof value.seq === "number") {
            this.sessions.applyRemoteProjection(value.sessionId, value.key, value.value, value.seq);
            if (value.key === "title" && typeof value.value === "string") {
                this.catalog.applyRename(value.sessionId, value.value, value.seq);
            }
        } else {
            throw new Error(`Remote session control frame ${value.type} is malformed`);
        }
    }

    private applyControlBaseline(): void {
        const baseline = this.controlBaseline;
        if (!baseline) return;
        for (const session of this.catalog.snapshot().sessions) {
            const sessionId = session.sessionId;
            const queue = Array.isArray(baseline.queues[sessionId]) ? baseline.queues[sessionId] as unknown[] : [];
            const jobs = Array.isArray(baseline.jobs[sessionId]) ? baseline.jobs[sessionId] as unknown[] : [];
            const projection = toProjection(baseline.projections[sessionId]);
            this.sessions.applyRemoteControl(sessionId, queue, jobs, projection);
            this.catalog.applyProjectionBaseline(sessionId, projection);
        }
    }

    private applyWorkspace(value: unknown): void {
        if (!isRecord(value) || typeof value.type !== "string") {
            throw new Error("Remote workspace frame is malformed");
        }
        if (value.type === "baseline" && isRecord(value.value)) {
            const baseline = workspaceBaseline(value.value);
            if (!baseline) throw new Error("Remote workspace baseline is malformed");
            this.catalog.replaceRemoteWorkspaces(baseline);
            return;
        }
        if (value.type === "upsert") {
            const workspace = workspaceView(value.workspace);
            if (!workspace) throw new Error("Remote workspace upsert is malformed");
            this.catalog.upsertWorkspace(workspace);
        } else if (value.type === "remove" && typeof value.workspaceId === "string") {
            this.catalog.removeWorkspace(value.workspaceId);
        } else if (value.type === "order" && Array.isArray(value.workspaceIds)) {
            if (!value.workspaceIds.every((id) => typeof id === "string")) {
                throw new Error("Remote workspace order is malformed");
            }
            this.catalog.replaceWorkspaceOrder(value.workspaceIds as string[]);
        } else if (value.type === "archived" && Array.isArray(value.archivedSessionIds)) {
            if (!value.archivedSessionIds.every((id) => typeof id === "string")) {
                throw new Error("Remote workspace archive set is malformed");
            }
            this.catalog.replaceArchived(value.archivedSessionIds as string[]);
        } else {
            throw new Error(`Remote workspace frame ${value.type} is malformed`);
        }
    }

    private applySession(sessionId: string, value: unknown): void {
        if (!isRecord(value)) throw new Error(`Remote session ${sessionId} frame is malformed`);
        if (value.type === "snapshot") {
            const snapshot = parseSessionSnapshot(sessionId, value);
            this.catalog.applyProjectionBaseline(sessionId, snapshot.projections);
            this.sessions.replaceRemoteBaseline(
                sessionId,
                {
                    events: snapshot.events,
                    hasMore: snapshot.hasMore,
                    projections: snapshot.projections,
                },
                snapshot.cursor,
            );
            return;
        }
        if (value.type === "event" && isRecord(value.event)) {
            const entries = remoteHistoryEntries([{ type: "event", event: value.event }]);
            const event = entries[0]?.event;
            if (!event) throw new Error(`Remote session ${sessionId} event frame is malformed`);
            this.sessions.applyRemoteEvent(sessionId, event);
            const eventData = isRecord(event.data) ? event.data : undefined;
            if (event.type === "agent-preset/selected" && typeof eventData?.agentPreset === "string") {
                this.catalog.applyRemoteAgentPreset(sessionId, eventData.agentPreset);
            }
            return;
        }
        throw new Error(`Remote session ${sessionId} frame ${String(value.type)} is malformed`);
    }

    private onRemoteEvent(frame: RemoteEventFrame): void {
        if (frame.type === "emit") {
            this.sinks.onRemoteEvent?.(frame.event);
            this.applyEmit(frame.event, frame.args);
            return;
        }
        if (frame.type === "waterfall") {
            const sessionId = frame.agentId;
            let handled = false;
            if (frame.event === "approval/request") {
                handled = this.sessions.applyRemoteApproval(sessionId, frame.eventId, frame.request);
            } else if (frame.event === "user-questions/request") {
                handled = this.sessions.applyRemoteQuestion(sessionId, frame.eventId, frame.request);
            }
            this.sinks.onRemoteEvent?.(frame.event);
            if (!handled) {
                // A Remote client must explicitly delegate scoped waterfalls it
                // does not understand; leaving the Host delivery pending would
                // stall the Host's waterfall until its cancellation timeout.
                void this.connection.answerRemoteEvent(frame.eventId, { kind: "next" }).catch((error) => {
                    this.diagnostic(`Failed to delegate Remote event ${frame.event}`, error);
                });
            }
            return;
        }
        if (frame.type === "cancel") this.sessions.cancelRemoteInteraction(frame.eventId);
    }

    private applyEmit(event: string, args: unknown[]): void {
        if (event === "agent-preset/selected" && typeof args[0] === "string" && typeof args[1] === "string") {
            this.catalog.applyRemoteAgentPreset(args[0], args[1]);
        } else if (event === "api-session/status" && typeof args[0] === "string" && typeof args[1] === "boolean") {
            this.catalog.applyRemoteSessionStatus(args[0], args[1]);
        } else if (event === "api-session/activity" && typeof args[0] === "string" && typeof args[1] === "number") {
            this.catalog.applyRemoteSessionActivity(args[0], args[1]);
        } else if (event === "api-session/error" && typeof args[0] === "string" && typeof args[1] === "string") {
            this.catalog.applyRemoteSessionError(args[0], args[1]);
        } else if (event === "api-session/removed" && typeof args[0] === "string") {
            this.catalog.removeSession(args[0]);
            this.desiredAddresses.delete(`session:${args[0]}`);
            this.followedAddresses.delete(`session:${args[0]}`);
        } else if (event === "api-session/added" && isRecord(args[0])) {
            const summary = toSessionSummary(args[0]);
            if (summary) {
                this.catalog.upsertRemoteSession(summary);
                const address = this.desiredAddresses.get(`session:${summary.sessionId}`);
                if (address) this.startAddressFollow(address);
            }
        }
        const frame: DshHostFrame = { type: "host/remote-event", event, args };
        this.sinks.onHostFrame?.(frame);
    }

    private diagnostic(message: string, cause?: unknown): void {
        this.sinks.onDiagnostic?.(message, cause);
    }
}

function toSessionList(value: unknown): DshSessionListResult {
    if (!isRecord(value) || !Array.isArray(value.items)) {
        throw new Error("Remote session/list returned an invalid value");
    }
    const items = value.items.map(toSessionSummary);
    if (items.some((item) => item === undefined)) {
        throw new Error("Remote session/list returned an invalid session summary");
    }
    return { items: items as DshSessionSummary[] };
}

function toSessionSummary(value: unknown): DshSessionSummary | undefined {
    if (
        !isRecord(value) ||
        typeof value.sessionId !== "string" ||
        value.sessionId.length === 0 ||
        typeof value.updatedAt !== "number" ||
        !Number.isFinite(value.updatedAt) ||
        typeof value.running !== "boolean" ||
        typeof value.blank !== "boolean" ||
        (value.parentSessionId !== undefined && typeof value.parentSessionId !== "string") ||
        (value.origin !== undefined && value.origin !== "subagent") ||
        (value.cwd !== undefined && typeof value.cwd !== "string")
    ) return undefined;
    const projections = value.projections === undefined ? undefined : toProjection(value.projections);
    if (value.projections !== undefined && projections === undefined) return undefined;
    const projectedPreset = projections?.values.agentPreset;
    const agentPreset = typeof projectedPreset === "string" && projectedPreset.length > 0
        ? projectedPreset
        : undefined;
    return {
        sessionId: value.sessionId,
        updatedAt: value.updatedAt,
        running: value.running,
        blank: value.blank,
        ...(typeof value.parentSessionId === "string" ? { parentSessionId: value.parentSessionId } : {}),
        ...(value.origin === "subagent" ? { origin: "subagent" as const } : {}),
        ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
        ...(agentPreset === undefined ? {} : { agentPreset }),
        ...(projections === undefined ? {} : { projections }),
    };
}

function toProjection(value: unknown): DshSessionProjectionsBlock | undefined {
    return remoteProjectionBlock(value);
}

function toHistory(value: unknown): DshHistoryResult {
    if (!isRecord(value) || !Array.isArray(value.records) || typeof value.hasMore !== "boolean") {
        throw new Error("Remote session/page returned an invalid value");
    }
    const records = remoteHistoryEntries(value.records);
    const projections = Object.hasOwn(value, "projections") ? toProjection(value.projections) : undefined;
    if (Object.hasOwn(value, "projections") && projections === undefined) {
        throw new Error("Remote session/page returned invalid projections");
    }
    return {
        events: records,
        hasMore: value.hasMore,
        projections,
    };
}

interface ParsedSessionSnapshot extends DshHistoryResult {
    cursor: number;
    projections: DshSessionProjectionsBlock;
    hasMore: boolean;
}

function parseSessionSnapshot(sessionId: string, value: unknown): ParsedSessionSnapshot {
    if (!isRecord(value) || value.type !== "snapshot") {
        throw new Error(`Remote session ${sessionId} follow did not begin with a snapshot`);
    }
    const cursor = sessionCursor(value.cursor);
    if (cursor === undefined) {
        throw new Error(`Remote session ${sessionId} follow snapshot has an invalid cursor`);
    }
    validateSessionHeader(sessionId, value.header);
    if (!Array.isArray(value.records)) {
        throw new Error(`Remote session ${sessionId} snapshot has invalid records`);
    }
    if (typeof value.hasMore !== "boolean") {
        throw new Error(`Remote session ${sessionId} snapshot has invalid hasMore`);
    }
    const events = remoteHistoryEntries(value.records);
    const projections = remoteProjectionBlock(value.projections);
    if (!projections || projections.asOfSeq > cursor) {
        throw new Error(`Remote session ${sessionId} snapshot has invalid projections`);
    }
    const seen = new Set<number>();
    for (const entry of events) {
        const seq = entry.event.seq;
        if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0 || seq > cursor || seen.has(seq)) {
            throw new Error(`Remote session ${sessionId} snapshot contains an invalid or duplicate sequence`);
        }
        seen.add(seq);
    }
    return { events, hasMore: value.hasMore, projections, cursor };
}

function validateSessionHeader(sessionId: string, value: unknown): void {
    if (
        !isRecord(value) ||
        typeof value.id !== "string" ||
        value.id !== sessionId ||
        typeof value.version !== "number" ||
        !Number.isSafeInteger(value.version) ||
        value.version < 0 ||
        typeof value.createdAt !== "number" ||
        !Number.isFinite(value.createdAt) ||
        (value.cwd !== undefined && typeof value.cwd !== "string") ||
        (value.parentSession !== undefined && typeof value.parentSession !== "string") ||
        (value.seedLength !== undefined &&
            (typeof value.seedLength !== "number" || !Number.isSafeInteger(value.seedLength) || value.seedLength < 0)) ||
        (value.origin !== undefined && value.origin !== "subagent") ||
        (value.delegationDepth !== undefined &&
            (typeof value.delegationDepth !== "number" || !Number.isSafeInteger(value.delegationDepth) || value.delegationDepth < 0)) ||
        (value.agentPreset !== undefined && typeof value.agentPreset !== "string")
    ) {
        throw new Error(`Remote session ${sessionId} snapshot has an invalid header`);
    }
}

function validateHistoryPage(page: DshHistoryResult, beforeSeq: number, sessionId: string): void {
    for (const entry of page.events) {
        const seq = entry.event.seq;
        if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0 || seq >= beforeSeq) {
            throw new Error(`Remote session ${sessionId} page contains an out-of-range sequence`);
        }
    }
}

function lowestSeq(entries: readonly DshHistoryEntry[]): number | undefined {
    let lowest: number | undefined;
    for (const entry of entries) {
        const seq = entry.event.seq;
        if (typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0) {
            lowest = lowest === undefined ? seq : Math.min(lowest, seq);
        }
    }
    return lowest;
}

function addressKey(address: RemoteSessionAddress): string {
    return address.kind === "session"
        ? `session:${address.sessionId}`
        : `subagent:${address.parentSessionId}:${address.childSessionId}:${address.mode}`;
}

function isRecord(value: unknown): value is Record<string, any> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
