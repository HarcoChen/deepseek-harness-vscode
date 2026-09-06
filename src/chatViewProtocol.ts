import {
    DshApprovalOutcome,
    DshImageUpload,
    DshMessageFeedbackRating,
    DshQuestionAnswerItem,
    DshQuestionItem,
} from "./types";
import { t } from "./localize";
import { parseSafeHttpUrl } from "./safeMarkdown";
import {
    MAX_FILE_LOCATION_INDEX,
    MAX_FILE_LOCATION_PATH_CHARACTERS,
} from "./fileLocations";
import { isImageMediaType, isRecord } from "./guards";

export type ChatViewAction =
    | { type: "ready" }
    | { type: "sendPrompt"; text: string; mode: "queue" | "steer"; images?: DshImageUpload[] }
    | { type: "retryPrompt"; id: string }
    | { type: "toggleFocus" }
    | { type: "cancel" }
    | { type: "configureApiKey" }
    | { type: "manageProviders" }
    | { type: "manageSettings" }
    | { type: "refreshPluginInventory" }
    | { type: "refreshDynamicPlugins" }
    | { type: "stopDynamicPlugin"; sessionId: string; pluginId: string }
    | { type: "removeDynamicPlugin"; sessionId: string; pluginId: string }
    | { type: "declineDynamicPlugin"; requestId: string; pluginId: string }
    | { type: "openSettingsDocument" }
    | {
          type: "mutateSettings";
          ns: string;
          revision: number;
          changes: Array<{ path: string[]; value: string; clear: boolean }>;
      }
    | { type: "manageAgentPresets" }
    | { type: "manageWorkspaces" }
    | { type: "openIdeContextPicker" }
    | { type: "openTerminalCommandPicker" }
    | { type: "captureAppShot" }
    | { type: "removeContext"; id: string }
    | { type: "loadImage"; attachmentId: string }
    | { type: "fileReferenceQuery"; query: string; quoted?: boolean }
    | { type: "toggleSelection" }
    | { type: "start" }
    | { type: "stop" }
    | { type: "openLogs" }
    | { type: "openBrowser" }
    | { type: "openExternalLink"; url: string }
    | { type: "openFileLocation"; path: string; line: number; column?: number }
    | { type: "copyCode"; renderId: string; codeBlockId: string }
    | { type: "insertCode"; renderId: string; codeBlockId: string }
    | { type: "openCode"; renderId: string; codeBlockId: string; language?: string }
    | { type: "applyCode"; renderId: string; codeBlockId: string; language?: string }
    | { type: "openTrace"; seq?: number }
    | { type: "openChangeDiff"; turn: number; fileId: string }
    | { type: "openToolDiff"; callId: string; path: string }
    | { type: "setPermissionPreset"; value: string }
    | { type: "setPlanMode"; active: boolean }
    | { type: "restoreTurnChanges"; turn: number }
    | { type: "forkFromMessage"; seq: number }
    | { type: "restoreCodeToMessage"; seq: number }
    | { type: "forkAndRestoreCodeToMessage"; seq: number }
    | { type: "toggleMessageFeedback"; messageId: string; rating: DshMessageFeedbackRating }
    | { type: "saveMessageFeedbackNote"; messageId: string; note: string }
    | { type: "switchSession"; sessionId: string }
    | { type: "newSession" }
    | { type: "newSessionInCurrentWorkspace" }
    | { type: "searchSession" }
    | { type: "selectModel" }
    | { type: "selectReasoningEffort"; effort: string }
    | { type: "openReasoningEffort" }
    | { type: "selectAgentPreset"; agentPreset?: string }
    | { type: "renameSession" }
    | { type: "forkSession" }
    | { type: "archiveSession" }
    | { type: "goalCreate"; objective: string; maxGoalRounds?: number }
    | ({ type: "goalEdit" } & (
          | { objective: string; maxGoalRounds?: number }
          | { objective?: never; maxGoalRounds: number }
      ))
    | { type: "goalPause" | "goalResume" | "goalComplete" | "goalClear" }
    | { type: "refreshSubagents" }
    | { type: "openSubagent"; childSessionId: string }
    | { type: "closeSubagent" }
    | { type: "followUpSubagent"; childSessionId: string; text: string }
    | { type: "interruptSubagent"; childSessionId: string }
    | { type: "answerApproval"; key: string; outcome: DshApprovalOutcome }
    | { type: "answerQuestion"; key: string; answers: DshQuestionAnswerItem[] }
    | {
          type: "updateQueue";
          itemId: string;
          action: "edit" | "remove" | "steer";
          text?: string;
    };

