import {
    ProjectionCell,
    SessionStateSnapshot,
    StoredSessionEvent,
} from "./sessionStore";
import { isRecord } from "./guards";
import { expandAssistantStream, TimedAssistantChunk } from "./assistantStream";

export type TraceRowCategory =
    | "boundary"
    | "user"
    | "context"
    | "assistant"
    | "tool"
    | "subtool"
    | "system"
    | "compaction"
    | "error"
    | "generic";

export interface TraceTokenUsage {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
}

export interface TraceToolSummary {
    name: string;
    args?: string;
    result?: string;
    presentation?: string;
}

export interface TraceRowView {
    id: string;
    seq: number;
    endSeq?: number;
    eventType: string;
    category: TraceRowCategory;
    summary: string;
    time: number;
    durationMs?: number;
    turn?: number;
    step?: number;
    callId?: string;
    parentCallId?: string;
    depth: number;
    groupId: string;
    error?: string;
    tokens?: TraceTokenUsage;
    tool?: TraceToolSummary;
}

export interface TraceSummaryField {
    label: string;
    value: string;
}

export interface TraceDetailSource {
    summary: TraceSummaryField[];
    raw: unknown;
}

export interface ProjectedTraceRow extends TraceRowView {
    /** Extension-host-only search index; never sent to the webview. */
    searchText: string;
    /** Extension-host-only detail source, serialized lazily after selection. */
    detail: TraceDetailSource;
}

export interface TraceProjectionItem {
    id: string;
    key: string;
    seq: number;
    valuePreview: string;
    searchText: string;
    detail: TraceDetailSource;
}

export interface TraceProjectionResult {
    rows: ProjectedTraceRow[];
    projections: TraceProjectionItem[];
    seqToRowId: ReadonlyMap<number, string>;
}

const INLINE_LIMIT = 240;
const PREVIEW_LIMIT = 1_200;
const RAW_STRING_LIMIT = 8_192;
const MAX_ARRAY_ITEMS = 200;
const MAX_OBJECT_KEYS = 200;
const MAX_DEPTH = 10;
const SENSITIVE_KEY = /api[_-]?key|authorization|cookie|credential|password|secret|access[_-]?token|refresh[_-]?token|bearer[_-]?token|auth[_-]?token/iu;

function finiteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

function nonNegativeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function nonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
}

