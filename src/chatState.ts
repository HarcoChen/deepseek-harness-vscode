import {
    ChatImageView,
    ChatLspOperation,
    ChatLspResultView,
    ChatMessage,
    ChatToolCall,
    ChatWebResultView,
    ChatWebSourceView,
    DshImageUpload,
    DshQueuedInboxItem,
    TurnStatusView,
} from "./types";
import { SessionStateSnapshot, StoredSessionEvent, toolResultCallId } from "./sessionStore";
import { safeTraceJson } from "./traceProjector";
import { t } from "./localize";
import { parseSafeHttpUrl } from "./safeMarkdown";
import { parseFileLocation } from "./fileLocations";
import { isImageMediaType, isRecord } from "./guards";
import { diffViewPaths, storedDiffView } from "./toolDiff";

export interface OptimisticPrompt {
    id: string;
    sessionId: string;
    /** Client-minted RC prompt identity used to reconcile retries with the durable message. */
    requestId?: string;
    displayText: string;
    wireText: string;
    afterSeq: number;
    createdAt: number;
    images?: ChatImageView[];
    imageUploads?: DshImageUpload[];
    error?: string;
}

export interface QueueDockItem {
    id: string;
    placement: "queued" | "steering";
    preview: string;
    editableText?: string;
}

const noVisibleAssistantAnswer = (): string => t("(no visible response)");
const TOOL_SUMMARY_LIMIT = 1_200;

export function resolvePromptMode(
    requested: "queue" | "steer",
    sessionRunning: boolean,
): "queue" | "steer" {
    return requested === "steer" && sessionRunning ? "steer" : "queue";
}

/** Focus mode is a presentation-only projection; the underlying event store stays intact. */
export function focusChatMessages(
    messages: readonly ChatMessage[],
    enabled: boolean,
): ChatMessage[] {
    if (!enabled) return messages.map((message) => ({ ...message }));
    return messages.flatMap((message) => {
        if (message.role === "tool") return [];
        if (message.role !== "assistant") return [{ ...message }];
        const {
            reasoning: _reasoning,
            reasoningState: _reasoningState,
            renderedReasoningHtml: _renderedReasoningHtml,
            reasoningRenderId: _reasoningRenderId,
            ...focused
        } = message;
        return [focused];
    });
}

interface ContentChannels {
    text: string;
    reasoning: string;
}

/** Preserve per-channel ContentBlock order without leaking reasoning into visible text. */
export function contentChannels(value: unknown): ContentChannels {
    const channels: ContentChannels = { text: "", reasoning: "" };
    const seen = new WeakSet<object>();
    const visit = (candidate: unknown, depth: number): void => {
        if (depth > 16 || candidate === null || candidate === undefined) return;
        if (typeof candidate === "string") {
            channels.text += candidate;
            return;
        }
        if (typeof candidate !== "object") return;
        if (seen.has(candidate)) return;
        seen.add(candidate);
        if (Array.isArray(candidate)) {
            for (const part of candidate) visit(part, depth + 1);
            return;
        }
        const object = candidate as Record<string, unknown>;
        const text = typeof object.text === "string" ? object.text : "";
        if (object.type === "reasoning") channels.reasoning += text;
        else if (text) channels.text += text;
        if (object.content !== undefined) visit(object.content, depth + 1);
    };
    visit(value, 0);
    return channels;
}

export function contentText(value: unknown): string {
    return contentChannels(value).text;
}

export function contentImages(value: unknown): ChatImageView[] {
    const images: ChatImageView[] = [];
    const seen = new WeakSet<object>();
    const seenAttachmentIds = new Set<string>();
    const visit = (candidate: unknown, depth: number): void => {
        if (depth > 16 || candidate === null || candidate === undefined || typeof candidate !== "object") return;
        if (seen.has(candidate)) return;
        seen.add(candidate);
        if (Array.isArray(candidate)) {
            for (const part of candidate) {
                if (images.length >= 100) return;
                visit(part, depth + 1);
            }
            return;
        }
        const object = candidate as Record<string, unknown>;
        if (object.type === "image" && isRecord(object.attachment)) {
            const attachment = object.attachment;
            if (
                typeof attachment.attachmentId === "string" &&
                !seenAttachmentIds.has(attachment.attachmentId) &&
                isImageMediaType(attachment.mediaType) &&
                typeof attachment.bytes === "number" &&
                Number.isSafeInteger(attachment.bytes) &&
                attachment.bytes > 0
            ) {
                seenAttachmentIds.add(attachment.attachmentId);
                const width = typeof attachment.width === "number" &&
                    Number.isSafeInteger(attachment.width) && attachment.width > 0
                    ? attachment.width
                    : undefined;
                const height = typeof attachment.height === "number" &&
                    Number.isSafeInteger(attachment.height) && attachment.height > 0
                    ? attachment.height
                    : undefined;
                images.push({
                    attachmentId: attachment.attachmentId,
                    mediaType: attachment.mediaType,
                    bytes: attachment.bytes,
                    ...(width === undefined ? {} : { width }),
                    ...(height === undefined ? {} : { height }),
                    ...(typeof attachment.name === "string" ? { name: attachment.name } : {}),
                    loadState: "idle",
                });
            }
        }
        for (const [key, child] of Object.entries(object)) {
            if (key === "attachment") continue;
            visit(child, depth + 1);
            if (images.length >= 100) return;
        }
    };
    visit(value, 0);
    return images;
}

