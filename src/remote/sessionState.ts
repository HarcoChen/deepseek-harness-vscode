import type {
    DshHistoryEntry,
    DshSessionEvent,
    DshSessionProjectionsBlock,
} from "../types";
import { isRemoteJsonValue } from "./contracts";
import { expandAssistantStream } from "../assistantStream";

/** Address shared by ordinary and subagent Session Remote methods. */
export type RemoteSessionAddress =
    | { kind: "session"; sessionId: string }
    | { kind: "subagent"; parentSessionId: string; childSessionId: string; mode: "one-shot" | "continuable" };

export function sessionAddress(sessionId: string): RemoteSessionAddress {
    return { kind: "session", sessionId };
}

/** Decode the message-aligned history records exposed by `session/follow|page`. */
export function historyEntries(records: readonly unknown[]): DshHistoryEntry[] {
    const result: DshHistoryEntry[] = [];
    for (const record of records) {
        if (!isPlainRecord(record) || typeof record.type !== "string") {
            throw new Error("Remote history contains an invalid record");
        }
        if (record.type === "chunks") {
            if (!hasExactKeys(record, ["type", "event"])) {
                throw new Error("Remote history chunk record has invalid fields");
            }
            for (const event of expandChunkRow(record.event)) result.push({ event });
            continue;
        }
        if (record.type === "event") {
            if (!hasExactKeys(record, ["type", "event"])) {
                throw new Error("Remote history event record has invalid fields");
            }
            const event = decodeSessionEvent(record.event);
            result.push({ event });
            continue;
        }
        throw new Error(`Remote history contains an unknown record type ${record.type}`);
    }
    return result;
}

function decodeSessionEvent(value: unknown): DshSessionEvent {
    if (
        !isPlainRecord(value) ||
        typeof value.type !== "string" ||
        value.type.length === 0 ||
        !isSafeNonNegativeSeq(value.seq) ||
        typeof value.time !== "number" ||
        !Number.isFinite(value.time) ||
        !Object.hasOwn(value, "data") ||
        !isRemoteJsonValue(value.data) ||
        !hasOnlyKeys(value, ["type", "seq", "time", "data", "sourceEventSeqs", "surfaceOp", "ignorable"]) ||
        (value.ignorable !== undefined && value.ignorable !== true) ||
        (value.sourceEventSeqs !== undefined &&
            (!Array.isArray(value.sourceEventSeqs) ||
                !value.sourceEventSeqs.every((seq) => isSafeNonNegativeSeq(seq) && seq < (value.seq as number)) ||
                new Set(value.sourceEventSeqs).size !== value.sourceEventSeqs.length)) ||
        (value.surfaceOp !== undefined && !validSurfaceOp(value.surfaceOp))
    ) {
        throw new Error("Remote history event has an invalid envelope");
    }
    if ((value.type === "assistant/message" || value.type === "assistant/attempt") &&
        isPlainRecord(value.data) && Object.hasOwn(value.data, "stream")) {
        expandAssistantStream(value.data.stream);
    }
    // Keep the editor's domain range vocabulary stable at this wire boundary.
    if (isPlainRecord(value.surfaceOp) && Object.hasOwn(value.surfaceOp, "startSeq")) {
        return { ...value, surfaceOp: { op: "replace", start: value.surfaceOp.startSeq, end: value.surfaceOp.endSeq } } as DshSessionEvent;
    }
    return value as unknown as DshSessionEvent;
}