function truncate(value: string, limit: number): string {
    if (value.length <= limit) return value;
    return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function oneLine(value: string, limit = INLINE_LIMIT): string {
    return truncate(value.replace(/\s+/gu, " ").trim(), limit);
}

function sanitizedValue(
    value: unknown,
    depth: number,
    seen: WeakSet<object>,
): unknown {
    if (value === null || typeof value === "boolean" || finiteNumber(value)) return value;
    if (typeof value === "string") return truncate(value, RAW_STRING_LIMIT);
    if (typeof value === "bigint") return `${String(value)}n`;
    if (typeof value === "undefined") return "[undefined]";
    if (typeof value !== "object") return `[${typeof value}]`;
    if (depth >= MAX_DEPTH) return "[depth limit]";
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    if (Array.isArray(value)) {
        const items = value
            .slice(0, MAX_ARRAY_ITEMS)
            .map((item) => sanitizedValue(item, depth + 1, seen));
        if (value.length > MAX_ARRAY_ITEMS) {
            items.push(`[${value.length - MAX_ARRAY_ITEMS} more items]`);
        }
        return items;
    }
    const output: Record<string, unknown> = {};
    const entries = Object.entries(value).slice(0, MAX_OBJECT_KEYS);
    for (const [key, item] of entries) {
        output[key] = SENSITIVE_KEY.test(key)
            ? "[redacted]"
            : sanitizedValue(item, depth + 1, seen);
    }
    if (Object.keys(value).length > MAX_OBJECT_KEYS) {
        output["[truncated]"] = `${Object.keys(value).length - MAX_OBJECT_KEYS} more keys`;
    }
    return output;
}

/** Size-bounded, secret-key-redacting JSON for local diagnostic display. */
export function safeTraceJson(value: unknown, maxCharacters = 65_536): string {
    const sanitized = sanitizedValue(value, 0, new WeakSet());
    let text: string;
    try {
        text = JSON.stringify(sanitized, undefined, 2);
    } catch {
        text = JSON.stringify("[unserializable]");
    }
    if (text.length <= maxCharacters) return text;
    return `${text.slice(0, Math.max(0, maxCharacters - 30))}\n… [raw detail truncated]`;
}

function inlineJson(value: unknown, limit = INLINE_LIMIT): string {
    return oneLine(safeTraceJson(value, limit * 3), limit);
}

function recordData(entry: StoredSessionEvent): Record<string, unknown> | undefined {
    return isRecord(entry.event.data) ? entry.event.data : undefined;
}

function contentText(value: unknown, limit = 4_000): string {
    if (typeof value === "string") return truncate(value, limit);
    if (!Array.isArray(value)) return "";
    const fragments: string[] = [];
    let remaining = limit;
    const append = (text: string): void => {
        if (remaining <= 0 || !text) return;
        const part = truncate(text, remaining);
        fragments.push(part);
        remaining -= part.length;
    };
    for (const candidate of value) {
        if (!isRecord(candidate)) continue;
        if ((candidate.type === "text" || candidate.type === "reasoning") && typeof candidate.text === "string") {
            append(candidate.text);
        } else if (candidate.type === "tool-call") {
            append(`${typeof candidate.name === "string" ? candidate.name : "tool"}(${typeof candidate.arguments === "string" ? candidate.arguments : ""})`);
        } else if (candidate.type === "tool-result") {
            append(contentText(candidate.content, remaining));
        } else if (candidate.type === "image") {
            append("[image]");
        } else if (typeof candidate.type === "string") {
            append(`[${candidate.type}]`);
        }
    }
    return fragments.join("\n");
}

function messageContent(data: Record<string, unknown> | undefined): unknown {
    if (!data) return undefined;
    const message = isRecord(data.message) ? data.message : undefined;
    return message?.content ?? data.content;
}

function turnStep(data: Record<string, unknown> | undefined): {
    turn?: number;
    step?: number;
} {
    return {
        ...(nonNegativeInteger(data?.turn) ? { turn: data.turn } : {}),
        ...(nonNegativeInteger(data?.step) ? { step: data.step } : {}),
    };
}

function stepKey(turn: number | undefined, step: number | undefined): string | undefined {
    return turn === undefined || step === undefined ? undefined : `${turn}:${step}`;
}

function durationBetween(
    start: StoredSessionEvent | undefined,
    end: StoredSessionEvent | undefined,
): number | undefined {
    if (!start || !end || !finiteNumber(start.event.time) || !finiteNumber(end.event.time)) {
        return undefined;
    }
    const duration = end.event.time - start.event.time;
    return duration >= 0 ? duration : undefined;
}

function errorMessage(value: unknown): string | undefined {
    if (typeof value === "string") return oneLine(value, 500);
    if (!isRecord(value)) return undefined;
    const message = typeof value.message === "string" ? value.message : undefined;
    const code = typeof value.code === "string" ? value.code : undefined;
    const name = typeof value.name === "string" ? value.name : undefined;
    if (message) return oneLine(`${code ? `[${code}] ` : ""}${message}`, 500);
    if (code || name) return [name, code].filter(Boolean).join(" · ");
    return undefined;
}

function tokenUsage(value: unknown): TraceTokenUsage | undefined {
    if (
        !isRecord(value) ||
        !nonNegativeInteger(value.inputTokens) ||
        !nonNegativeInteger(value.outputTokens)
    ) return undefined;
    const optional = (key: "cacheReadTokens" | "cacheWriteTokens" | "reasoningTokens") =>
        nonNegativeInteger(value[key]) ? value[key] : undefined;
    const cacheReadTokens = optional("cacheReadTokens");
    const cacheWriteTokens = optional("cacheWriteTokens");
    const reasoningTokens = optional("reasoningTokens");
    return {
        inputTokens: value.inputTokens,
        outputTokens: value.outputTokens,
        ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
        ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
        ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    };
}

function viewFor(entry: StoredSessionEvent | undefined, target: "call" | "result"):
    Record<string, unknown> | undefined {
    if (!entry || !isRecord(entry.view) || entry.view.for !== target || !isRecord(entry.view.view)) {
        return undefined;
    }
    return entry.view.view;
}

function presentationSummary(view: Record<string, unknown> | undefined): string | undefined {
    if (!view) return undefined;
    const pieces: string[] = [];
    if (typeof view.title === "string") pieces.push(view.title);
    if (typeof view.description === "string") pieces.push(view.description);
    if (typeof view.cwd === "string") pieces.push(`cwd ${view.cwd}`);
    if (view.rawInput !== undefined) pieces.push(inlineJson(view.rawInput));
    const text = contentText(view.content, 1_000);
    if (text) pieces.push(text);
    if (typeof view.output === "string") pieces.push(view.output);
    if (typeof view.path === "string") pieces.push(view.path);
    if (typeof view.url === "string") pieces.push(view.url);
    if (typeof view.answer === "string") pieces.push(view.answer);
    if (finiteNumber(view.exitCode)) pieces.push(`exit ${view.exitCode}`);
    if (typeof view.signal === "string") pieces.push(view.signal);
    return pieces.length ? oneLine(pieces.join(" · "), 600) : undefined;
}

interface ToolResultFacts {
    callId?: string;
    content: string;
    isError: boolean;
    error?: string;
}

function toolResultFacts(entry: StoredSessionEvent): ToolResultFacts {
    const data = recordData(entry);
    const message = isRecord(data?.message) ? data.message : undefined;
    const source = isRecord(message?.source) ? message.source : undefined;
    const block = Array.isArray(message?.content) && isRecord(message.content[0])
        ? message.content[0]
        : undefined;
    const callId = nonEmptyString(source?.callId)
        ? source.callId
        : nonEmptyString(block?.toolCallId)
          ? block.toolCallId
          : nonEmptyString(data?.callId)
            ? data.callId
            : undefined;
    const structuredError = errorMessage(data?.error);
    return {
        ...(callId === undefined ? {} : { callId }),
        content: contentText(block?.content ?? data?.content, 6_000),
        isError: block?.isError === true || data?.isError === true || structuredError !== undefined,
        ...(structuredError === undefined ? {} : { error: structuredError }),
    };
}

function eventGroup(turn: number | undefined, step: number | undefined, suffix?: string): string {
    const base = turn === undefined ? "session" : `turn:${turn}`;
    const stepped = step === undefined ? base : `${base}/step:${step}`;
    return suffix ? `${stepped}/${suffix}` : stepped;
}

function summaryFields(row: TraceRowView): TraceSummaryField[] {
    const date = new Date(row.time);
    const time = Number.isNaN(date.getTime()) ? String(row.time) : date.toISOString();
    return [
        { label: "Event", value: row.eventType },
        { label: "Sequence", value: row.endSeq === undefined ? String(row.seq) : `${row.seq} → ${row.endSeq}` },
        { label: "Time", value: time },
        ...(row.durationMs === undefined ? [] : [{ label: "Duration", value: `${row.durationMs} ms` }]),
        ...(row.turn === undefined ? [] : [{ label: "Turn", value: String(row.turn) }]),
        ...(row.step === undefined ? [] : [{ label: "Step", value: String(row.step) }]),
        ...(row.callId === undefined ? [] : [{ label: "Call ID", value: row.callId }]),
        ...(row.parentCallId === undefined ? [] : [{ label: "Parent call", value: row.parentCallId }]),
        ...(row.error === undefined ? [] : [{ label: "Error", value: row.error }]),
    ];
}

function projectedRow(
    row: TraceRowView,
    raw: unknown,
    searchParts: readonly unknown[],
    extraSummary: TraceSummaryField[] = [],
): ProjectedTraceRow {
    return {
        ...row,
        searchText: searchParts
            .map((part) => typeof part === "string" ? part : safeTraceJson(part, 8_000))
            .join("\n")
            .toLocaleLowerCase(),
        detail: { summary: [...summaryFields(row), ...extraSummary], raw },
    };
}

interface ChunkGroup {
    entries: StoredSessionEvent[];
    chunkCount?: number;
    text: string;
    reasoning: string;
    firstTokenTime?: number;
    usage?: TraceTokenUsage;
    finishReason?: string;
    error?: string;
}

function timedChunkGroup(chunks: readonly TimedAssistantChunk[]): ChunkGroup {
    const group: ChunkGroup = { entries: [], chunkCount: chunks.length, text: "", reasoning: "" };
    for (const { time, chunk } of chunks) {
        const text = chunk.type === "tool-call-delta" ? chunk.argumentsDelta : chunk.text;
        if ((chunk.type === "text-delta" || chunk.type === "reasoning-delta" || chunk.type === "tool-call-delta") && typeof text === "string") {
            const channel = chunk.type === "reasoning-delta" ? "reasoning" : "text";
            group[channel] = truncate(`${group[channel]}${text}`, 16_000);
            if ((text || (chunk.type === "tool-call-delta" && typeof chunk.name === "string")) &&
                group.firstTokenTime === undefined) group.firstTokenTime = time;
        } else if (chunk.type === "usage") {
            group.usage = tokenUsage(chunk.usage) ?? group.usage;
        } else if (chunk.type === "finish") {
            const reason = isRecord(chunk.reason) ? chunk.reason : undefined;
            group.finishReason = typeof reason?.kind === "string" ? reason.kind : undefined;
            group.error = errorMessage(reason?.failure);
        }
    }
    return group;
}

function chunkGroups(entries: readonly StoredSessionEvent[]): Map<string, ChunkGroup> {
    const groups = new Map<string, ChunkGroup>();
    for (const entry of entries) {
        if (entry.event.type !== "assistant/chunk") continue;
        const data = recordData(entry);
        const location = turnStep(data);
        const key = stepKey(location.turn, location.step);
        const chunk = isRecord(data?.chunk) ? data.chunk : undefined;
        if (!key || !chunk) continue;
        const current = groups.get(key) ?? { entries: [], text: "", reasoning: "" };
        current.entries.push(entry);
        if (chunk.type === "text-delta" && typeof chunk.text === "string") {
            current.text = truncate(`${current.text}${chunk.text}`, 16_000);
            if (chunk.text.length > 0 && current.firstTokenTime === undefined) current.firstTokenTime = entry.event.time;
        } else if (chunk.type === "reasoning-delta" && typeof chunk.text === "string") {
            current.reasoning = truncate(`${current.reasoning}${chunk.text}`, 16_000);
            if (chunk.text.length > 0 && current.firstTokenTime === undefined) current.firstTokenTime = entry.event.time;
        } else if (chunk.type === "tool-call-delta" && typeof chunk.argumentsDelta === "string") {
            current.text = truncate(`${current.text}${chunk.argumentsDelta}`, 16_000);
            if (chunk.argumentsDelta.length > 0 && current.firstTokenTime === undefined) current.firstTokenTime = entry.event.time;
        } else if (chunk.type === "usage") {
            const usage = tokenUsage(chunk.usage);
            if (usage) current.usage = usage;
        }
        groups.set(key, current);
    }
    return groups;
}

function indexFirst(
    entries: readonly StoredSessionEvent[],
    type: string,
    keyOf: (entry: StoredSessionEvent) => string | undefined,
): Map<string, StoredSessionEvent> {
    const result = new Map<string, StoredSessionEvent>();
    for (const entry of entries) {
        if (entry.event.type !== type) continue;
        const key = keyOf(entry);
        if (key !== undefined && !result.has(key)) result.set(key, entry);
    }
    return result;
}

function genericRow(
    entry: StoredSessionEvent,
    turnEnds: ReadonlyMap<string, StoredSessionEvent>,
    stepEnds: ReadonlyMap<string, StoredSessionEvent>,
    compactionEnds: ReadonlyMap<string, StoredSessionEvent>,
): ProjectedTraceRow {
    const event = entry.event;
    const data = recordData(entry);
    const location = turnStep(data);
    let category: TraceRowCategory = "generic";
    let summary = inlineJson(event.data);
    let durationMs: number | undefined;
    let error: string | undefined;
    let tokens: TraceTokenUsage | undefined;
    const extra: TraceSummaryField[] = [];

    if (event.type === "turn/start") {
        category = "boundary";
        summary = `Turn ${location.turn ?? "?"} started`;
        durationMs = durationBetween(entry, location.turn === undefined ? undefined : turnEnds.get(String(location.turn)));
    } else if (event.type === "turn/end") {
        category = "boundary";
        const reason = isRecord(data?.reason) ? data.reason : undefined;
        const kind = typeof reason?.kind === "string" ? reason.kind : "unknown";
        summary = `Turn ${location.turn ?? "?"} ended · ${kind}`;
        if (kind === "error") error = errorMessage(reason?.error) ?? "Turn failed";
        else if (kind === "blocked") error = "Turn blocked";
    } else if (event.type === "step/start") {
        category = "boundary";
        summary = `Step ${location.turn ?? "?"}.${location.step ?? "?"} started`;
        const key = stepKey(location.turn, location.step);
        durationMs = durationBetween(entry, key === undefined ? undefined : stepEnds.get(key));
    } else if (event.type === "step/end") {
        category = "boundary";
        summary = `Step ${location.turn ?? "?"}.${location.step ?? "?"} ended`;
    } else if (event.type === "user/message") {
        const message = data;
        const source = isRecord(message?.source) ? message.source : undefined;
        const text = contentText(message?.content, 6_000);
        const replaced = isRecord(event.surfaceOp) && event.surfaceOp.op === "replace";
        category = replaced ? "compaction" : source?.kind === "user" ? "user" : "context";
        summary = oneLine(text || `[${String(source?.kind ?? "user")}]`, 500);
        if (typeof source?.kind === "string") extra.push({ label: "Source", value: source.kind });
    } else if (event.type === "system/message") {
        category = "system";
        summary = oneLine(contentText(messageContent(data), 6_000) || "System prompt cleared", 500);
    } else if (event.type === "request/header") {
        category = "system";
        const header = isRecord(data?.header) ? data.header : undefined;
        const config = isRecord(header?.config) ? header.config : undefined;
        const provider = typeof config?.provider === "string" ? config.provider : undefined;
        const model = typeof config?.model === "string" ? config.model : undefined;
        const tools = Array.isArray(header?.tools) ? header.tools.length : 0;
        summary = `Request header${provider || model ? ` · ${[provider, model].filter(Boolean).join("/")}` : ""} · ${tools} tools`;
        if (provider) extra.push({ label: "Provider", value: provider });
        if (model) extra.push({ label: "Model", value: model });
    } else if (event.type === "request/context") {
        category = "system";
        const provider = typeof data?.provider === "string" ? data.provider : undefined;
        const model = typeof data?.model === "string" ? data.model : undefined;
        summary = `Request context · ${[provider, model].filter(Boolean).join("/") || "unknown route"}`;
    } else if (event.type.startsWith("compaction/")) {
        category = "compaction";
        if (event.type === "compaction/start") {
            const id = typeof data?.compactionId === "string" ? data.compactionId : undefined;
            durationMs = durationBetween(entry, id === undefined ? undefined : compactionEnds.get(id));
            summary = `Compaction started${id ? ` · ${id}` : ""}`;
        } else if (event.type === "compaction/summary") {
            summary = `Compaction summary · ${oneLine(contentText(data?.summary, 2_000), 400)}`;
            tokens = tokenUsage(data?.usage);
        } else if (event.type === "compaction/end") {
            error = errorMessage(data?.error);
            summary = error ? `Compaction failed · ${error}` : "Compaction completed";
        } else {
            summary = `Compaction · ${event.type}`;
        }
    } else if (event.type === "llm/retry") {
        category = "error";
        error = errorMessage(data?.failure) ?? "LLM retry";
        summary = `Retry ${String(data?.retry ?? "?")} · ${error}`;
        if (finiteNumber(data?.delayMs)) extra.push({ label: "Delay", value: `${data.delayMs} ms` });
    } else if (event.type === "assistant/message") {
        category = "assistant";
        summary = oneLine(contentText(messageContent(data), 8_000) || "Assistant message", 500);
        tokens = tokenUsage(data?.usage);
    }

    const row: TraceRowView = {
        id: `event:${event.seq}`,
        seq: event.seq,
        eventType: event.type,
        category,
        summary: summary || event.type,
        time: event.time,
        ...(durationMs === undefined ? {} : { durationMs }),
        ...location,
        depth: 0,
        groupId: eventGroup(location.turn, location.step),
        ...(error === undefined ? {} : { error }),
        ...(tokens === undefined ? {} : { tokens }),
    };
    return projectedRow(row, { event, ...(entry.view === undefined ? {} : { view: entry.view }) }, [
        event.type,
        summary,
        event.data,
        entry.view,
    ], extra);
}

function assistantRow(
    entry: StoredSessionEvent,
    chunks: ChunkGroup | undefined,
    stepStart: StoredSessionEvent | undefined,
): ProjectedTraceRow {
    const data = recordData(entry);
    const location = turnStep(data);
    const message = isRecord(data?.message) ? data.message : undefined;
    const source = isRecord(message?.source) ? message.source : undefined;
    const finalText = contentText(message?.content, 10_000);
    const streamed = [chunks?.reasoning, chunks?.text].filter(Boolean).join("\n");
    const usage = tokenUsage(data?.usage) ?? chunks?.usage;
    const durationMs = durationBetween(stepStart, entry);
    const ttft = stepStart && chunks?.firstTokenTime !== undefined
        ? chunks.firstTokenTime - stepStart.event.time
        : undefined;
    const row: TraceRowView = {
        id: `assistant:${location.turn ?? "?"}:${location.step ?? "?"}:${entry.event.seq}`,
        seq: entry.event.seq,
        eventType: "assistant/message",
        category: "assistant",
        summary: oneLine(finalText || streamed || "Assistant message", 500),
        time: entry.event.time,
        ...(durationMs === undefined ? {} : { durationMs }),
        ...location,
        depth: 0,
        groupId: eventGroup(location.turn, location.step, "assistant"),
        ...(usage === undefined ? {} : { tokens: usage }),
    };
    const extra: TraceSummaryField[] = [
        ...(typeof source?.provider === "string" ? [{ label: "Provider", value: source.provider }] : []),
        ...(typeof source?.model === "string" ? [{ label: "Model", value: source.model }] : []),
        ...(ttft === undefined || ttft < 0 ? [] : [{ label: "TTFT", value: `${ttft} ms` }]),
        ...(chunks === undefined ? [] : [{ label: "Stream events", value: String(chunks.chunkCount ?? chunks.entries.length) }]),
        ...(data?.interrupted === true ? [{ label: "Interrupted", value: "true" }] : []),
    ];
    return projectedRow(row, {
        event: entry.event,
        ...(entry.view === undefined ? {} : { view: entry.view }),
        ...(chunks === undefined ? {} : {
            stream: {
                eventCount: chunks.chunkCount ?? chunks.entries.length,
                firstSeq: chunks.entries[0]?.event.seq,
                lastSeq: chunks.entries.at(-1)?.event.seq,
                firstTokenTime: chunks.firstTokenTime,
                usage: chunks.usage,
            },
        }),
    }, [entry.event.data, finalText, streamed], extra);
}

function streamingAssistantRow(
    key: string,
    chunks: ChunkGroup,
    stepStart: StoredSessionEvent | undefined,
): ProjectedTraceRow | undefined {
    const first = chunks.entries[0];
    const last = chunks.entries.at(-1);
    if (!first || !last) return undefined;
    const location = turnStep(recordData(first));
    const summary = oneLine(chunks.text || chunks.reasoning || `${chunks.entries.length} stream chunks`, 500);
    const row: TraceRowView = {
        id: `assistant-stream:${key}`,
        seq: first.event.seq,
        endSeq: last.event.seq,
        eventType: "assistant/chunk",
        category: "assistant",
        summary,
        time: first.event.time,
        ...location,
        depth: 0,
        groupId: eventGroup(location.turn, location.step, "assistant"),
        ...(chunks.usage === undefined ? {} : { tokens: chunks.usage }),
    };
    const ttft = stepStart && chunks.firstTokenTime !== undefined
        ? chunks.firstTokenTime - stepStart.event.time
        : undefined;
    return projectedRow(row, { events: chunks.entries.map((entry) => entry.event) }, [
        chunks.text,
        chunks.reasoning,
    ], [
        { label: "Stream events", value: String(chunks.entries.length) },
        ...(ttft === undefined || ttft < 0 ? [] : [{ label: "TTFT", value: `${ttft} ms` }]),
    ]);
}

function assistantAttemptRow(entry: StoredSessionEvent, stepStart: StoredSessionEvent | undefined): ProjectedTraceRow {
    const data = recordData(entry);
    const chunks = expandAssistantStream(data?.stream);
    const group = timedChunkGroup(chunks);
    const location = turnStep(data);
    const reason = group.finishReason;
    const failed = reason === "error";
    const text = [group.reasoning, group.text].filter(Boolean).join("\n");
    const startTime = chunks[0]?.time ?? entry.event.time;
    const ttft = stepStart && group.firstTokenTime !== undefined
        ? group.firstTokenTime - stepStart.event.time : undefined;
    return projectedRow({
        id: `attempt:${entry.event.seq}`,
        seq: entry.event.seq,
        eventType: "assistant/attempt",
        category: "assistant",
        summary: oneLine(`Assistant attempt${reason ? ` · ${reason}` : ""}${text ? ` · ${text}` : ""}`, 500),
        time: startTime,
        ...(entry.event.time >= startTime ? { durationMs: entry.event.time - startTime } : {}),
        ...location,
        depth: 0,
        groupId: eventGroup(location.turn, location.step, `attempt:${entry.event.seq}`),
        ...(failed ? { error: group.error ?? "Assistant attempt failed" } : {}),
        ...(group.usage ? { tokens: group.usage } : {}),
    }, { event: entry.event }, [entry.event.data, text, reason], [
        { label: "Stream events", value: String(chunks.length) },
        ...(reason ? [{ label: "Finish reason", value: reason }] : []),
        ...(ttft === undefined || ttft < 0 ? [] : [{ label: "TTFT", value: `${ttft} ms` }]),
    ]);
}

function liveAssistantRow(snapshot: SessionStateSnapshot, stepStart: StoredSessionEvent | undefined): ProjectedTraceRow | undefined {
    const live = snapshot.assistantStream;
    if (!live || live.chunks.length === 0) return undefined;
    const group = timedChunkGroup(live.chunks);
    const first = live.chunks[0];
    const last = live.chunks.at(-1)!;
    const ttft = stepStart && group.firstTokenTime !== undefined
        ? group.firstTokenTime - stepStart.event.time : undefined;
    return projectedRow({
        id: `assistant-live:${live.attemptId}`,
        // Ordering anchor only: transient rows never enter seqToRowId or the event store.
        seq: live.startedAfterSeq + 0.5,
        eventType: "assistant/stream",
        category: "assistant",
        summary: oneLine(group.text || group.reasoning || `${live.chunks.length} stream chunks`, 500),
        time: first.time,
        ...(last.time >= first.time ? { durationMs: last.time - first.time } : {}),
        turn: live.turn,
        step: live.step,
        depth: 0,
        groupId: eventGroup(live.turn, live.step, "assistant"),
        ...(group.usage ? { tokens: group.usage } : {}),
    }, { attemptId: live.attemptId, stream: live.chunks }, [group.text, group.reasoning], [
        { label: "Stream events", value: String(live.chunks.length) },
        ...(ttft === undefined || ttft < 0 ? [] : [{ label: "TTFT", value: `${ttft} ms` }]),
    ]);
}

function toolRow(
    call: StoredSessionEvent | undefined,
    results: readonly StoredSessionEvent[],
): ProjectedTraceRow | undefined {
    const result = results[0];
    const callData = call ? recordData(call) : undefined;
    const resultFacts = result ? toolResultFacts(result) : undefined;
    const callId = nonEmptyString(callData?.callId) ? callData.callId : resultFacts?.callId;
    const anchor = call ?? result;
    if (!anchor || !callId) return undefined;
    const resultData = result ? recordData(result) : undefined;
    const location = turnStep(callData ?? resultData);
    const name = typeof callData?.name === "string" ? callData.name : "unknown tool";
    const args = typeof callData?.arguments === "string" ? oneLine(callData.arguments, 800) : undefined;
    const callView = viewFor(call, "call");
    const resultView = viewFor(result, "result");
    const callPresentation = presentationSummary(callView);
    const resultPresentation = presentationSummary(resultView);
    const resultSummary = resultPresentation ?? (resultFacts?.content ? oneLine(resultFacts.content, 800) : undefined);
    const title = typeof callView?.title === "string" ? callView.title : name;
    const error = resultFacts?.error ?? (resultFacts?.isError ? resultSummary || "Tool failed" : undefined);
    const durationMs = durationBetween(call, result);
    const row: TraceRowView = {
        id: `tool:${callId}`,
        seq: anchor.event.seq,
        ...(result === undefined ? {} : { endSeq: result.event.seq }),
        eventType: result === undefined ? "tool/call" : "tool/call → tool/result",
        category: "tool",
        summary: oneLine([title, resultSummary].filter(Boolean).join(" · ") || title, 500),
        time: anchor.event.time,
        ...(durationMs === undefined ? {} : { durationMs }),
        ...location,
        callId,
        depth: 0,
        groupId: eventGroup(location.turn, location.step, `tool:${callId}`),
        ...(error === undefined ? {} : { error }),
        tool: {
            name,
            ...(args === undefined ? {} : { args }),
            ...(resultSummary === undefined ? {} : { result: resultSummary }),
            ...(callPresentation === undefined ? {} : { presentation: callPresentation }),
        },
    };
    return projectedRow(row, {
        ...(call === undefined ? {} : { call: call.event, callView: call.view }),
        results: results.map((entry) => ({ event: entry.event, view: entry.view })),
    }, [name, callData?.arguments, callView, resultFacts?.content, resultView, error]);
}

function subtoolRow(
    start: StoredSessionEvent | undefined,
    settle: StoredSessionEvent | undefined,
    rootCall: StoredSessionEvent | undefined,
    depth: number,
): ProjectedTraceRow | undefined {
    const anchor = start ?? settle;
    if (!anchor) return undefined;
    const startData = start ? recordData(start) : undefined;
    const settleData = settle ? recordData(settle) : undefined;
    const data = startData ?? settleData;
    const callId = nonEmptyString(data?.subCallId) ? data.subCallId : undefined;
    if (!callId) return undefined;
    const parentCallId = nonEmptyString(data?.parentCallId) ? data.parentCallId : undefined;
    const rootCallId = nonEmptyString(data?.rootCallId) ? data.rootCallId : undefined;
    const name = typeof data?.name === "string" ? data.name : "subtool";
    const args = data?.arguments === undefined ? undefined : inlineJson(data.arguments, 800);
    const result = settleData ? oneLine(contentText(settleData.content, 6_000), 800) : undefined;
    const error = settleData?.isError === true ? result || "Subtool failed" : undefined;
    const ownLocation = turnStep(data);
    const rootLocation = turnStep(rootCall ? recordData(rootCall) : undefined);
    const location = {
        ...(ownLocation.turn ?? rootLocation.turn) === undefined
            ? {}
            : { turn: ownLocation.turn ?? rootLocation.turn },
        ...(ownLocation.step ?? rootLocation.step) === undefined
            ? {}
            : { step: ownLocation.step ?? rootLocation.step },
    };
    const durationMs = durationBetween(start, settle);
    const row: TraceRowView = {
        id: `subtool:${callId}`,
        seq: anchor.event.seq,
        ...(settle === undefined ? {} : { endSeq: settle.event.seq }),
        eventType: settle === undefined
            ? anchor.event.type
            : `${start?.event.type ?? "tool/ptc-dispatch-start"} → ${settle.event.type}`,
        category: "subtool",
        summary: oneLine([name, result].filter(Boolean).join(" · "), 500),
        time: anchor.event.time,
        ...(durationMs === undefined ? {} : { durationMs }),
        ...location,
        callId,
        ...(parentCallId === undefined ? {} : { parentCallId }),
        depth,
        groupId: eventGroup(location.turn, location.step, `tool:${rootCallId ?? parentCallId ?? callId}`),
        ...(error === undefined ? {} : { error }),
        tool: {
            name,
            ...(args === undefined ? {} : { args }),
            ...(result === undefined ? {} : { result }),
        },
    };
    return projectedRow(row, {
        ...(start === undefined ? {} : { start: start.event }),
        ...(settle === undefined ? {} : { result: settle.event }),
    }, [name, data?.arguments, settleData?.content, error]);
}

function projectionItems(cells: readonly ProjectionCell[]): TraceProjectionItem[] {
    return cells
        .map((cell) => ({
            id: `projection:${cell.key}`,
            key: cell.key,
            seq: cell.seq,
            valuePreview: oneLine(safeTraceJson(cell.value, PREVIEW_LIMIT), PREVIEW_LIMIT),
            searchText: `${cell.key}\n${safeTraceJson(cell.value, 8_000)}`.toLocaleLowerCase(),
            detail: {
                summary: [
                    { label: "Projection", value: cell.key },
                    { label: "Watermark seq", value: String(cell.seq) },
                ],
                raw: cell.value,
            },
        }))
        .sort((left, right) => left.key.localeCompare(right.key));
}

/** Pure projection from the shared per-session store into a bounded-render ledger model. */
export function projectSessionTrace(snapshot: SessionStateSnapshot): TraceProjectionResult {
    const entries = [...snapshot.events].sort((left, right) => left.event.seq - right.event.seq);
    const stepKeyOf = (entry: StoredSessionEvent): string | undefined => {
        const location = turnStep(recordData(entry));
        return stepKey(location.turn, location.step);
    };
    const turnKeyOf = (entry: StoredSessionEvent): string | undefined => {
        const turn = turnStep(recordData(entry)).turn;
        return turn === undefined ? undefined : String(turn);
    };
    const compactionKeyOf = (entry: StoredSessionEvent): string | undefined => {
        const value = recordData(entry)?.compactionId;
        return typeof value === "string" ? value : undefined;
    };
    const stepStarts = indexFirst(entries, "step/start", stepKeyOf);
    const stepEnds = indexFirst(entries, "step/end", stepKeyOf);
    const turnEnds = indexFirst(entries, "turn/end", turnKeyOf);
    const compactionEnds = indexFirst(entries, "compaction/end", compactionKeyOf);
    const chunks = chunkGroups(entries);
    const assistantSteps = new Set<string>();
    const calls = new Map<string, StoredSessionEvent>();
    const results = new Map<string, StoredSessionEvent[]>();
    const subStarts = new Map<string, StoredSessionEvent>();
    const subSettles = new Map<string, StoredSessionEvent>();

    for (const entry of entries) {
        const data = recordData(entry);
        if (entry.event.type === "assistant/message") {
            const location = turnStep(data);
            const key = stepKey(location.turn, location.step);
            if (key) assistantSteps.add(key);
        } else if (entry.event.type === "tool/call" && nonEmptyString(data?.callId)) {
            if (!calls.has(data.callId)) calls.set(data.callId, entry);
        } else if (entry.event.type === "tool/result") {
            const callId = toolResultFacts(entry).callId;
            if (callId) results.set(callId, [...(results.get(callId) ?? []), entry]);
        } else if ((entry.event.type === "tool/ptc-dispatch-start" || entry.event.type === "tool/code-dispatch-start") && nonEmptyString(data?.subCallId)) {
            if (!subStarts.has(data.subCallId)) subStarts.set(data.subCallId, entry);
        } else if ((entry.event.type === "tool/ptc-dispatch" || entry.event.type === "tool/code-dispatch") && nonEmptyString(data?.subCallId)) {
            if (!subSettles.has(data.subCallId)) subSettles.set(data.subCallId, entry);
        }
    }

    const subtoolDepth = (callId: string): number => {
        const visited = new Set<string>();
        let cursor: string | undefined = callId;
        let depth = 0;
        while (cursor && !visited.has(cursor) && depth < 256) {
            visited.add(cursor);
            const source: StoredSessionEvent | undefined =
                subStarts.get(cursor) ?? subSettles.get(cursor);
            const data: Record<string, unknown> | undefined =
                source ? recordData(source) : undefined;
            const parent: string | undefined = nonEmptyString(data?.parentCallId)
                ? data.parentCallId
                : undefined;
            depth += 1;
            cursor = parent && (subStarts.has(parent) || subSettles.has(parent)) ? parent : undefined;
        }
        return depth;
    };

    const rows: ProjectedTraceRow[] = [];
    const seqToRowId = new Map<number, string>();
    const mapRow = (row: ProjectedTraceRow, sourceEntries: readonly StoredSessionEvent[]): void => {
        rows.push(row);
        for (const source of sourceEntries) seqToRowId.set(source.event.seq, row.id);
    };

    for (const entry of entries) {
        if (entry.event.type === "assistant/chunk") continue;
        if (entry.event.type === "tool/result") {
            const callId = toolResultFacts(entry).callId;
            if (callId) {
                const grouped = results.get(callId) ?? [];
                if (calls.has(callId)) continue;
                if (grouped[0] === entry) {
                    const row = toolRow(undefined, grouped);
                    if (row) {
                        mapRow(row, grouped);
                        continue;
                    }
                } else {
                    const owner = toolRow(undefined, grouped);
                    if (owner) seqToRowId.set(entry.event.seq, owner.id);
                    continue;
                }
            }
        }
        if (entry.event.type === "tool/ptc-dispatch" || entry.event.type === "tool/code-dispatch") {
            const callId = recordData(entry)?.subCallId;
            if (typeof callId === "string") {
                if (subStarts.has(callId)) continue;
                const data = recordData(entry);
                const rootId = nonEmptyString(data?.rootCallId) ? data.rootCallId : undefined;
                const row = subtoolRow(
                    undefined,
                    entry,
                    rootId === undefined ? undefined : calls.get(rootId),
                    subtoolDepth(callId),
                );
                if (row) {
                    mapRow(row, [entry]);
                    continue;
                }
            }
        }
        if (entry.event.type === "tool/call") {
            const callId = recordData(entry)?.callId;
            if (typeof callId === "string") {
                const row = toolRow(entry, results.get(callId) ?? []);
                if (!row) {
                    mapRow(
                        genericRow(entry, turnEnds, stepEnds, compactionEnds),
                        [entry],
                    );
                    continue;
                }
                mapRow(row, [entry, ...(results.get(callId) ?? [])]);
                continue;
            }
        }
        if (entry.event.type === "tool/ptc-dispatch-start" || entry.event.type === "tool/code-dispatch-start") {
            const callId = recordData(entry)?.subCallId;
            const settle = typeof callId === "string" ? subSettles.get(callId) : undefined;
            const data = recordData(entry);
            const rootId = nonEmptyString(data?.rootCallId) ? data.rootCallId : undefined;
            const row = subtoolRow(
                entry,
                settle,
                rootId === undefined ? undefined : calls.get(rootId),
                typeof callId === "string" ? subtoolDepth(callId) : 1,
            );
            if (row) {
                mapRow(row, settle ? [entry, settle] : [entry]);
                continue;
            }
        }
        if (entry.event.type === "assistant/message") {
            const data = recordData(entry);
            const location = turnStep(data);
            const key = stepKey(location.turn, location.step);
            const group = Array.isArray(data?.stream)
                ? timedChunkGroup(expandAssistantStream(data.stream))
                : key === undefined ? undefined : chunks.get(key);
            const row = assistantRow(entry, group, key === undefined ? undefined : stepStarts.get(key));
            mapRow(row, [entry, ...(group?.entries ?? [])]);
            continue;
        }
        if (entry.event.type === "assistant/attempt") {
            const location = turnStep(recordData(entry));
            const key = stepKey(location.turn, location.step);
            mapRow(assistantAttemptRow(entry, key === undefined ? undefined : stepStarts.get(key)), [entry]);
            continue;
        }
        mapRow(
            genericRow(entry, turnEnds, stepEnds, compactionEnds),
            [entry],
        );
    }

    for (const [key, group] of chunks) {
        if (assistantSteps.has(key)) continue;
        const row = streamingAssistantRow(key, group, stepStarts.get(key));
        if (row) mapRow(row, group.entries);
    }
    for (const [callId, groupedResults] of results) {
        if (calls.has(callId)) continue;
        const first = groupedResults[0];
        if (!first || seqToRowId.has(first.event.seq)) continue;
        const row = toolRow(undefined, groupedResults);
        if (row) mapRow(row, groupedResults);
    }
    for (const [callId, settle] of subSettles) {
        if (subStarts.has(callId) || seqToRowId.has(settle.event.seq)) continue;
        const data = recordData(settle);
        const rootId = nonEmptyString(data?.rootCallId) ? data.rootCallId : undefined;
        const row = subtoolRow(
            undefined,
            settle,
            rootId === undefined ? undefined : calls.get(rootId),
            subtoolDepth(callId),
        );
        if (row) mapRow(row, [settle]);
    }

    const live = snapshot.assistantStream;
    const liveKey = live ? stepKey(live.turn, live.step) : undefined;
    const liveRow = liveAssistantRow(snapshot, liveKey === undefined ? undefined : stepStarts.get(liveKey));
    if (liveRow) rows.push(liveRow);
    rows.sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id));
    return {
        rows,
        projections: projectionItems(snapshot.projections),
        seqToRowId,
    };
}

export function traceRowView(row: ProjectedTraceRow): TraceRowView {
    const { searchText: _searchText, detail: _detail, ...view } = row;
    return view;
}
