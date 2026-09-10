import {
    parseRemoteEventFrame,
    REMOTE_EVENT_RESULT_ENDPOINT,
    REMOTE_EVENT_STREAM_ENDPOINT,
    isRemoteJsonValue,
    type RemoteEventFrame,
    type RemoteEventReadyFrame,
    type RemoteEventResultRequest,
} from "./contracts";
import { RemoteProtocolError } from "./errors";
import type { RemoteStreamMuxClient } from "./muxClient";
import type { RemoteUnaryClient } from "./unaryClient";

/** Events declared by the RC application's forwarding allowlist. */
const FORWARDED_EMIT_EVENTS = new Set([
    "agent-preset/selected",
    "api-session/activity",
    "api-session/added",
    "api-session/error",
    "api-session/removed",
    "api-session/status",
    "commands/change",
    "credentials/reference-updated",
    "goal/activation-changed",
    "cordis/request-run",
    "cordis/request-run-resolved",
    "cordis/dynamic-package",
    "cordis/dynamic-retract",
    "cordis/inspect-query",
    "cordis/inspect-query-resolved",
    "llm/adapters-updated",
    "settings/document-updated",
]);

export interface RemoteEventControllerOptions {
    onEmit?: (frame: Extract<RemoteEventFrame, { type: "emit" }>, generation: number) => void;
    onWaterfall?: (frame: Extract<RemoteEventFrame, { type: "waterfall" }>, generation: number) => void;
    onCancel?: (frame: Extract<RemoteEventFrame, { type: "cancel" }>, generation: number) => void;
    onReady?: (ready: RemoteEventReadyFrame, generation: number) => void;
    onDiagnostic?: (message: string, cause?: unknown) => void;
}

/** Owns the `$events` logical stream for one physical Remote generation. */
export class RemoteEventController {
    private clientId: string | undefined;
    private host: { home: string } | undefined;
    /** Event ids delivered by this generation and not yet answered. */
    private readonly pendingEventIds = new Set<string>();

    public constructor(
        private readonly mux: RemoteStreamMuxClient,
        private readonly unary: RemoteUnaryClient,
        private readonly options: RemoteEventControllerOptions = {},
    ) {}

    public get activeClientId(): string | undefined {
        return this.clientId;
    }

    public get hostInfo(): { home: string } | undefined {
        return this.host ? { ...this.host } : undefined;
    }

    public async consume(generation: number, signal: AbortSignal): Promise<void> {
        let first = true;
        try {
            for await (const value of this.mux.open(REMOTE_EVENT_STREAM_ENDPOINT, {}, signal)) {
                const frame = parseRemoteEventFrame(value);
                if (first) {
                    if (frame.type !== "ready") {
                        throw new RemoteProtocolError("Remote event stream did not begin with ready");
                    }
                    first = false;
                    this.clientId = frame.clientId;
                    this.host = { ...frame.host };
                    this.options.onReady?.(frame, generation);
                    continue;
                }
                switch (frame.type) {
                    case "emit":
                        if (FORWARDED_EMIT_EVENTS.has(frame.event)) {
                            this.options.onEmit?.(frame, generation);
                        } else {
                            this.options.onDiagnostic?.(
                                `Ignoring Remote emit outside the forwarding allowlist: ${frame.event}`,
                            );
                        }
                        break;
                    case "waterfall":
                        this.pendingEventIds.add(frame.eventId);
                        this.options.onWaterfall?.(frame, generation);
                        break;
                    case "cancel":
                        this.pendingEventIds.delete(frame.eventId);
                        this.options.onCancel?.(frame, generation);
                        break;
                    case "ready":
                        throw new RemoteProtocolError("Remote event stream emitted a second ready frame");
                }
            }
            if (!signal.aborted) {
                throw new RemoteProtocolError(
                    first
                        ? "Remote event stream ended before ready"
                        : "Remote event stream ended unexpectedly",
                );
            }
        } catch (error) {
            if (!signal.aborted) this.options.onDiagnostic?.("Remote event stream failed", error);
            this.pendingEventIds.clear();
            throw error;
        }
    }

    public async answer(eventId: string, outcome: RemoteEventResultRequest["outcome"], signal?: AbortSignal): Promise<void> {
        const clientId = this.clientId;
        if (!clientId) throw new Error("Remote event stream is not ready");
        if (!isNonEmptyString(eventId) || !validOutcome(outcome)) {
            throw new RemoteProtocolError("Remote event result is malformed");
        }
        if (!this.pendingEventIds.delete(eventId)) {
            throw new RemoteProtocolError(`Remote event ${eventId} is no longer pending`);
        }
        await this.unary.call<void>(REMOTE_EVENT_RESULT_ENDPOINT, { clientId, eventId, outcome }, signal);
    }
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
}

function validOutcome(value: unknown): value is RemoteEventResultRequest["outcome"] {
    if (!value || typeof value !== "object" || Array.isArray(value) || !isPlainRecord(value)) return false;
    const outcome = value as Record<string, unknown>;
    if (outcome.kind === "next") return Reflect.ownKeys(outcome).length === 1;
    if (outcome.kind === "result") {
        const keys = Reflect.ownKeys(outcome);
        return (
            (keys.length === 1 || (keys.length === 2 && Object.hasOwn(outcome, "value"))) &&
            (!Object.hasOwn(outcome, "value") || isRemoteJsonValue(outcome.value))
        );
    }
    if (outcome.kind !== "rejected" || Reflect.ownKeys(outcome).length !== 2) return false;
    const error = outcome.error;
    if (!error || typeof error !== "object" || Array.isArray(error) || !isPlainRecord(error)) return false;
    const errorRecord = error as Record<string, unknown>;
    const keys = Reflect.ownKeys(errorRecord);
    if (
        !Object.hasOwn(errorRecord, "name") ||
        !Object.hasOwn(errorRecord, "message") ||
        !keys.every((key) =>
            typeof key === "string" &&
            (key === "name" || key === "message" || key === "code" || key === "details"),
        ) ||
        typeof errorRecord.name !== "string" ||
        !errorRecord.name ||
        typeof errorRecord.message !== "string" ||
        (Object.hasOwn(errorRecord, "code") && typeof errorRecord.code !== "string") ||
        (Object.hasOwn(errorRecord, "details") && !isRemoteJsonValue(errorRecord.details))
    ) return false;
    return true;
}

function isPlainRecord(value: object): value is Record<string, unknown> {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