/** Expand the bounded-history chunk-row encoding without leaking its storage-only tags. */
function expandChunkRow(value: unknown): DshSessionEvent[] {
    if (!isPlainRecord(value) || !hasExactKeys(value, ["type", "seq", "time", "data"])) {
        throw new Error("Remote history chunk row has an invalid envelope");
    }
    const rawTag = value.type;
    if (rawTag !== "chunkrow/text-chunks" &&
        rawTag !== "chunkrow/reasoning-chunks" &&
        rawTag !== "chunkrow/tool-call-chunks") {
        throw new Error(`Remote history contains an unknown chunk row ${String(rawTag)}`);
    }
    const tag = rawTag.slice("chunkrow/".length) as "text-chunks" | "reasoning-chunks" | "tool-call-chunks";
    const seq0 = value.seq;
    const time0 = value.time;
    if (!isSafeSeq(seq0) || seq0 < 0 || Object.is(seq0, -0) || !Number.isSafeInteger(time0)) {
        throw new Error(`Remote history ${tag} row has an invalid sequence or timestamp`);
    }
    if (!isPlainRecord(value.data)) throw new Error(`Remote history ${tag} row has invalid data`);
    const data = value.data;
    const common = ["turn", "step", "index", "dt"];
    const payloadKey = tag === "tool-call-chunks" ? "args" : "texts";
    const expected = tag === "tool-call-chunks"
        ? (hasExactKeys(data, [...common, "id", "args"])
            ? [...common, "id", "args"]
            : hasExactKeys(data, [...common, "id", "name", "args"])
                ? [...common, "id", "name", "args"]
                : undefined)
        : [...common, "texts"];
    if (!expected || !hasExactKeys(data, expected)) {
        throw new Error(`Remote history ${tag} row has invalid fields`);
    }
    if (
        typeof data.turn !== "number" || !Number.isFinite(data.turn) ||
        typeof data.step !== "number" || !Number.isFinite(data.step) ||
        typeof data.index !== "number" || !Number.isFinite(data.index) ||
        !Array.isArray(data.dt) || !data.dt.every((gap) => Number.isSafeInteger(gap))
    ) {
        throw new Error(`Remote history ${tag} row has invalid run metadata`);
    }
    const members = data[payloadKey];
    if (!Array.isArray(members) || members.length === 0 || !members.every((item) => typeof item === "string")) {
        throw new Error(`Remote history ${tag} row has invalid chunk members`);
    }
    if (data.dt.length !== members.length - 1) {
        throw new Error(`Remote history ${tag} row has mismatched timestamp gaps`);
    }
    if (tag === "tool-call-chunks" && (typeof data.id !== "string" ||
        (Object.hasOwn(data, "name") && typeof data.name !== "string"))) {
        throw new Error(`Remote history ${tag} row has invalid tool identity`);
    }
    if (members.length - 1 > Number.MAX_SAFE_INTEGER - seq0) {
        throw new Error(`Remote history ${tag} row exceeds sequence bounds`);
    }
    const events: DshSessionEvent[] = [];
    let time = time0;
    for (let index = 0; index < members.length; index += 1) {
        if (index > 0) {
            time += data.dt[index - 1] as number;
            if (!Number.isSafeInteger(time)) throw new Error(`Remote history ${tag} row exceeds timestamp bounds`);
        }
        const chunk = tag === "text-chunks"
            ? { type: "text-delta", index: data.index, text: members[index] }
            : tag === "reasoning-chunks"
                ? { type: "reasoning-delta", index: data.index, text: members[index] }
                : {
                      type: "tool-call-delta",
                      index: data.index,
                      id: data.id,
                      ...(Object.hasOwn(data, "name") ? { name: data.name } : {}),
                      argumentsDelta: members[index],
                  };
        events.push({
            type: "assistant/chunk",
            seq: seq0 + index,
            time,
            data: { turn: data.turn, step: data.step, chunk },
        });
    }
    return events;
}

/** Decode the projection baseline carried by a Session opening snapshot. */
export function projectionBlock(value: unknown): DshSessionProjectionsBlock | undefined {
    if (!isPlainRecord(value) || !isSafeSeq(value.asOfSeq) || !isPlainRecord(value.values) || !isRemoteJsonValue(value.values)) return undefined;
    return { asOfSeq: value.asOfSeq, values: value.values };
}

/** Decode the opening cursor used as the fixed cut for backwards paging. */
export function sessionCursor(value: unknown): number | undefined {
    return isSafeSeq(value) ? value : undefined;
}

function isSafeSeq(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= -1 && !Object.is(value, -0);
}

function isSafeNonNegativeSeq(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
    const actual = Reflect.ownKeys(value);
    return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function hasOnlyKeys(value: object, keys: readonly string[]): boolean {
    return Reflect.ownKeys(value).every((key) => typeof key === "string" && keys.includes(key));
}

function validSurfaceOp(value: unknown): boolean {
    if (value === "append") return true;
    if (!isPlainRecord(value) || value.op !== "replace") return false;
    const current = hasExactKeys(value, ["op", "startSeq", "endSeq"]);
    const legacy = hasExactKeys(value, ["op", "start", "end"]);
    const start = current ? value.startSeq : value.start;
    const end = current ? value.endSeq : value.end;
    return (current || legacy) && isSafeNonNegativeSeq(start) && isSafeNonNegativeSeq(end) && start <= end;
}

function isPlainRecord(value: unknown): value is Record<string, any> {
    return typeof value === "object" && value !== null && !Array.isArray(value) &&
        (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
