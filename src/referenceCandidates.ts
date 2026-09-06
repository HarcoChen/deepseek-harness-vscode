import type {
    DshFileReferenceCandidate,
    DshSessionReferenceCandidate,
} from "./types";
import { isRecord } from "./guards";

const MAX_CANDIDATES = 200;
const MAX_PATH_LENGTH = 4_096;
const MAX_SESSION_ID_LENGTH = 512;
const MAX_LABEL_LENGTH = 512;
const MAX_CWD_LENGTH = 4_096;

/** Normalize one Runtime path without allowing it to become prompt syntax. */
function safePath(value: unknown, maxLength = MAX_PATH_LENGTH): string | undefined {
    if (typeof value !== "string" || value.length === 0 || value.length > maxLength) return undefined;
    if (/[\u0000-\u001f\u007f-\u009f"]/u.test(value)) return undefined;
    const normalized = value.replaceAll("\\", "/").replace(/\/+$/u, "");
    return normalized || undefined;
}

function safeText(value: unknown, maxLength: number): string | undefined {
    if (typeof value !== "string" || value.length === 0 || value.length > maxLength) return undefined;
    return /[\u0000-\u001f\u007f-\u009f]/u.test(value) ? undefined : value;
}

function safeCwd(value: unknown, maxLength = MAX_CWD_LENGTH): string | undefined {
    if (typeof value !== "string" || value.length === 0 || value.length > maxLength) return undefined;
    if (/[\u0000-\u001f\u007f-\u009f"]/u.test(value)) return undefined;
    const normalized = value.replaceAll("\\", "/").replace(/\/+$/u, "");
    if (normalized) return normalized;
    return value.includes("/") ? "/" : undefined;
}

/** Strictly parse the path-only result of the Runtime file-reference provider. */
export function normalizeFileReferenceCandidates(
    value: unknown,
): DshFileReferenceCandidate[] | undefined {
    if (!Array.isArray(value) || value.length > MAX_CANDIDATES) return undefined;
    const seen = new Set<string>();
    const candidates: DshFileReferenceCandidate[] = [];
    for (const item of value) {
        if (!isRecord(item) || (item.kind !== "file" && item.kind !== "directory")) return undefined;
        const path = safePath(item.path);
        if (!path) return undefined;
        const key = String(item.kind) + ":" + path;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({ kind: item.kind, path });
    }
    return candidates;
}

/** Strictly parse the mention-bearing result of the Runtime session resolver. */
export function normalizeSessionReferenceCandidates(
    value: unknown,
): DshSessionReferenceCandidate[] | undefined {
    if (!Array.isArray(value) || value.length > MAX_CANDIDATES) return undefined;
    const seen = new Set<string>();
    const candidates: DshSessionReferenceCandidate[] = [];
    for (const item of value) {
        if (
            !isRecord(item) ||
            typeof item.sameWorkspace !== "boolean" ||
            typeof item.createdAt !== "number" ||
            !Number.isSafeInteger(item.createdAt) ||
            item.createdAt < 0
        ) return undefined;
        const sessionId = safeText(item.sessionId, MAX_SESSION_ID_LENGTH);
        const label = safeText(item.label, MAX_LABEL_LENGTH);
        const mention = safeText(item.mention, MAX_LABEL_LENGTH + MAX_SESSION_ID_LENGTH + 64);
        const cwd = item.cwd === undefined ? undefined : safeCwd(item.cwd);
        if (!sessionId || !label || !mention || (item.cwd !== undefined && !cwd)) return undefined;
        if (!isCanonicalSessionMention(mention, sessionId, label)) return undefined;
        if (seen.has(sessionId)) continue;
        seen.add(sessionId);
        candidates.push({
            sessionId,
            label,
            ...(cwd === undefined ? {} : { cwd }),
            sameWorkspace: item.sameWorkspace,
            createdAt: item.createdAt,
            mention,
        });
    }
    return candidates;
}

/** Format the shared path mention grammar used by the Runtime provider. */
export function formatFileReferenceMention(
    candidate: DshFileReferenceCandidate,
    preserveQuote = false,
): string | undefined {
    const path = candidate.kind === "directory" ? candidate.path + "/" : candidate.path;
    if (/[\u0000-\u001f\u007f-\u009f"]/u.test(path)) return undefined;
    const quoted = preserveQuote || /\s/u.test(path);
    if (!quoted) return "@" + path;
    return candidate.kind === "directory" ? '@"' + path : '@"' + path + '"';
}

/** Format a canonical, lossless session mention when a caller needs one locally. */
export function formatSessionReferenceMention(sessionId: string, label: string): string {
    const payload = Buffer.from(JSON.stringify(sessionId), "utf8").toString("base64url");
    const escaped = label.replace(/[\\\]]/gu, (match) => "\\" + match);
    return "@[" + escaped + "](dsh-session:" + payload + ")";
}

/** Return the display name and parent path for one path candidate. */
export function referencePathPresentation(path: string, directory: boolean): {
    label: string;
    parent?: string;
} {
    const slash = path.lastIndexOf("/");
    const name = path.slice(slash + 1) || path;
    const parent = slash > 0 ? path.slice(0, slash) : undefined;
    return {
        label: name + (directory ? "/" : ""),
        ...(parent === undefined ? {} : { parent }),
    };
}

function isCanonicalSessionMention(mention: string, sessionId: string, label: string): boolean {
    return mention === formatSessionReferenceMention(sessionId, label);
}
