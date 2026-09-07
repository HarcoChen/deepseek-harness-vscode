import { errorMessage } from "./errors";
import type { DshRuntime } from "./dshRuntime";
import { t } from "./localize";
import {
    normalizeSubagentCatalog,
    normalizeSubagentTiming,
    projectSubagentHistory,
    SubagentTreeStore,
} from "./sessionFeatures";
import { projectionValue, type SessionStateSnapshot } from "./sessionStore";
import type {
    DshHistoryEntry,
    DshSubagentAddress,
    DshSubagentCatalog,
    SubagentHistoryPreview,
    SubagentTimingView,
    SubagentTreeNodeView,
    SubagentTreeView,
} from "./types";

export interface SubagentControllerDeps {
    readonly runtime: DshRuntime;
    /** The chat view's current root session, read live at every use. */
    readonly currentRootSession: () => string | undefined;
    /** Repaint request; only fired when the affected session is the current root. */
    readonly onChange: () => void;
}

function lowestEventSeq(entries: readonly DshHistoryEntry[]): number | undefined {
    let lowest: number | undefined;
    for (const entry of entries) {
        const seq = entry.event.seq;
        if (typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0) {
            lowest = lowest === undefined ? seq : Math.min(lowest, seq);
        }
    }
    return lowest;
}

/**
 * Owns the subagent surface end to end — the per-root trees, the open
 * history preview, and the follow-up/interrupt flows — so ChatViewProvider
 * only forwards actions and reads {@link SubagentController.tree} /
 * {@link SubagentController.previewFor} when composing its state snapshot.
 */
export class SubagentController {
    private readonly trees = new SubagentTreeStore();
    private readonly treeAborts = new Map<string, AbortController>();
    private preview: SubagentHistoryPreview | undefined;
    private previewAbort: AbortController | undefined;
    private previewGeneration = 0;
    private refreshTimer: ReturnType<typeof setTimeout> | undefined;

    public constructor(private readonly deps: SubagentControllerDeps) {}

    public tree(rootSessionId: string): SubagentTreeView | undefined {
        return this.trees.get(rootSessionId);
    }

    /** The open preview when it belongs to {@param rootSessionId}. */
    public previewFor(rootSessionId: string | undefined): SubagentHistoryPreview | undefined {
        return rootSessionId !== undefined && this.preview?.rootSessionId === rootSessionId
            ? this.preview
            : undefined;
    }

    public observeSubagentTiming(
        sessionId: string,
        snapshot: SessionStateSnapshot,
    ): boolean {
        const rootSessionId = this.deps.currentRootSession();
        if (!rootSessionId || sessionId === rootSessionId) return false;
        const tree = this.trees.get(rootSessionId);
        if (!tree?.nodes.some((node) => node.kind === "child" && node.id === sessionId)) {
            return false;
        }
        const timing = normalizeSubagentTiming(projectionValue(snapshot, "subagentTiming"));
        const changed = this.trees.updateTiming(rootSessionId, sessionId, timing);
        if (
            changed &&
            this.preview?.rootSessionId === rootSessionId &&
            this.preview.childSessionId === sessionId
        ) {
            this.preview = { ...this.preview, timing };
        }
        return changed;
    }

