import { errorMessage } from "./errors";
import type { DshRuntime } from "./dshRuntime";
import { isRecord } from "./guards";
import { t } from "./localize";
import {
    normalizeMessageFeedbackDeleteResult,
    normalizeMessageFeedbackListResult,
    normalizeMessageFeedbackPutResult,
} from "./messageFeedback";
import type { SessionStateSnapshot } from "./sessionStore";
import type {
    ChatMessage,
    DshMessageFeedbackDeleteRequest,
    DshMessageFeedbackItem,
    DshMessageFeedbackPutRequest,
    DshMessageFeedbackRating,
    DshMessageFeedbackStateView,
} from "./types";

export interface MessageFeedbackSessionState {
    status: "loading" | "ready" | "error" | "unavailable";
    items: Map<string, DshMessageFeedbackItem>;
    pending: Set<string>;
    errors: Map<string, string>;
    error?: string;
}

/** Resolve the stable wire id of one finalized append-origin assistant message. */
function assistantFeedbackMessageId(
    snapshot: SessionStateSnapshot | undefined,
    seq: number | undefined,
): string | undefined {
    if (!snapshot || seq === undefined || !Number.isSafeInteger(seq) || seq < 0) return undefined;
    const stored = snapshot.events.find((candidate) => candidate.event.seq === seq);
    if (!stored || stored.event.type !== "assistant/message" || stored.event.surfaceOp !== "append") {
        return undefined;
    }
    if (!isRecord(stored.event.data) || !isRecord(stored.event.data.message)) return undefined;
    const message = stored.event.data.message;
    return message.role === "assistant" && typeof message.id === "string" && message.id.trim().length > 0
        ? message.id
        : undefined;
}

/** Check a feedback mutation against the current Session's authoritative log. */
function hasAssistantFeedbackTarget(
    snapshot: SessionStateSnapshot | undefined,
    messageId: string,
): boolean {
    if (!snapshot || !messageId) return false;
    return snapshot.events.some((stored) =>
        stored.event.type === "assistant/message" &&
        stored.event.surfaceOp === "append" &&
        isRecord(stored.event.data) &&
        isRecord(stored.event.data.message) &&
        stored.event.data.message.id === messageId &&
        stored.event.data.message.role === "assistant",
    );
}

export interface MessageFeedbackControllerDeps {
    readonly runtime: DshRuntime;
    /** The chat view's current root session, read live at every use. */
    readonly currentRootSession: () => string | undefined;
    /** Repaint request; only fired when the affected session is the current root. */
    readonly onChange: () => void;
}

/**
 * Owns the messageFeedback sidecar: per-session list state, the serialized
 * CAS mutation queue, and the (reserved) presentation half. The webview entry
 * points exist; the visible feedback UI deliberately waits for an evaluation
 * loop — see TODO.md — so nothing here writes to the Session log, model
 * context, or telemetry.
 */
export class MessageFeedbackController {
    private readonly states = new Map<string, MessageFeedbackSessionState>();
    private readonly requests = new Map<string, Promise<void>>();
    private readonly generations = new Map<string, number>();
    private readonly operationTails = new Map<string, Promise<void>>();

    public constructor(private readonly deps: MessageFeedbackControllerDeps) {}

    /** Start or reuse the sidecar list read for one selected Session. */
    private refreshMessageFeedback(sessionId: string, force = false): Promise<void> {
        if (!this.deps.runtime.getUrl()) return Promise.resolve();
        const inFlight = this.requests.get(sessionId);
        if (inFlight) return inFlight;
        const existing = this.states.get(sessionId);
        if (!force && (existing?.status === "ready" || existing?.status === "unavailable")) {
            return Promise.resolve();
        }

        const generation = (this.generations.get(sessionId) ?? 0) + 1;
        this.generations.set(sessionId, generation);
        const state: MessageFeedbackSessionState = existing ?? {
            status: "loading",
            items: new Map(),
            pending: new Set(),
            errors: new Map(),
        };
        state.status = "loading";
        state.error = undefined;
        state.errors.clear();
        this.states.set(sessionId, state);
        if (sessionId === this.deps.currentRootSession()) this.deps.onChange();

        const request = this.deps.runtime.listMessageFeedback(sessionId)
            .then((raw) => {
                if (this.generations.get(sessionId) !== generation) return;
                if (raw === undefined) {
                    state.status = "unavailable";
                    state.items.clear();
                    state.pending.clear();
                    state.errors.clear();
                    state.error = undefined;
                    return;
                }
                const result = normalizeMessageFeedbackListResult(raw);
                if (!result) {
                    throw new Error(t("Harness returned an invalid messageFeedback.list result."));
                }
                if (!result.ok) {
                    if (result.error.code === "session-not-found") {
                        state.status = "unavailable";
                        state.items.clear();
                        state.pending.clear();
                        state.errors.clear();
                        state.error = undefined;
                    } else {
                        state.status = "error";
                        state.error = this.messageFeedbackFailure(result.error.code);
                    }
                    return;
                }
                state.status = "ready";
                state.items = new Map(result.value.items.map((item) => [item.messageId, item]));
                state.pending.clear();
                state.errors.clear();
                state.error = undefined;
            })
            .catch((error) => {
                if (this.generations.get(sessionId) !== generation) return;
                state.status = "error";
                state.error = errorMessage(error);
            })
            .finally(() => {
                if (this.requests.get(sessionId) === request) {
                    this.requests.delete(sessionId);
                }
                if (sessionId === this.deps.currentRootSession()) this.deps.onChange();
            });
        this.requests.set(sessionId, request);
        return request;
    }