export const CHAT_WEBVIEW_PROTOCOL_VERSION = 1 as const;

function nonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

function positiveInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonNegativeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hasAny(value: Record<string, unknown>, keys: readonly string[]): boolean {
    return keys.some((key) => key in value);
}

function hasOnly(value: Record<string, unknown>, keys: readonly string[]): boolean {
    const allowed = new Set(keys);
    return Object.keys(value).every((key) => allowed.has(key));
}

const MAX_IMAGE_BASE64_CHARACTERS = 16 * 1024 * 1024;
const MAX_MESSAGE_IMAGE_BASE64_CHARACTERS = 128 * 1024 * 1024;

function imageUploads(value: unknown): DshImageUpload[] | undefined {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 100) return undefined;
    const images: DshImageUpload[] = [];
    let totalCharacters = 0;
    for (const candidate of value) {
        if (!isRecord(candidate) || !hasOnly(candidate, ["mediaType", "data", "name"])) return undefined;
        if (
            !isImageMediaType(candidate.mediaType) ||
            typeof candidate.data !== "string" ||
            candidate.data.length === 0 ||
            candidate.data.length > MAX_IMAGE_BASE64_CHARACTERS ||
            (candidate.name !== undefined &&
                (typeof candidate.name !== "string" || candidate.name.length > 512))
        ) return undefined;
        totalCharacters += candidate.data.length;
        if (totalCharacters > MAX_MESSAGE_IMAGE_BASE64_CHARACTERS) return undefined;
        images.push({
            mediaType: candidate.mediaType,
            data: candidate.data,
            ...(candidate.name === undefined ? {} : { name: candidate.name }),
        });
    }
    return images;
}

function questionAnswers(value: unknown): DshQuestionAnswerItem[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const answers: DshQuestionAnswerItem[] = [];
    for (const candidate of value) {
        if (
            !isRecord(candidate) ||
            typeof candidate.id !== "string" ||
            !Array.isArray(candidate.selected) ||
            !candidate.selected.every((item) => typeof item === "string") ||
            (candidate.custom !== undefined && typeof candidate.custom !== "string")
        ) {
            return undefined;
        }
        answers.push({
            id: candidate.id,
            selected: [...candidate.selected],
            ...(candidate.custom === undefined ? {} : { custom: candidate.custom }),
        });
    }
    return answers;
}

/**
 * Strict trust boundary for messages originating in the webview.
 *
 * Every branch rejects unknown keys — through `hasOnly` with the exact key list,
 * or `hasAny` where a denylist of host-owned fields reads more clearly. Keep that
 * true when adding an action: a branch without a key guard silently widens the
 * boundary. Senders must not attach `protocol` per action (see the note on
 * `postAction` in webview/src/bridge.ts); it is accepted only on the envelope.
 */