export function promptDisplayText(wireText: string): string {
    const marker = "\n\n<ide_context>\n";
    const index = wireText.indexOf(marker);
    return index < 0 ? wireText : wireText.slice(0, index);
}

function messageRecord(event: StoredSessionEvent): Record<string, unknown> | undefined {
    const data = isRecord(event.event.data) ? event.event.data : undefined;
    if (!data) return undefined;
    if (event.event.type === "assistant/message") {
        return isRecord(data.message) ? data.message : undefined;
    }
    return data;
}

function directUser(event: StoredSessionEvent): boolean {
    if (event.event.type !== "user/message") return false;
    const message = messageRecord(event);
    return isRecord(message?.source) && message.source.kind === "user";
}

function eventText(event: StoredSessionEvent): string {
    const message = messageRecord(event);
    return contentText(message?.content ?? message?.text);
}

function eventRequestId(event: StoredSessionEvent): string | undefined {
    if (event.event.type !== "user/message") return undefined;
    const message = messageRecord(event);
    const source = isRecord(message?.source) ? message.source : undefined;
    return typeof source?.rpcId === "string" ? source.rpcId : undefined;
}

function oneLine(value: string, limit = TOOL_SUMMARY_LIMIT): string {
    const normalized = value.replace(/\s+/gu, " ").trim();
    return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

function toolView(event: StoredSessionEvent | undefined, target: "call" | "result"):
    Record<string, unknown> | undefined {
    if (!event || !isRecord(event.view) || event.view.for !== target || !isRecord(event.view.view)) {
        return undefined;
    }
    return event.view.view;
}

function toolResultContent(event: StoredSessionEvent | undefined): unknown {
    if (!event || event.event.type !== "tool/result" || !isRecord(event.event.data)) return undefined;
    const data = event.event.data;
    const message = isRecord(data.message) ? data.message : undefined;
    const block = Array.isArray(message?.content) && isRecord(message.content[0])
        ? message.content[0]
        : undefined;
    return block?.content ?? data.content;
}

function contentSummary(value: unknown): string {
    if (typeof value === "string") return oneLine(value);
    if (!Array.isArray(value)) return "";
    return oneLine(value.flatMap((part) => {
        if (!isRecord(part)) return [];
        if (typeof part.text === "string") return [part.text];
        if (part.type === "image") return ["[image]"];
        return [];
    }).join("\n"));
}

function presentationSummary(view: Record<string, unknown> | undefined): string | undefined {
    if (!view) return undefined;
    const parts: string[] = [];
    for (const key of ["description", "cwd", "path", "url", "answer", "output"] as const) {
        if (typeof view[key] === "string") parts.push(view[key]);
    }
    const content = contentSummary(view.content);
    if (content) parts.push(content);
    if (view.rawInput !== undefined) parts.push(oneLine(safeTraceJson(view.rawInput, 3_600)));
    if (typeof view.exitCode === "number") parts.push(`exit ${view.exitCode}`);
    if (typeof view.signal === "string") parts.push(view.signal);
    return parts.length ? oneLine(parts.join(" · ")) : undefined;
}

function webText(value: unknown, maximum: number): string | undefined {
    return typeof value === "string" && value.length <= maximum ? value : undefined;
}

function webLocation(value: unknown): Pick<ChatWebSourceView, "url" | "href" | "domain"> | undefined {
    const url = webText(value, 4_096);
    if (url === undefined || url.length === 0) return undefined;
    const href = parseSafeHttpUrl(url);
    if (!href) return { url };
    return { url, href, domain: new URL(href).hostname };
}

/** Narrow the public card:'web' result view without interpreting raw tool output. */
function webResultView(view: Record<string, unknown> | undefined): ChatWebResultView | undefined {
    if (!view || view.card !== "web" || typeof view.truncated !== "boolean") return undefined;
    if (view.kind === "search") {
        if (!Array.isArray(view.sources) || view.sources.length > 100) return undefined;
        const sources: ChatWebSourceView[] = [];
        for (const candidate of view.sources) {
            if (!isRecord(candidate)) return undefined;
            const location = webLocation(candidate.url);
            if (!location) return undefined;
            const title = webText(candidate.title, 1_024);
            const snippet = webText(candidate.snippet, 8_192);
            const publishedAt = webText(candidate.publishedAt, 256);
            if (
                (candidate.title !== undefined && title === undefined) ||
                (candidate.snippet !== undefined && snippet === undefined) ||
                (candidate.publishedAt !== undefined && publishedAt === undefined)
            ) return undefined;
            sources.push({
                ...location,
                ...(title === undefined ? {} : { title }),
                ...(snippet === undefined ? {} : { snippet }),
                ...(publishedAt === undefined ? {} : { publishedAt }),
            });
        }
        const answer = webText(view.answer, 100_000);
        if (view.answer !== undefined && answer === undefined) return undefined;
        return {
            kind: "search",
            sources,
            truncated: view.truncated,
            ...(answer === undefined ? {} : { answer }),
        };
    }
    if (view.kind === "fetch") {
        const location = webLocation(view.url);
        if (!location || typeof view.statusCode !== "number" ||
            !Number.isSafeInteger(view.statusCode) || view.statusCode < 100 || view.statusCode > 999) {
            return undefined;
        }
        return {
            kind: "fetch",
            ...location,
            statusCode: view.statusCode,
            truncated: view.truncated,
        };
    }
    return undefined;
}

function toolArgumentsSummary(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "string") return oneLine(safeTraceJson(value, 3_600));
    try {
        return oneLine(safeTraceJson(JSON.parse(value), 3_600));
    } catch {
        return oneLine(value);
    }
}