    /** Wait for a usable sidecar state, with older Runtimes degrading quietly. */
    private async ensureMessageFeedback(sessionId: string): Promise<MessageFeedbackSessionState | undefined> {
        await this.refreshMessageFeedback(sessionId);
        const state = this.states.get(sessionId);
        return state?.status === "ready" ? state : undefined;
    }

    /** Serialize feedback mutations per Session so every CAS compares the latest item. */
    private enqueueMessageFeedback(
        sessionId: string,
        messageId: string,
        operation: (state: MessageFeedbackSessionState) => Promise<void>,
    ): Promise<void> {
        const previous = this.operationTails.get(sessionId) ?? Promise.resolve();
        const run = previous.then(async () => {
            let state: MessageFeedbackSessionState | undefined;
            try {
                state = await this.ensureMessageFeedback(sessionId);
                if (!state) return;
                state.pending.add(messageId);
                state.errors.delete(messageId);
                this.deps.onChange();
                await operation(state);
            } catch (error) {
                state ??= this.states.get(sessionId);
                if (state) {
                    state.status = state.status === "unavailable" ? "unavailable" : "error";
                    state.errors.set(messageId, errorMessage(error));
                    state.error = undefined;
                }
            } finally {
                state?.pending.delete(messageId);
                if (sessionId === this.deps.currentRootSession()) this.deps.onChange();
            }
        }, async () => {
            // The operation body contains its own error presentation. Keep a
            // rejected predecessor from starving later clicks in the queue.
        });
        const tail = run.then(() => undefined, () => undefined);
        this.operationTails.set(sessionId, tail);
        return run.finally(() => {
            if (this.operationTails.get(sessionId) === tail) {
                this.operationTails.delete(sessionId);
            }
        });
    }

    /** Human-readable fallback for the stable business failure codes. */
    private messageFeedbackFailure(code: string): string {
        switch (code) {
            case "session-not-found":
                return t("This session is no longer available for feedback.");
            case "target-not-found":
                return t("This message is no longer available for feedback.");
            case "version-conflict":
                return t("Feedback changed elsewhere; try again.");
            case "note-blank":
                return t("A feedback note must contain text.");
            case "note-too-large":
                return t("The feedback note is too long.");
            default:
                return t("The feedback operation was rejected.");
        }
    }

    /** Mark the optional feature absent when a Runtime does not mount it. */
    private disableMessageFeedback(state: MessageFeedbackSessionState): void {
        state.status = "unavailable";
        state.items.clear();
        state.pending.clear();
        state.errors.clear();
        state.error = undefined;
    }

    /** Apply one put response and reconcile a lost CAS race from its authority. */
    private async applyMessageFeedbackPut(
        state: MessageFeedbackSessionState,
        request: DshMessageFeedbackPutRequest,
    ): Promise<void> {
        const raw = await this.deps.runtime.putMessageFeedback(request);
        if (raw === undefined) {
            this.disableMessageFeedback(state);
            return;
        }
        const result = normalizeMessageFeedbackPutResult(raw);
        if (!result) throw new Error(t("Harness returned an invalid messageFeedback.put result."));
        if (result.ok) {
            if (result.value.messageId !== request.messageId) {
                throw new Error(t("Harness returned an invalid messageFeedback.put result."));
            }
            state.status = "ready";
            state.items.set(result.value.messageId, result.value);
            state.error = undefined;
            return;
        }
        if (result.error.code === "session-not-found") {
            this.disableMessageFeedback(state);
            return;
        }
        if (result.error.code === "version-conflict") {
            if (result.error.current === null || result.error.current === undefined) {
                state.items.delete(request.messageId);
            } else {
                if (result.error.current.messageId !== request.messageId) {
                    throw new Error(t("Harness returned an invalid messageFeedback.put result."));
                }
                state.items.set(request.messageId, result.error.current);
            }
        }
        throw new Error(this.messageFeedbackFailure(result.error.code));
    }

