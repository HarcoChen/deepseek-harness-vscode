import type { DshSessionEvent } from "./types";
import { isRemoteJsonValue } from "./remote/contracts";

export interface TimedAssistantChunk {
    time: number;
    chunk: Record<string, unknown>;
}

/** Process-local presentation, deliberately separate from durable Session seqs. */
export interface AssistantStreamState {
    attemptId: string;
    startedAfterSeq: number;
    turn: number;
    step: number;
    chunks: readonly TimedAssistantChunk[];
}

export interface AssistantSettlement {
    seq: number;
    eventType: "assistant/message" | "assistant/attempt";
}

/** Decode the lossless compact stream embedded in RC 0.1.5 settlements/baselines. */
export function expandAssistantStream(value: unknown): TimedAssistantChunk[] {
    if (!Array.isArray(value)) throw new Error("Assistant stream must be an array");
    const chunks: TimedAssistantChunk[] = [];
    for (const raw of value) {
        if (!record(raw)) throw new Error("Assistant stream record is malformed");
        if (raw.type === "chunk") {
            if (!keys(raw, ["type", "time", "chunk"])) throw new Error("Assistant chunk has invalid fields");
            chunks.push(timedChunk(raw.time, raw.chunk));
            continue;
        }
        const tool = raw.type === "tool-call-chunks";
        if (!tool && raw.type !== "text-chunks" && raw.type !== "reasoning-chunks") {
            throw new Error(`Unknown Assistant stream record ${String(raw.type)}`);
        }
        const expected = tool
            ? ["type", "time0", "index", "dt", "id", "args", ...(Object.hasOwn(raw, "name") ? ["name"] : [])]
            : ["type", "time0", "index", "dt", "texts"];
        const members = tool ? raw.args : raw.texts;
        if (!keys(raw, expected) || !integer(raw.index) || !Number.isSafeInteger(raw.time0) ||
            !Array.isArray(members) || members.length === 0 || !members.every((member) => typeof member === "string") ||
            !Array.isArray(raw.dt) || raw.dt.length !== members.length - 1 || !raw.dt.every(Number.isSafeInteger) ||
            (tool && (!id(raw.id) || (Object.hasOwn(raw, "name") && !id(raw.name))))) {
            throw new Error("Assistant stream run is malformed");
        }
        let time = raw.time0 as number;
        for (let index = 0; index < members.length; index += 1) {
            if (index > 0) time += raw.dt[index - 1] as number;
            const chunk = tool
                ? { type: "tool-call-delta", index: raw.index, id: raw.id,
                    ...(Object.hasOwn(raw, "name") ? { name: raw.name } : {}), argumentsDelta: members[index] }
                : { type: raw.type === "text-chunks" ? "text-delta" : "reasoning-delta", index: raw.index, text: members[index] };
            chunks.push(timedChunk(time, chunk));
        }
    }
    return chunks;
}

/** One follow stream's dense revision/index fold and durable settlement reconciliation. */
export class RemoteAssistantStream {
    private revision = 0;
    private active: AssistantStreamState | undefined;
    private nextIndex = 0;
    private settlement: AssistantSettlement | undefined;

    public get snapshot(): AssistantStreamState | undefined {
        return this.settlement ? undefined : this.active;
    }

    public replace(value: unknown, cursor: number): void {
        if (!record(value) || !integer(value.revision) ||
            !keys(value, ["revision", ...(Object.hasOwn(value, "activeAttempt") ? ["activeAttempt"] : [])])) {
            throw new Error("Remote Assistant stream omitted or malformed its opening baseline");
        }
        this.revision = value.revision;
        this.active = undefined;
        this.settlement = undefined;
        this.nextIndex = 0;
        if (value.activeAttempt === undefined) return;
        const attempt = value.activeAttempt;
        if (!record(attempt) || !id(attempt.attemptId) || !integer(attempt.startedAfterSeq, -1) ||
            attempt.startedAfterSeq > cursor || !integer(attempt.turn) || !integer(attempt.step) || !integer(attempt.nextIndex)) {
            throw new Error("Remote Assistant active attempt is malformed");
        }
        const chunks = expandAssistantStream(attempt.stream);
        if (chunks.length !== attempt.nextIndex) throw new Error("Remote Assistant baseline chunk count differs from nextIndex");
        this.nextIndex = attempt.nextIndex;
        this.active = { attemptId: attempt.attemptId, startedAfterSeq: attempt.startedAfterSeq,
            turn: attempt.turn, step: attempt.step, chunks };
    }