function toolArgumentsRecord(value: unknown): Record<string, unknown> | undefined {
    if (isRecord(value)) return value;
    if (typeof value !== "string") return undefined;
    try {
        const parsed: unknown = JSON.parse(value);
        return isRecord(parsed) ? parsed : undefined;
    } catch {
        return undefined;
    }
}

function toolResultRawText(event: StoredSessionEvent | undefined): string | undefined {
    const content = toolResultContent(event);
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return undefined;
    const parts = content.flatMap((part): string[] =>
        isRecord(part) && typeof part.text === "string" ? [part.text] : [],
    );
    return parts.length ? parts.join("") : undefined;
}

const LSP_OPERATIONS = new Set<ChatLspOperation>([
    "goToDefinition",
    "findReferences",
    "goToImplementation",
    "hover",
]);

function isLspOperation(value: unknown): value is ChatLspOperation {
    return typeof value === "string" && LSP_OPERATIONS.has(value as ChatLspOperation);
}

function lspResultView(
    name: string,
    argumentsValue: unknown,
    resultText: string | undefined,
): ChatLspResultView | undefined {
    if (name !== "lsp" || resultText === undefined || resultText.length > 16_000) return undefined;
    const args = toolArgumentsRecord(argumentsValue);
    const operation = args?.operation;
    const filePath = args?.file_path;
    const line = args?.line;
    const character = args?.character;
    if (
        !isLspOperation(operation) ||
        typeof filePath !== "string" || filePath.length === 0 || filePath.length > 4_096 ||
        typeof line !== "number" || !Number.isSafeInteger(line) || line <= 0 || line > 100_000_000 ||
        typeof character !== "number" || !Number.isSafeInteger(character) ||
        character <= 0 || character > 100_000_000
    ) return undefined;
    const query = { label: `${filePath}:${line}:${character}`, path: filePath, line, character };
    if (operation === "hover") {
        const empty = resultText === "No hover information.";
        return {
            kind: "hover",
            operation,
            query,
            ...(empty ? {} : { content: resultText }),
            empty,
            truncated: resultText.includes("hover truncated (limit "),
        };
    }
    const locations = [];
    const notices: string[] = [];
    for (const row of resultText.split("\n")) {
        if (!row) continue;
        const location = parseFileLocation(row);
        if (location) {
            locations.push({
                label: row,
                path: location.path,
                line: location.line,
                ...(location.column === undefined ? {} : { character: location.column }),
            });
        } else if (row !== "No results.") {
            notices.push(row);
        }
    }
    return {
        kind: "locations",
        operation,
        query,
        locations,
        notices,
        empty: resultText === "No results.",
        truncated: resultText.includes("locations truncated (limit ") ||
            /more locations? omitted \(limit /u.test(resultText),
    };
}

function toolResultFacts(event: StoredSessionEvent): {
    callId?: string;
    result?: string;
    error?: string;
} {
    const data = isRecord(event.event.data) ? event.event.data : undefined;
    const message = isRecord(data?.message) ? data.message : undefined;
    const source = isRecord(message?.source) ? message.source : undefined;
    const block = Array.isArray(message?.content) && isRecord(message.content[0])
        ? message.content[0]
        : undefined;
    const callId = toolResultCallId(event);
    const result = presentationSummary(toolView(event, "result")) ||
        contentSummary(toolResultContent(event)) || undefined;
    const structuredError = isRecord(data?.error)
        ? [data.error.code, data.error.message].filter((part) => typeof part === "string").join(" · ")
        : typeof data?.error === "string" ? data.error : undefined;
    const failed = block?.isError === true || data?.isError === true || Boolean(structuredError);
    return {
        ...(callId ? { callId } : {}),
        ...(result ? { result } : {}),
        ...(failed ? { error: oneLine(structuredError || result || "Tool failed") } : {}),
    };
}

function projectToolRows(snapshot: SessionStateSnapshot): Array<ChatMessage & { order: number }> {
    const calls = new Map<string, StoredSessionEvent>();
    const results = new Map<string, StoredSessionEvent>();
    for (const event of snapshot.events) {
        const data = isRecord(event.event.data) ? event.event.data : undefined;
        if (event.event.type === "tool/call" && typeof data?.callId === "string") {
            calls.set(data.callId, event);
        } else if (event.event.type === "tool/result") {
            const callId = toolResultFacts(event).callId;
            if (callId && !results.has(callId)) results.set(callId, event);
        }
    }
    return [...new Set([...calls.keys(), ...results.keys()])].flatMap((callId) => {
        const call = calls.get(callId);
        const result = results.get(callId);
        const anchor = call ?? result;
        if (!anchor) return [];
        const data = call && isRecord(call.event.data) ? call.event.data : undefined;
        const facts = result ? toolResultFacts(result) : undefined;
        const callPresentation = toolView(call, "call");
        const resultPresentation = toolView(result, "result");
        const name = typeof data?.name === "string" ? data.name : "unknown tool";
        const title = typeof resultPresentation?.title === "string"
            ? resultPresentation.title
            : typeof callPresentation?.title === "string"
              ? callPresentation.title
              : name;
        const args = presentationSummary(callPresentation) ||
            toolArgumentsSummary(data?.arguments);
        const durationMs = call && result && result.event.time >= call.event.time
            ? result.event.time - call.event.time
            : undefined;
        const web = facts?.error ? undefined : webResultView(resultPresentation);
        const lsp = facts?.error
            ? undefined
            : lspResultView(name, data?.arguments, toolResultRawText(result));
        const images = contentImages(toolResultContent(result));
        // Only a settled, successful call has applied hunks. A pending `edit`
        // carries just the model's bare old_string→new_string proposal, which
        // has no context lines to anchor a rewind on, so offering a diff there
        // would only ever fail.
        const diffPaths = !result || facts?.error
            ? []
            : diffViewPaths(storedDiffView(call, result));
        const tool: ChatToolCall = {
            callId,
            name,
            title,
            status: !result ? "running" : facts?.error ? "failed" : "completed",
            ...(args ? { args } : {}),
            ...(facts?.result ? { result: facts.result } : {}),
            ...(durationMs === undefined ? {} : { durationMs }),
            ...(facts?.error ? { error: facts.error } : {}),
            ...(images.length ? { images } : {}),
            ...(web === undefined ? {} : { web }),
            ...(lsp === undefined ? {} : { lsp }),
            ...(diffPaths.length ? { diffPaths } : {}),
        };
        return [{
            id: `tool:${callId}`,
            role: "tool" as const,
            text: title,
            tool,
            createdAt: anchor.event.time,
            seq: anchor.event.seq,
            state: result ? "committed" as const : "streaming" as const,
            order: anchor.event.seq + 0.25,
        }];
    });
}

function projectCompactionRows(
    snapshot: SessionStateSnapshot,
): Array<ChatMessage & { order: number }> {
    interface CompactionAccumulator {
        start?: StoredSessionEvent;
        summary?: StoredSessionEvent;
        end?: StoredSessionEvent;
    }
    const byId = new Map<string, CompactionAccumulator>();
    for (const event of snapshot.events) {
        const data = isRecord(event.event.data) ? event.event.data : undefined;
        const compactionId = typeof data?.compactionId === "string"
            ? data.compactionId
            : undefined;
        if (compactionId === undefined) continue;
        let acc = byId.get(compactionId);
        if (!acc) {
            acc = { start: undefined, summary: undefined, end: undefined };
            byId.set(compactionId, acc);
        }
        if (event.event.type === "compaction/start") acc.start = event;
        else if (event.event.type === "compaction/summary") acc.summary = event;
        else if (event.event.type === "compaction/end") acc.end = event;
    }
    const rows: Array<ChatMessage & { order: number }> = [];
    for (const [compactionId, acc] of byId) {
        const startEvent = acc.start;
        const endEvent = acc.end;
        if (!startEvent && !acc.summary && !endEvent) continue;
        const summaryText = (() => {
            if (!acc.summary) return undefined;
            const data = isRecord(acc.summary.event.data) ? acc.summary.event.data : undefined;
            const summary = contentText(data?.summary);
            return summary.trim() ? summary : undefined;
        })();
        const errorMessage = (() => {
            if (!endEvent) return undefined;
            const data = isRecord(endEvent.event.data) ? endEvent.event.data : undefined;
            const error = data?.error;
            if (typeof error === "string" && error.trim()) return error;
            if (!isRecord(error)) return undefined;
            if (typeof error.message === "string" && error.message.trim()) return error.message;
            if (typeof error.code === "string" || typeof error.name === "string") {
                return [error.name, error.code].filter(Boolean).join(" · ");
            }
            return undefined;
        })();
        const failed = Boolean(endEvent) && Boolean(errorMessage);
        const status = failed ? "failed" as const : endEvent ? "success" as const : "running" as const;
        const anchor = endEvent ?? acc.summary ?? startEvent;
        if (!anchor) continue;
        const text = failed
            ? t("Context compaction failed")
            : endEvent
              ? t("Context compacted")
              : t("Compacting context...");
        rows.push({
            id: `compaction:${compactionId}`,
            role: "system",
            text,
            compaction: {
                status,
                compactionId,
                ...(summaryText === undefined ? {} : { summary: summaryText }),
                ...(errorMessage === undefined ? {} : { error: errorMessage }),
            },
            createdAt: anchor.event.time,
            seq: anchor.event.seq,
            state: "committed",
            order: anchor.event.seq + 0.35,
        });
    }
    return rows;
}

function assistantLocation(event: StoredSessionEvent): string | undefined {
    if (event.event.type !== "assistant/message" || !isRecord(event.event.data)) return undefined;
    const turn = event.event.data.turn;
    const step = event.event.data.step;
    return typeof turn === "number" && typeof step === "number" ? `${turn}:${step}` : undefined;
}

interface PartialBlock {
    kind: "text" | "reasoning" | "other";
    text: string;
}

interface PartialMessage {
    key: string;
    turn: number;
    step: number;
    firstSeq: number;
    lastTime: number;
    blocks: Map<number, PartialBlock>;
}

function foldPartialChunk(partial: PartialMessage, chunk: Record<string, unknown>): void {
    const index = typeof chunk.index === "number" ? chunk.index : -1;
    if (index < 0) return;
    const previous = partial.blocks.get(index);
    switch (chunk.type) {
        case "block-start": {
            const kind = chunk.blockType === "text" || chunk.blockType === "reasoning"
                ? chunk.blockType
                : "other";
            partial.blocks.set(index, { kind, text: "" });
            return;
        }
        case "text-delta":
            partial.blocks.set(index, {
                kind: "text",
                text: (previous?.kind === "text" ? previous.text : "") +
                    (typeof chunk.text === "string" ? chunk.text : ""),
            });
            return;
        case "reasoning-delta":
            partial.blocks.set(index, {
                kind: "reasoning",
                text: (previous?.kind === "reasoning" ? previous.text : "") +
                    (typeof chunk.text === "string" ? chunk.text : ""),
            });
            return;
        case "block-end": {
            const block = isRecord(chunk.block) ? chunk.block : undefined;
            const kind = block?.type === "text" || block?.type === "reasoning"
                ? block.type
                : "other";
            partial.blocks.set(index, {
                kind,
                text: typeof block?.text === "string" ? block.text : "",
            });
            return;
        }
        default:
            return;
    }
}

/**
 * Renders a prompt that has no committed event yet. A send failure becomes a
 * system row carrying the error, so the text the user typed is never shown as if
 * it had reached the model.
 */
function optimisticRow(item: OptimisticPrompt): ChatMessage {
    return {
        id: item.id,
        role: item.error ? "system" : "user",
        text: item.error ? t("Send failed: {error}", { error: item.error }) : item.displayText,
        ...(item.images?.length ? { images: item.images.map((image) => ({ ...image })) } : {}),
        createdAt: item.createdAt,
        state: item.error ? "failed" : "pending",
    };
}

/**
 * Derive the visible chat from the current surface plus raw in-flight chunks. Finalized
 * assistant messages consume their source chunk seqs, so the partial disappears atomically
 * instead of rendering a duplicate assistant reply.
 */
/**
 * Splits a leading direct skill invocation off a prompt.
 *
 * `dsh-tool-skill` recognizes a whitespace-bounded `/name` at the pre-step
 * boundary and answers with injected skill content, so the invocation is
 * ordinary prompt text on the wire with no event of its own. Recognizing it
 * needs the session's catalog: `/notaskill` is just text, and must stay text.
 */
export function splitSkillInvocation(
    text: string,
    skillNames: ReadonlySet<string> | undefined,
): { skill: string; rest: string } | undefined {
    if (!skillNames?.size) return undefined;
    const match = /^\/(\S+)(?:$|[\t\n\r ])/u.exec(text);
    const name = match?.[1];
    if (name === undefined || !skillNames.has(name)) return undefined;
    return { skill: name, rest: text.slice(match![0].length).trimStart() };
}

export function projectChatMessages(
    snapshot: SessionStateSnapshot | undefined,
    optimistic: readonly OptimisticPrompt[],
    skillNames?: ReadonlySet<string>,
): ChatMessage[] {
    if (!snapshot) {
        return optimistic.map(optimisticRow);
    }

    const optimisticForSession = optimistic
        .filter((item) => item.sessionId === snapshot.sessionId)
        .sort((left, right) => left.createdAt - right.createdAt);
    const matchBySeq = new Map<number, OptimisticPrompt>();
    const matched = new Set<string>();
    for (const item of optimisticForSession) {
        const candidate = snapshot.events.find(
            (stored) =>
                !matched.has(`event:${stored.event.seq}`) &&
                directUser(stored) &&
                (item.requestId !== undefined
                    ? eventRequestId(stored) === item.requestId
                    : stored.event.seq > item.afterSeq && eventText(stored) === item.wireText),
        );
        if (candidate) {
            matchBySeq.set(candidate.event.seq, item);
            matched.add(item.id);
            matched.add(`event:${candidate.event.seq}`);
        }
    }

    const rows: Array<ChatMessage & { order: number }> = [];
    const finalizedChunkSeqs = new Set<number>();
    const finalizedLocations = new Set<string>();
    for (const stored of snapshot.events) {
        if (stored.event.type !== "assistant/message") continue;
        for (const seq of stored.event.sourceEventSeqs ?? []) finalizedChunkSeqs.add(seq);
        const location = assistantLocation(stored);
        if (location) finalizedLocations.add(location);
    }
    // Model-visible replacements must not erase the conversation already shown to the user.
    for (const node of snapshot.events) {
        if (node.event.surfaceOp !== "append") continue;
        if (directUser(node)) {
            const optimisticMatch = matchBySeq.get(node.event.seq);
            const message = messageRecord(node);
            const images = contentImages(message?.content);
            const displayed = optimisticMatch?.displayText ?? promptDisplayText(eventText(node));
            const invocation = splitSkillInvocation(displayed, skillNames);
            rows.push({
                id: `event:${node.event.seq}`,
                role: "user",
                text: invocation ? invocation.rest : displayed,
                ...(invocation ? { skillInvocation: invocation.skill } : {}),
                ...(images.length
                    ? {
                          images: images.map((image, index) => ({
                              ...image,
                              ...(optimisticMatch?.images?.[index]?.src
                                  ? { src: optimisticMatch.images[index].src }
                                  : {}),
                          })),
                      }
                    : {}),
                createdAt: node.event.time,
                seq: node.event.seq,
                state: "committed",
                order: node.event.seq,
            });
        } else if (node.event.type === "assistant/message") {
            const message = messageRecord(node);
            const content = contentChannels(message?.content ?? message?.text);
            const images = contentImages(message?.content);
            if (content.text || content.reasoning || images.length) {
                rows.push({
                    id: `event:${node.event.seq}`,
                    role: "assistant",
                    text: content.text || (images.length ? "" : noVisibleAssistantAnswer()),
                    ...(images.length ? { images } : {}),
                    ...(content.reasoning
                        ? { reasoning: content.reasoning, reasoningState: "complete" as const }
                        : {}),
                    createdAt: node.event.time,
                    seq: node.event.seq,
                    state: "committed",
                    order: node.event.seq,
                });
            }
        }
    }
    rows.push(...projectToolRows(snapshot));
    rows.push(...projectCompactionRows(snapshot));

    const partials = new Map<string, PartialMessage>();
    const endedTurns = new Set<number>();
    for (const stored of snapshot.events) {
        if (stored.event.type !== "turn/end" || !isRecord(stored.event.data)) continue;
        if (typeof stored.event.data.turn === "number") endedTurns.add(stored.event.data.turn);
    }
    for (const stored of snapshot.events) {
        const event = stored.event;
        if (event.type !== "assistant/chunk" || finalizedChunkSeqs.has(event.seq) || !isRecord(event.data)) {
            continue;
        }
        const turn = event.data.turn;
        const step = event.data.step;
        const chunk = isRecord(event.data.chunk) ? event.data.chunk : undefined;
        if (typeof turn !== "number" || typeof step !== "number" || !chunk) continue;
        const key = `${turn}:${step}`;
        if (finalizedLocations.has(key)) continue;
        let partial = partials.get(key);
        if (!partial) {
            partial = {
                key,
                turn,
                step,
                firstSeq: event.seq,
                lastTime: event.time,
                blocks: new Map(),
            };
            partials.set(key, partial);
        }
        partial.lastTime = event.time;
        foldPartialChunk(partial, chunk);
    }
    const live = snapshot.assistantStream;
    if (live) {
        const partial: PartialMessage = {
            key: live.attemptId,
            turn: live.turn,
            step: live.step,
            firstSeq: live.startedAfterSeq,
            lastTime: live.chunks.at(-1)?.time ?? 0,
            blocks: new Map(),
        };
        for (const timed of live.chunks) foldPartialChunk(partial, timed.chunk);
        partials.set(live.attemptId, partial);
    }
    for (const partial of partials.values()) {
        const blocks = [...partial.blocks.entries()].sort(([left], [right]) => left - right);
        const text = blocks
            .filter(([, block]) => block.kind === "text")
            .map(([, block]) => block.text)
            .join("");
        const reasoning = blocks
            .filter(([, block]) => block.kind === "reasoning")
            .map(([, block]) => block.text)
            .join("");
        if (!text && !reasoning) continue;
        const complete = endedTurns.has(partial.turn);
        rows.push({
            id: `partial:${partial.key}`,
            role: "assistant",
            text: text || noVisibleAssistantAnswer(),
            ...(reasoning
                ? {
                      reasoning,
                      reasoningState: complete ? "complete" as const : "streaming" as const,
                  }
                : {}),
            createdAt: partial.lastTime,
            state: complete ? "committed" : "streaming",
            order: partial.firstSeq + 0.5,
        });
    }

    for (const stored of snapshot.events) {
        const event = stored.event;
        if (event.type !== "turn/end" || !isRecord(event.data) || !isRecord(event.data.reason)) {
            continue;
        }
        const reason = event.data.reason;
        if (reason.kind !== "error" && reason.kind !== "blocked") continue;
        const failure = isRecord(reason.error) ? reason.error : reason;
        const message = typeof failure.message === "string"
            ? failure.message
            : t("The dsh agent ended the turn before generating a response.");
        const code = typeof failure.code === "string" ? failure.code : undefined;
        rows.push({
            id: `turn-error:${event.seq}`,
            role: "system",
            text: code ? `[${code}] ${message}` : message,
            createdAt: event.time,
            seq: event.seq,
            state: "committed",
            order: event.seq + 0.75,
        });
    }

    rows.sort((left, right) => left.order - right.order);
    const projected = rows.map(({ order: _order, ...message }) => message);
    for (const item of optimisticForSession) {
        if (matched.has(item.id)) continue;
        projected.push(optimisticRow(item));
    }
    return projected;
}

/** Project the current turn lifecycle from durable events plus authoritative transient state. */
export function projectTurnStatus(
    snapshot: SessionStateSnapshot | undefined,
    hostRunning: boolean,
    hostError?: string,
): TurnStatusView {
    const pendingInteraction = snapshot?.interactions.some(
        (interaction) => interaction.status === "pending" || interaction.status === "submitting",
    ) === true;
    const turns = new Map<number, { started: boolean; end?: StoredSessionEvent }>();
    for (const stored of snapshot?.events ?? []) {
        if ((stored.event.type !== "turn/start" && stored.event.type !== "turn/end") ||
            !isRecord(stored.event.data) ||
            typeof stored.event.data.turn !== "number" ||
            !Number.isSafeInteger(stored.event.data.turn) ||
            stored.event.data.turn < 1) continue;
        const turn = stored.event.data.turn;
        const current = turns.get(turn) ?? { started: false };
        if (stored.event.type === "turn/start") current.started = true;
        else current.end = stored;
        turns.set(turn, current);
    }
    const latestTurn = [...turns.keys()].sort((left, right) => right - left)[0];
    const latest = latestTurn === undefined ? undefined : turns.get(latestTurn);
    if (pendingInteraction) {
        return { phase: "waiting", ...(latestTurn === undefined ? {} : { turn: latestTurn }) };
    }
    if (hostRunning || (latest?.started === true && latest.end === undefined)) {
        return { phase: "running", ...(latestTurn === undefined ? {} : { turn: latestTurn }) };
    }
    if (hostError) {
        return {
            phase: "failed",
            ...(latestTurn === undefined ? {} : { turn: latestTurn }),
            detail: hostError,
        };
    }
    if ((snapshot?.queue.items.length ?? 0) > 0) {
        return { phase: "queued", ...(latestTurn === undefined ? {} : { turn: latestTurn }) };
    }
    const endData = latest?.end && isRecord(latest.end.event.data) ? latest.end.event.data : undefined;
    const reason = isRecord(endData?.reason) ? endData.reason : undefined;
    const kind = typeof reason?.kind === "string" ? reason.kind : undefined;
    if (kind === "completed") return { phase: "completed", turn: latestTurn };
    if (kind === "aborted" || kind === "interrupted") {
        return { phase: "cancelled", turn: latestTurn };
    }
    if (kind) {
        const failure = isRecord(reason?.error) ? reason.error : undefined;
        const detail = typeof failure?.message === "string"
            ? failure.message
            : kind === "max-tokens" ? t("Maximum output tokens reached") : kind;
        return { phase: "failed", turn: latestTurn, detail };
    }
    return { phase: "completed" };
}

export function hiddenViewBadge(
    sessions: readonly { sessionId: string; pendingInteraction?: unknown }[],
    completedSessionIds: ReadonlySet<string>,
): { value: number; tooltip: string } | undefined {
    const attention = sessions.filter((session) => session.pendingInteraction !== undefined);
    const notified = new Set([
        ...attention.map((session) => session.sessionId),
        ...completedSessionIds,
    ]);
    if (notified.size === 0) return undefined;
    return {
        value: notified.size,
        tooltip: attention.length > 0
            ? attention.length === 1
                ? t("{count} session waiting for action", { count: attention.length })
                : t("{count} sessions waiting for action", { count: attention.length })
            : notified.size === 1
                ? t("{count} session completed", { count: notified.size })
                : t("{count} sessions completed", { count: notified.size }),
    };
}

export function queueDockItems(items: readonly DshQueuedInboxItem[]): QueueDockItem[] {
    return items.flatMap((item) => {
        if (item.placement === "context") return [];
        const message = isRecord(item.message) ? item.message : undefined;
        const content = Array.isArray(message?.content) ? message.content : [];
        const preview = content
            .map((block) => {
                if (!isRecord(block)) return "";
                return block.type === "text" && typeof block.text === "string"
                    ? block.text
                    : `[${String(block.type ?? t("content"))}]`;
            })
            .join(" ")
            .replace(/\s+/gu, " ")
            .trim();
        const editable = content.every((block) => isRecord(block) && block.type === "text");
        return [{
            id: item.id,
            placement: item.placement,
            preview: Array.from(preview).length > 200
                ? `${Array.from(preview).slice(0, 200).join("")}…`
                : preview,
            ...(editable ? { editableText: contentText(content) } : {}),
        }];
    });
}

export function highestKnownSeq(snapshot: SessionStateSnapshot | undefined): number {
    return snapshot?.events.reduce(
        (maximum, stored) => Math.max(maximum, stored.event.seq),
        -1,
    ) ?? -1;
}