    /** Apply one delete response and reconcile a lost CAS race from its authority. */
    private async applyMessageFeedbackDelete(
        state: MessageFeedbackSessionState,
        request: DshMessageFeedbackDeleteRequest,
    ): Promise<void> {
        const raw = await this.deps.runtime.deleteMessageFeedback(request);
        if (raw === undefined) {
            this.disableMessageFeedback(state);
            return;
        }
        const result = normalizeMessageFeedbackDeleteResult(raw);
        if (!result) throw new Error(t("Harness returned an invalid messageFeedback.delete result."));
        if (result.ok) {
            state.status = "ready";
            state.items.delete(request.messageId);
            state.error = undefined;
            return;
        }
        if (result.error.code === "session-not-found") {
            this.disableMessageFeedback(state);
            return;
        }
        if (result.error.code === "version-conflict") {
            if (result.error.current === null || result.error.current === undefined) {
                state.items.delete(request.messageId);
            } else {
                if (result.error.current.messageId !== request.messageId) {
                    throw new Error(t("Harness returned an invalid messageFeedback.delete result."));
                }
                state.items.set(request.messageId, result.error.current);
            }
        }
        throw new Error(this.messageFeedbackFailure(result.error.code));
    }

    public async toggleMessageFeedback(
        messageId: string,
        requested: DshMessageFeedbackRating,
    ): Promise<void> {
        const sessionId = this.deps.currentRootSession();
        if (!sessionId || !hasAssistantFeedbackTarget(this.deps.runtime.getSessionStore().get(sessionId), messageId)) {
            return;
        }
        return this.enqueueMessageFeedback(sessionId, messageId, async (state) => {
            const current = state.items.get(messageId);
            if (current?.rating === requested) {
                await this.applyMessageFeedbackDelete(state, {
                    sessionId,
                    messageId,
                    ifVersion: current.version,
                });
                return;
            }
            await this.applyMessageFeedbackPut(state, {
                sessionId,
                messageId,
                rating: requested,
                ...(current?.note === undefined ? {} : { note: current.note }),
                ifVersion: current?.version ?? null,
            });
        });
    }

    public async saveMessageFeedbackNote(messageId: string, note: string): Promise<void> {
        const sessionId = this.deps.currentRootSession();
        if (!sessionId || !hasAssistantFeedbackTarget(this.deps.runtime.getSessionStore().get(sessionId), messageId)) {
            return;
        }
        return this.enqueueMessageFeedback(sessionId, messageId, async (state) => {
            const current = state.items.get(messageId);
            if (!current) return;
            await this.applyMessageFeedbackPut(state, {
                sessionId,
                messageId,
                rating: current.rating,
                ...(note.trim().length === 0 ? {} : { note }),
                ifVersion: current.version,
            });
        });
    }

    public messageFeedbackView(sessionId: string | undefined): DshMessageFeedbackStateView | undefined {
        if (!sessionId || !this.deps.runtime.getUrl()) return undefined;
        const state = this.states.get(sessionId);
        if (!state || state.status === "unavailable") return undefined;
        const items = Object.create(null) as Record<string, DshMessageFeedbackItem>;
        for (const [messageId, item] of state.items) items[messageId] = item;
        const pending = Object.create(null) as Record<string, true>;
        for (const messageId of state.pending) pending[messageId] = true;
        const errors = Object.create(null) as Record<string, string>;
        for (const [messageId, error] of state.errors) errors[messageId] = error;
        return {
            status: state.status,
            items,
            pending,
            errors,
            ...(state.error === undefined ? {} : { error: state.error }),
        };
    }

    /** Attach stable wire ids and sidecar state to the root chat messages only. */
    public decorateMessageFeedback(
        messages: readonly ChatMessage[],
        snapshot: SessionStateSnapshot | undefined,
        state: MessageFeedbackSessionState | undefined,
    ): ChatMessage[] {
        return messages.map((message) => {
            if (message.role !== "assistant" || message.state !== "committed") return message;
            const messageId = assistantFeedbackMessageId(snapshot, message.seq);
            if (!messageId) return message;
            if (!state || state.status === "unavailable") return { ...message, messageId };
            const item = state.items.get(messageId);
            const error = state.errors.get(messageId);
            return {
                ...message,
                messageId,
                feedback: {
                    status: state.status,
                    ...(item?.rating === undefined ? {} : { rating: item.rating }),
                    ...(item?.note === undefined ? {} : { note: item.note }),
                    ...(state.pending.has(messageId) ? { pending: true } : {}),
                    ...(error === undefined ? {} : { error }),
                },
            };
        });
    }
}