export function parseChatViewAction(value: unknown): ChatViewAction | undefined {
    if (!isRecord(value) || typeof value.type !== "string") return undefined;
    if (value.protocol !== undefined && value.protocol !== CHAT_WEBVIEW_PROTOCOL_VERSION) {
        return undefined;
    }
    switch (value.type) {
        case "ready":
        case "cancel":
        case "configureApiKey":
        case "manageProviders":
        case "manageSettings":
        case "openSettingsDocument":
        case "manageWorkspaces":
        case "openIdeContextPicker":
        case "openTerminalCommandPicker":
        case "captureAppShot":
        case "toggleSelection":
        case "toggleFocus":
        case "start":
        case "stop":
        case "openLogs":
        case "openBrowser":
        case "newSession":
        case "newSessionInCurrentWorkspace":
        case "searchSession":
        case "selectModel":
        case "renameSession":
        case "forkSession":
        case "archiveSession":
        case "goalPause":
        case "goalResume":
        case "goalComplete":
        case "goalClear":
        case "refreshSubagents":
        case "closeSubagent":
            if (
                (value.type.startsWith("goal") &&
                    hasAny(value, ["sessionId", "ref", "id", "revision"])) ||
                ((value.type === "refreshSubagents" || value.type === "closeSubagent") &&
                    hasAny(value, ["sessionId", "parentSessionId", "childSessionId", "mode", "provider"]))
            ) return undefined;
            return { type: value.type } as ChatViewAction;
        case "manageAgentPresets":
            return hasOnly(value, ["type", "protocol"])
                ? { type: "manageAgentPresets" }
                : undefined;
        case "refreshPluginInventory":
            return hasOnly(value, ["type", "protocol"])
                ? { type: "refreshPluginInventory" }
                : undefined;
        case "refreshDynamicPlugins":
            return hasOnly(value, ["type", "protocol"])
                ? { type: "refreshDynamicPlugins" }
                : undefined;
        case "stopDynamicPlugin":
        case "removeDynamicPlugin":
            if (
                !hasOnly(value, ["type", "sessionId", "pluginId", "protocol"]) ||
                !nonEmptyString(value.sessionId) ||
                value.sessionId.length > 256 ||
                !nonEmptyString(value.pluginId) ||
                value.pluginId.length > 256
            ) return undefined;
            return {
                type: value.type,
                sessionId: value.sessionId,
                pluginId: value.pluginId,
            } as ChatViewAction;
        case "declineDynamicPlugin":
            if (
                !hasOnly(value, ["type", "requestId", "pluginId", "protocol"]) ||
                !nonEmptyString(value.requestId) ||
                value.requestId.length > 256 ||
                !nonEmptyString(value.pluginId) ||
                value.pluginId.length > 256
            ) return undefined;
            return {
                type: "declineDynamicPlugin",
                requestId: value.requestId,
                pluginId: value.pluginId,
            };
        case "selectReasoningEffort":
            return hasOnly(value, ["type", "effort"]) &&
                nonEmptyString(value.effort) &&
                value.effort.length <= 128
                ? { type: "selectReasoningEffort", effort: value.effort.trim() }
                : undefined;
        case "openReasoningEffort":
            return hasOnly(value, ["type", "protocol"]) ? { type: "openReasoningEffort" } : undefined;
        case "openTrace":
            if (
                hasAny(value, ["sessionId", "callId", "turn", "step"]) ||
                (value.seq !== undefined && !nonNegativeInteger(value.seq))
            ) return undefined;
            return {
                type: "openTrace",
                ...(value.seq === undefined ? {} : { seq: value.seq }),
            };
        case "openChangeDiff":
            if (!positiveInteger(value.turn) || typeof value.fileId !== "string" ||
                !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value.fileId) ||
                !hasOnly(value, ["type", "turn", "fileId"])) return undefined;
            return { type: "openChangeDiff", turn: value.turn, fileId: value.fileId };
        case "openToolDiff":
            if (typeof value.callId !== "string" || !value.callId ||
                typeof value.path !== "string" || !value.path ||
                !hasOnly(value, ["type", "callId", "path"])) return undefined;
            return { type: "openToolDiff", callId: value.callId, path: value.path };
        case "setPermissionPreset":
            // Preset names are host-defined; the shape check is the wire's job
            // and the registry rejects an unknown one on execute.
            if (typeof value.value !== "string" || !/^[\w.-]{1,64}$/u.test(value.value) ||
                !hasOnly(value, ["type", "value"])) return undefined;
            return { type: "setPermissionPreset", value: value.value };
        case "setPlanMode":
            return hasOnly(value, ["type", "active"]) && typeof value.active === "boolean"
                ? { type: "setPlanMode", active: value.active }
                : undefined;
        case "restoreTurnChanges":
            if (!positiveInteger(value.turn) || !hasOnly(value, ["type", "turn"])) return undefined;
            return { type: "restoreTurnChanges", turn: value.turn };
        case "forkFromMessage":
        case "restoreCodeToMessage":
        case "forkAndRestoreCodeToMessage":
            if (!hasOnly(value, ["type", "seq"]) || !nonNegativeInteger(value.seq)) return undefined;
            if (value.type === "forkFromMessage") return { type: "forkFromMessage", seq: value.seq };
            if (value.type === "restoreCodeToMessage") return { type: "restoreCodeToMessage", seq: value.seq };
            return { type: "forkAndRestoreCodeToMessage", seq: value.seq };
        case "toggleMessageFeedback":
            if (
                !hasOnly(value, ["type", "messageId", "rating"]) ||
                !nonEmptyString(value.messageId) ||
                value.messageId.length > 512 ||
                (value.rating !== "positive" && value.rating !== "negative")
            ) return undefined;
            return {
                type: "toggleMessageFeedback",
                messageId: value.messageId,
                rating: value.rating,
            };
        case "saveMessageFeedbackNote":
            if (
                !hasOnly(value, ["type", "messageId", "note"]) ||
                !nonEmptyString(value.messageId) ||
                value.messageId.length > 512 ||
                typeof value.note !== "string" ||
                value.note.length > 32_768
            ) return undefined;
            return {
                type: "saveMessageFeedbackNote",
                messageId: value.messageId,
                note: value.note,
            };
        case "openExternalLink": {
            if (!hasOnly(value, ["type", "url"])) return undefined;
            const url = parseSafeHttpUrl(value.url);
            return url ? { type: "openExternalLink", url } : undefined;
        }
        case "openFileLocation":
            if (
                !hasOnly(value, ["type", "path", "line", "column"]) ||
                !nonEmptyString(value.path) ||
                value.path.length > MAX_FILE_LOCATION_PATH_CHARACTERS ||
                value.path.includes("\0") ||
                !positiveInteger(value.line) ||
                value.line > MAX_FILE_LOCATION_INDEX ||
                (value.column !== undefined &&
                    (!positiveInteger(value.column) || value.column > MAX_FILE_LOCATION_INDEX))
            ) return undefined;
            return {
                type: "openFileLocation",
                path: value.path,
                line: value.line,
                ...(value.column === undefined ? {} : { column: value.column }),
            };
        case "copyCode":
        case "insertCode":
        case "openCode":
        case "applyCode": {
            const hasLanguage = value.language !== undefined;
            const allowedKeys = value.type === "copyCode" || value.type === "insertCode"
                ? ["type", "renderId", "codeBlockId"]
                : ["type", "renderId", "codeBlockId", "language"];
            if (
                !hasOnly(value, allowedKeys) ||
                typeof value.renderId !== "string" ||
                !/^[a-f0-9]{32}$/u.test(value.renderId) ||
                !nonEmptyString(value.codeBlockId) ||
                !/^code-\d{1,6}$/u.test(value.codeBlockId) ||
                (hasLanguage && (
                    typeof value.language !== "string" ||
                    !/^[\p{L}\p{N}_+.#-]{1,40}$/u.test(value.language)
                ))
            ) return undefined;
            if (value.type === "copyCode") {
                return { type: "copyCode", renderId: value.renderId, codeBlockId: value.codeBlockId };
            }
            if (value.type === "insertCode") {
                return { type: "insertCode", renderId: value.renderId, codeBlockId: value.codeBlockId };
            }
            const language = value.language as string | undefined;
            return value.type === "openCode"
                ? {
                      type: "openCode",
                      renderId: value.renderId,
                      codeBlockId: value.codeBlockId,
                      ...(language === undefined ? {} : { language }),
                  }
                : {
                      type: "applyCode",
                      renderId: value.renderId,
                      codeBlockId: value.codeBlockId,
                      ...(language === undefined ? {} : { language }),
                  };
        }
        case "sendPrompt":
            if (!hasOnly(value, ["type", "text", "mode", "images"]) ||
                typeof value.text !== "string" ||
                (value.mode !== "queue" && value.mode !== "steer")) return undefined;
            {
                const images = imageUploads(value.images);
                if (!images || (!value.text.trim() && images.length === 0)) return undefined;
                return {
                    type: "sendPrompt",
                    text: value.text,
                    mode: value.mode,
                    ...(images.length === 0 ? {} : { images }),
                };
            }
        case "retryPrompt":
            return hasOnly(value, ["type", "id"]) && nonEmptyString(value.id)
                ? { type: "retryPrompt", id: value.id }
                : undefined;
        case "removeContext":
            return hasOnly(value, ["type", "id"]) && nonEmptyString(value.id)
                ? { type: "removeContext", id: value.id }
                : undefined;
        case "loadImage":
            return hasOnly(value, ["type", "attachmentId"]) &&
                nonEmptyString(value.attachmentId) && value.attachmentId.length <= 256
                ? { type: "loadImage", attachmentId: value.attachmentId }
                : undefined;
        case "fileReferenceQuery":
            if (
                !hasOnly(value, ["type", "query", "quoted"]) ||
                typeof value.query !== "string" ||
                value.query.length > 256 ||
                (value.quoted !== undefined && typeof value.quoted !== "boolean")
            ) return undefined;
            return {
                type: "fileReferenceQuery",
                query: value.query,
                ...(value.quoted === undefined ? {} : { quoted: value.quoted }),
            };
        case "mutateSettings": {
            if (
                !hasOnly(value, ["type", "ns", "revision", "changes"]) ||
                !nonEmptyString(value.ns) || value.ns.length > 256 ||
                !nonNegativeInteger(value.revision) || !Array.isArray(value.changes) ||
                value.changes.length === 0 || value.changes.length > 100
            ) return undefined;
            const changes: Array<{ path: string[]; value: string; clear: boolean }> = [];
            for (const candidate of value.changes) {
                if (
                    !isRecord(candidate) || !Array.isArray(candidate.path) || candidate.path.length === 0 ||
                    candidate.path.length > 32 || !candidate.path.every((segment) =>
                        typeof segment === "string" && segment.length > 0 && segment.length <= 128 &&
                        !segment.includes("\0"),
                    ) || typeof candidate.value !== "string" || candidate.value.length > 16_384 ||
                    typeof candidate.clear !== "boolean"
                ) return undefined;
                changes.push({ path: [...candidate.path] as string[], value: candidate.value, clear: candidate.clear });
            }
            return { type: "mutateSettings", ns: value.ns.trim(), revision: value.revision, changes };
        }
        case "switchSession":
            return hasOnly(value, ["type", "sessionId"]) && nonEmptyString(value.sessionId)
                ? { type: "switchSession", sessionId: value.sessionId }
                : undefined;
        case "selectAgentPreset":
            if (!hasOnly(value, ["type", "agentPreset"])) return undefined;
            if (value.agentPreset === undefined) return { type: "selectAgentPreset" };
            return nonEmptyString(value.agentPreset) && value.agentPreset.length <= 128
                ? { type: "selectAgentPreset", agentPreset: value.agentPreset.trim() }
                : undefined;
        case "goalCreate":
            if (
                hasAny(value, ["sessionId", "ref", "id", "revision"]) ||
                !nonEmptyString(value.objective) ||
                (value.maxGoalRounds !== undefined && !positiveInteger(value.maxGoalRounds))
            ) return undefined;
            return {
                type: "goalCreate",
                objective: value.objective.trim(),
                ...(value.maxGoalRounds === undefined
                    ? {}
                    : { maxGoalRounds: value.maxGoalRounds }),
            };
        case "goalEdit": {
            if (
                hasAny(value, ["sessionId", "ref", "id", "revision"]) ||
                (value.objective !== undefined && !nonEmptyString(value.objective)) ||
                (value.maxGoalRounds !== undefined && !positiveInteger(value.maxGoalRounds)) ||
                (value.objective === undefined && value.maxGoalRounds === undefined)
            ) return undefined;
            if (value.objective !== undefined) {
                return {
                    type: "goalEdit",
                    objective: value.objective.trim(),
                    ...(value.maxGoalRounds === undefined
                        ? {}
                        : { maxGoalRounds: value.maxGoalRounds }),
                };
            }
            if (value.maxGoalRounds === undefined) return undefined;
            return { type: "goalEdit", maxGoalRounds: value.maxGoalRounds };
        }
        case "openSubagent":
        case "interruptSubagent":
            if (
                hasAny(value, ["sessionId", "parentSessionId", "mode", "provider"]) ||
                !nonEmptyString(value.childSessionId)
            ) return undefined;
            return { type: value.type, childSessionId: value.childSessionId };
        case "followUpSubagent":
            if (
                hasAny(value, ["sessionId", "parentSessionId", "mode", "provider"]) ||
                !nonEmptyString(value.childSessionId) ||
                !nonEmptyString(value.text)
            ) return undefined;
            return {
                type: "followUpSubagent",
                childSessionId: value.childSessionId,
                text: value.text.trim(),
            };
        case "answerApproval":
            return hasOnly(value, ["type", "key", "outcome"]) &&
                nonEmptyString(value.key) &&
                (value.outcome === "allowed-once" || value.outcome === "rejected")
                ? { type: "answerApproval", key: value.key, outcome: value.outcome }
                : undefined;
        case "answerQuestion": {
            if (!hasOnly(value, ["type", "key", "answers"])) return undefined;
            const answers = questionAnswers(value.answers);
            return nonEmptyString(value.key) && answers
                ? { type: "answerQuestion", key: value.key, answers }
                : undefined;
        }
        case "updateQueue":
            if (
                !hasOnly(value, ["type", "itemId", "action", "text"]) ||
                !nonEmptyString(value.itemId) ||
                (value.action !== "edit" && value.action !== "remove" && value.action !== "steer")
            ) {
                return undefined;
            }
            if (value.action === "edit") {
                return typeof value.text === "string" && value.text.trim()
                    ? {
                          type: "updateQueue",
                          itemId: value.itemId,
                          action: "edit",
                          text: value.text,
                      }
                    : undefined;
            }
            return { type: "updateQueue", itemId: value.itemId, action: value.action };
        default:
            return undefined;
    }
}

/** Validate an answer against the exact pending question frame before claiming its rpcId. */
export function validateQuestionAnswers(
    questions: readonly DshQuestionItem[],
    answers: readonly DshQuestionAnswerItem[],
): string | undefined {
    const byId = new Map(questions.map((question) => [question.id, question]));
    if (byId.size !== questions.length || answers.length !== questions.length) {
        return t("The answers do not match the current request.");
    }
    const seen = new Set<string>();
    for (const answer of answers) {
        const question = byId.get(answer.id);
        if (!question || seen.has(answer.id)) {
            return t("The answers contain an unknown or duplicate identifier.");
        }
        seen.add(answer.id);
        if (!question.multiSelect && answer.selected.length > 1) {
            return t("A single-choice question cannot have multiple selections.");
        }
        const allowed = new Set((question.options ?? []).map((option) => option.label));
        if (answer.selected.some((selection) => !allowed.has(selection))) {
            return t("The answers contain an option that was not provided by the current request.");
        }
    }
    return undefined;
}
