import { isRecord } from "./guards";
import { DshModelSelection } from "./types";

/**
 * Read the effective model selection from the RC modelSelection projection.
 *
 * The projection exposes `next` as the selection for the next request and
 * falls back to `lastUsed` when no pending selection exists.  Treat malformed
 * or empty values as capability absence so an unexpected projection payload
 * cannot corrupt the editor-facing model state.
 */
export function normalizeModelSelectionProjection(value: unknown): DshModelSelection | undefined {
    if (!isRecord(value)) return undefined;
    return normalizeModelSelection(value.next) ?? normalizeModelSelection(value.lastUsed);
}

function normalizeModelSelection(value: unknown): DshModelSelection | undefined {
    if (!isRecord(value) || typeof value.provider !== "string" || typeof value.model !== "string") {
        return undefined;
    }
    if (!value.provider.trim() || !value.model.trim()) return undefined;
    if (value.reasoningEffort !== undefined &&
        (typeof value.reasoningEffort !== "string" || !value.reasoningEffort.trim())) {
        return undefined;
    }
    return {
        provider: value.provider,
        model: value.model,
        ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: value.reasoningEffort }),
    };
}

/** Compare the complete route, including an explicitly selected effort. */
export function sameModelSelection(
    left: DshModelSelection | undefined,
    right: DshModelSelection | undefined,
): boolean {
    return left === right || (
        left !== undefined &&
        right !== undefined &&
        left.provider === right.provider &&
        left.model === right.model &&
        left.reasoningEffort === right.reasoningEffort
    );
}