    public acceptEvent(event: DshSessionEvent): void {
        const attempt = this.active;
        if (!attempt || !record(event.data) ||
            (event.type !== "assistant/message" && event.type !== "assistant/attempt") ||
            (event.type === "assistant/message" && event.surfaceOp !== "append") ||
            event.seq <= attempt.startedAfterSeq || event.data.turn !== attempt.turn || event.data.step !== attempt.step) return;
        if (this.settlement) throw new Error("Remote Assistant attempt settled twice");
        this.settlement = { seq: event.seq, eventType: event.type };
    }

    /** Restore a settlement already covered by the follow cursor and known history. */
    public restoreSettlement(settlement: AssistantSettlement | undefined): void {
        if (!settlement || !this.active) return;
        if (settlement.seq <= this.active.startedAfterSeq ||
            (this.settlement && (this.settlement.seq !== settlement.seq || this.settlement.eventType !== settlement.eventType))) {
            throw new Error("Remote Assistant restored settlement does not match its attempt");
        }
        this.settlement = settlement;
    }

    public acceptFrame(value: unknown, cursor: number): void {
        if (!record(value) || !integer(value.revision) || value.revision !== this.revision + 1 || !id(value.attemptId)) {
            throw new Error("Remote Assistant stream has a revision gap or malformed frame");
        }
        this.revision = value.revision;
        if (value.type === "start") {
            if (this.active || !integer(value.startedAfterSeq, -1) || value.startedAfterSeq > cursor ||
                !integer(value.turn) || !integer(value.step)) throw new Error("Remote Assistant start is malformed");
            this.active = { attemptId: value.attemptId, startedAfterSeq: value.startedAfterSeq,
                turn: value.turn, step: value.step, chunks: [] };
            this.nextIndex = 0;
            this.settlement = undefined;
            return;
        }
        if (value.type !== "chunk" && value.type !== "end") throw new Error("Unknown Remote Assistant frame");
        // A controller attached during an existing attempt may only see its suffix.
        if (!this.active || this.active.attemptId !== value.attemptId) return;
        if (value.index !== this.nextIndex) throw new Error("Remote Assistant stream has a chunk index gap");
        if (value.type === "chunk") {
            if (this.settlement) throw new Error("Remote Assistant chunk arrived after settlement");
            this.nextIndex += 1;
            this.active = { ...this.active, chunks: [...this.active.chunks, timedChunk(value.time, value.chunk)] };
            return;
        }
        if (!record(value.outcome) ||
            (value.outcome.kind === "committed"
                ? !this.settlement || value.outcome.seq !== this.settlement.seq || value.outcome.eventType !== this.settlement.eventType
                : value.outcome.kind !== "abandoned" || this.settlement !== undefined)) {
            throw new Error("Remote Assistant end does not match its durable settlement");
        }
        this.active = undefined;
        this.settlement = undefined;
    }
}

function timedChunk(time: unknown, chunk: unknown): TimedAssistantChunk {
    if (!Number.isSafeInteger(time) || !record(chunk) || !id(chunk.type) || !isRemoteJsonValue(chunk)) {
        throw new Error("Assistant stream chunk is malformed");
    }
    return { time: time as number, chunk };
}

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function integer(value: unknown, minimum = 0): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && !Object.is(value, -0);
}
function id(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function keys(value: object, expected: readonly string[]): boolean {
    return Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