    public scheduleSubagentRefresh(): void {
        if (this.refreshTimer || !this.deps.currentRootSession() || !this.deps.runtime.getUrl()) return;
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = undefined;
            const rootSessionId = this.deps.currentRootSession();
            if (rootSessionId) void this.refreshSubagentTree(rootSessionId);
        }, 75);
    }

    public async refreshSubagentTree(rootSessionId: string): Promise<void> {
        this.treeAborts.get(rootSessionId)?.abort();
        const controller = new AbortController();
        this.treeAborts.set(rootSessionId, controller);
        const generation = this.trees.begin(rootSessionId);
        if (rootSessionId === this.deps.currentRootSession()) this.deps.onChange();

        try {
            const catalogs = new Map<string, DshSubagentCatalog>();
            const pending = [rootSessionId];
            const visited = new Set<string>();
            while (pending.length > 0) {
                const parentSessionId = pending.shift();
                if (!parentSessionId || visited.has(parentSessionId)) continue;
                visited.add(parentSessionId);
                const raw = await this.deps.runtime.listSubagents(parentSessionId, controller.signal);
                const catalog = normalizeSubagentCatalog(raw);
                if (!catalog) {
                    throw new Error(t("Harness returned an invalid subagent.list for {sessionId}.", { sessionId: parentSessionId }));
                }
                catalogs.set(parentSessionId, catalog);
                for (const entry of catalog.entries) {
                    if (entry.kind === "child" && entry.hasChildren && !visited.has(entry.id)) {
                        pending.push(entry.id);
                    }
                }
            }
            const applied = this.trees.resolve(
                rootSessionId,
                generation,
                catalogs,
                this.subagentTimingMap(catalogs),
            );
            if (applied && this.preview?.rootSessionId === rootSessionId) {
                const refreshed = this.trees
                    .get(rootSessionId)
                    ?.nodes.find(
                        (node) =>
                            node.kind === "child" &&
                            node.id === this.preview?.childSessionId,
                    );
                if (
                    refreshed &&
                    (refreshed.mode === "one-shot" || refreshed.mode === "continuable") &&
                    (refreshed.activity === "running" || refreshed.activity === "inactive")
                ) {
                    this.preview = {
                        ...this.preview,
                        label: refreshed.label ?? refreshed.id,
                        mode: refreshed.mode,
                        activity: refreshed.activity,
                        parentAvailable: refreshed.parentAvailable,
                        timing: refreshed.timing,
                    };
                } else {
                    this.preview = {
                        ...this.preview,
                        state: "error",
                        error: t("This subagent is no longer in the current official catalog."),
                    };
                }
            }
        } catch (error) {
            if (!controller.signal.aborted) {
                this.trees.fail(rootSessionId, generation, errorMessage(error));
            }
        } finally {
            if (this.treeAborts.get(rootSessionId) === controller) {
                this.treeAborts.delete(rootSessionId);
            }
            if (rootSessionId === this.deps.currentRootSession()) this.deps.onChange();
        }
    }

    private subagentTimingMap(
        catalogs: ReadonlyMap<string, DshSubagentCatalog>,
    ): Map<string, SubagentTimingView> {
        const catalog = this.deps.runtime.getSessionCatalog().snapshot();
        const summaries = new Map(catalog.sessions.map((item) => [item.sessionId, item] as const));
        const timings = new Map<string, SubagentTimingView>();
        for (const childCatalog of catalogs.values()) {
            for (const entry of childCatalog.entries) {
                if (entry.kind !== "child") continue;
                const snapshot = this.deps.runtime.getSessionStore().get(entry.id);
                const local = normalizeSubagentTiming(
                    projectionValue(snapshot, "subagentTiming"),
                );
                const summary = summaries.get(entry.id);
                const listed = normalizeSubagentTiming(
                    summary?.projections?.values.subagentTiming,
                );
                // Attached sessions receive live projection frames through the mux; a cold
                // child has no SessionStore row, so its session.list projection is the
                // available baseline. During an initial history repair, retain that baseline
                // until the store has a complete cut.
                const timing = local ?? (!snapshot || snapshot.needsHistoryBaseline ? listed : undefined);
                if (timing !== undefined) timings.set(entry.id, timing);
            }
        }
        return timings;
    }

    private selectedSubagent(childSessionId: string): SubagentTreeNodeView | undefined {
        const rootSessionId = this.deps.currentRootSession();
        if (!rootSessionId) return undefined;
        const matches = this.trees
            .get(rootSessionId)
            ?.nodes.filter((node) => node.kind === "child" && node.id === childSessionId) ?? [];
        return matches.length === 1 ? matches[0] : undefined;
    }

    private subagentAddress(node: SubagentTreeNodeView): DshSubagentAddress | undefined {
        if (node.kind !== "child" || (node.mode !== "one-shot" && node.mode !== "continuable")) {
            return undefined;
        }
        return {
            parentSessionId: node.parentSessionId,
            childSessionId: node.id,
            mode: node.mode,
        };
    }

    private async readCompleteSubagentHistory(
        address: DshSubagentAddress,
        signal: AbortSignal,
    ) {
        const tail = await this.deps.runtime.subagentHistory(address, undefined, 100, signal);
        const pages = [tail.events];
        let hasMore = tail.hasMore;
        let beforeSeq = lowestEventSeq(tail.events);
        while (hasMore) {
            if (beforeSeq === undefined || beforeSeq <= 0) {
                throw new Error(t("Subagent {sessionId} history pagination did not provide an earlier seq.", { sessionId: address.childSessionId }));
            }
            const page = await this.deps.runtime.subagentHistory(address, beforeSeq, 100, signal);
            pages.push(page.events);
            const nextBeforeSeq = lowestEventSeq(page.events);
            if (page.hasMore && (nextBeforeSeq === undefined || nextBeforeSeq >= beforeSeq)) {
                throw new Error(t("Subagent {sessionId} history pagination did not advance.", { sessionId: address.childSessionId }));
            }
            beforeSeq = nextBeforeSeq;
            hasMore = page.hasMore;
        }
        return {
            events: pages.flat(),
            hasMore: false,
            ...(tail.projections === undefined ? {} : { projections: tail.projections }),
        };
    }

    public async openSubagentHistory(childSessionId: string): Promise<void> {
        const rootSessionId = this.deps.currentRootSession();
        const node = this.selectedSubagent(childSessionId);
        const address = node && this.subagentAddress(node);
        if (
            !rootSessionId ||
            !node ||
            !address ||
            (node.activity !== "running" && node.activity !== "inactive")
        ) return;

        this.previewAbort?.abort();
        const controller = new AbortController();
        this.previewAbort = controller;
        const generation = ++this.previewGeneration;
        this.preview = {
            rootSessionId,
            childSessionId,
            label: node.label ?? childSessionId,
            mode: address.mode,
            parentAvailable: node.parentAvailable,
            activity: node.activity,
            ...(node.timing === undefined ? {} : { timing: node.timing }),
            state: "loading",
            messages: [],
        };
        this.deps.onChange();

        try {
            const history = await this.readCompleteSubagentHistory(address, controller.signal);
            if (
                controller.signal.aborted ||
                generation !== this.previewGeneration ||
                rootSessionId !== this.deps.currentRootSession()
            ) return;
            const timing = normalizeSubagentTiming(history.projections?.values.subagentTiming) ?? node.timing;
            this.preview = {
                ...this.preview,
                rootSessionId,
                childSessionId,
                label: node.label ?? childSessionId,
                mode: address.mode,
                parentAvailable: node.parentAvailable,
                activity: node.activity,
                ...(timing === undefined ? {} : { timing }),
                state: "ready",
                messages: projectSubagentHistory(childSessionId, history),
            };
        } catch (error) {
            if (
                !controller.signal.aborted &&
                generation === this.previewGeneration &&
                rootSessionId === this.deps.currentRootSession()
            ) {
                this.preview = {
                    ...this.preview,
                    rootSessionId,
                    childSessionId,
                    label: node.label ?? childSessionId,
                    mode: address.mode,
                    parentAvailable: node.parentAvailable,
                    activity: node.activity,
                    state: "error",
                    messages: [],
                    error: errorMessage(error),
                };
            }
        } finally {
            if (this.previewAbort === controller) this.previewAbort = undefined;
            if (rootSessionId === this.deps.currentRootSession()) this.deps.onChange();
        }
    }

    public closeSubagentHistory(): void {
        this.discardSubagentPreview();
        this.deps.onChange();
    }

    public discardSubagentPreview(): void {
        this.previewAbort?.abort();
        this.previewAbort = undefined;
        this.previewGeneration += 1;
        this.preview = undefined;
    }

    /**
     * Drops the optimistic `pendingAction` and then re-opens the preview.
     * Clearing it here rather than relying on the reopen matters because
     * `openSubagentHistory` returns early when the node is gone or is no longer
     * continuable, and a refresh can leave an error preview in place — either
     * way a preview left in "pending" state blocks every later follow-up and
     * interrupt until the user closes it.
     */
    private async settlePreviewAction(
        rootSessionId: string,
        childSessionId: string,
        previewGeneration: number,
    ): Promise<void> {
        const preview = this.preview;
        if (
            this.deps.currentRootSession() !== rootSessionId ||
            this.previewGeneration !== previewGeneration ||
            preview?.childSessionId !== childSessionId
        ) return;
        if (preview.pendingAction !== undefined) {
            this.preview = { ...preview, pendingAction: undefined };
            this.deps.onChange();
        }
        await this.openSubagentHistory(childSessionId);
    }

    public async followUpSubagent(childSessionId: string, text: string): Promise<void> {
        const rootSessionId = this.deps.currentRootSession();
        const node = this.selectedSubagent(childSessionId);
        const preview = this.preview;
        if (
            !rootSessionId ||
            !node ||
            node.mode !== "continuable" ||
            !node.parentAvailable ||
            !preview ||
            preview.rootSessionId !== rootSessionId ||
            preview.childSessionId !== childSessionId ||
            preview.pendingAction
        ) return;
        const previewGeneration = this.previewGeneration;
        this.preview = { ...preview, pendingAction: "follow-up", error: undefined };
        this.deps.onChange();
        try {
            const result = await this.deps.runtime.promptSubagent({
                parentSessionId: node.parentSessionId,
                childSessionId,
                mode: "continuable",
            }, text);
            if (typeof result.messageId !== "string") {
                throw new Error(t("Harness returned an invalid subagent.prompt acknowledgement."));
            }
            await this.refreshSubagentTree(rootSessionId);
            await this.settlePreviewAction(rootSessionId, childSessionId, previewGeneration);
        } catch (error) {
            if (this.deps.currentRootSession() === rootSessionId && this.preview?.childSessionId === childSessionId) {
                this.preview = {
                    ...this.preview,
                    pendingAction: undefined,
                    error: errorMessage(error),
                };
                this.deps.onChange();
            }
        }
    }

    public async interruptSubagent(childSessionId: string): Promise<void> {
        const rootSessionId = this.deps.currentRootSession();
        const node = this.selectedSubagent(childSessionId);
        const preview = this.preview;
        if (
            !rootSessionId ||
            !node ||
            node.mode !== "continuable" ||
            !preview ||
            preview.rootSessionId !== rootSessionId ||
            preview.childSessionId !== childSessionId ||
            preview.pendingAction
        ) return;
        const previewGeneration = this.previewGeneration;
        this.preview = { ...preview, pendingAction: "interrupt", error: undefined };
        this.deps.onChange();
        try {
            const result = await this.deps.runtime.interruptSubagent({
                parentSessionId: node.parentSessionId,
                childSessionId,
                mode: "continuable",
            });
            if (result.accepted !== true) {
                throw new Error(t("Harness returned an invalid subagent.interrupt acknowledgement."));
            }
            await this.refreshSubagentTree(rootSessionId);
            await this.settlePreviewAction(rootSessionId, childSessionId, previewGeneration);
        } catch (error) {
            if (this.deps.currentRootSession() === rootSessionId && this.preview?.childSessionId === childSessionId) {
                this.preview = {
                    ...this.preview,
                    pendingAction: undefined,
                    error: errorMessage(error),
                };
                this.deps.onChange();
            }
        }
    }

    public dispose(): void {
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        for (const controller of this.treeAborts.values()) controller.abort();
        this.previewAbort?.abort();
    }
}
