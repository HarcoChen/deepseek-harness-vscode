import { FixConflictError, FixExecutor } from "./fixExecutor";
import { RecoveryLedgerStore } from "./ledger";
import { HealthOracle } from "./healthOracle";
import { VariantEngine } from "./variantEngine";
import type {
    Attribution,
    CandidateFix,
    CompositionDescriptor,
    CompositionVariant,
    FailureClass,
    HealthEvidence,
    HealthVerdict,
    RecoveryBudget,
    RecoveryOutcome,
    RecoveryStatusView,
} from "./types";

const SAFE_MAX_BOOTS = 8;

/**
 * Environment/launcher failures that design 7.2 says must terminate the search
 * instead of being attributed to a user bundle.
 */
const TERMINAL_FAILURE_CLASSES = new Set<FailureClass>(["auth", "sandbox-build", "launcher"]);

/**
 * Probe outcomes that prove nothing about the composition: the boot was cancelled,
 * timed out, or the sandbox itself failed. They must not be read as either direction
 * of a two-way confirmation.
 */
const INCONCLUSIVE_VERDICTS = new Set<HealthVerdict>(["cancelled", "timeout", "sandbox-error"]);

export interface RecoverySessionOptions {
    maxBoots?: number;
    allowBundleIsolation?: () => boolean;
    oracle: HealthOracle;
    variants?: VariantEngine;
    ledger: RecoveryLedgerStore;
    fixes: FixExecutor;
    onStatus?: (status: RecoveryStatusView) => void;
    onLog?: (message: string) => void;
}

export class RecoverySession {
    private readonly maxBoots: number;
    private readonly variants: VariantEngine;
    private running: Promise<RecoveryOutcome> | undefined;
    private controller: AbortController | undefined;
    private sessionId: string | undefined;
    private status: RecoveryStatusView | undefined;
    private attribution: Attribution | undefined;

    public constructor(private readonly options: RecoverySessionOptions) {
        this.maxBoots = Math.max(1, Math.min(SAFE_MAX_BOOTS, options.maxBoots ?? SAFE_MAX_BOOTS));
        this.variants = options.variants ?? new VariantEngine();
    }

    public getStatus(): RecoveryStatusView | undefined {
        return this.status ? { ...this.status } : undefined;
    }

    public getSessionId(): string | undefined {
        return this.sessionId;
    }

    public async reconcileHealthyStart(composition: CompositionDescriptor): Promise<void> {
        if (this.running || this.sessionId) return;
        const loaded = await this.options.ledger.read();
        if (loaded.corrupt || !loaded.state.activeSessionId) return;
        const session = loaded.state.sessions.find(item =>
            item.id === loaded.state.activeSessionId && !item.clean,
        );
        if (!session) return;
        const entries = loaded.state.entries.filter(entry => entry.sessionId === session.id);
        if (entries.some(entry => entry.status === "planned")) return;
        try {
            await this.options.ledger.acquireLease();
        } catch {
            return;
        }
        try {
            const current = await this.options.ledger.read();
            if (current.corrupt || current.state.activeSessionId !== session.id) return;
            this.sessionId = session.id;
            this.attribution = session.attribution;
            await this.options.ledger.finishSession(session.id, "recovered", {
                composition,
                attribution: session.attribution,
            });
            this.publish({
                sessionId: session.id,
                phase: "recovered",
                usedBoots: session.budget.usedBoots,
                maxBoots: session.budget.maxBoots,
                summary: "Runtime started successfully; interrupted recovery was closed.",
                canRestore: entries.some(entry =>
                    entry.status === "applied" || entry.status === "verified",
                ),
            });
        } finally {
            this.sessionId = undefined;
            await this.options.ledger.releaseLease().catch(() => undefined);
        }
    }

    public cancel(): void {
        this.controller?.abort(new Error("Recovery was cancelled by the user"));
    }

    public recover(
        composition: CompositionDescriptor,
        failureMessage: string,
        signal?: AbortSignal,
    ): Promise<RecoveryOutcome> {
        if (this.running) return this.running;
        this.sessionId = undefined;
        this.attribution = undefined;
        const controller = new AbortController();
        this.controller = controller;
        const relay = (): void => controller.abort(signal?.reason);
        signal?.addEventListener("abort", relay, { once: true });
        let retainLease = false;
        this.running = this.run(composition, failureMessage, controller.signal)
            .then((outcome) => {
                retainLease = outcome.status === "retry" || outcome.status === "candidate";
                return outcome;
            })
            .finally(() => {
                signal?.removeEventListener("abort", relay);
                if (this.controller === controller) this.controller = undefined;
                this.running = undefined;
                if (!retainLease) {
                    return this.options.ledger.releaseLease().catch((error) =>
                        this.options.onLog?.(`Failed to release recovery lease: ${String(error)}`));
                }
            });
        return this.running;
    }

    public async confirm(
        composition: CompositionDescriptor,
        attribution = this.attribution,
    ): Promise<void> {
        const sessionId = this.sessionId;
        if (!sessionId) return;
        try {
            await this.options.ledger.finishSession(sessionId, "recovered", {
                composition,
                attribution,
            });
            this.publish({
                sessionId,
                phase: "recovered",
                usedBoots: this.status?.usedBoots ?? 0,
                maxBoots: this.maxBoots,
                summary: attribution?.humanSummary ?? "Runtime recovered",
                canRestore: true,
            });
        } finally {
            this.sessionId = undefined;
            await this.options.ledger.releaseLease().catch(() => undefined);
        }
    }

    public async fail(message: string): Promise<void> {
        const sessionId = this.sessionId;
        if (!sessionId) return;
        try {
            await this.options.ledger.finishSession(sessionId, "unrecoverable", {
                attribution: this.attribution,
                error: message,
            });
            this.publish({
                sessionId,
                phase: "unrecoverable",
                usedBoots: this.status?.usedBoots ?? 0,
                maxBoots: this.maxBoots,
                summary: message,
                canRestore: true,
            });
        } finally {
            this.sessionId = undefined;
            await this.options.ledger.releaseLease().catch(() => undefined);
        }
    }

    private async run(
        composition: CompositionDescriptor,
        failureMessage: string,
        signal: AbortSignal,
    ): Promise<RecoveryOutcome> {
        const budget = this.createBudget();
        // Plan before beginSession: the ledger stores a clone of the budget it is given,
        // so the planner's skipped-variant accounting must be complete by then to persist.
        const variants = this.variants.plan(composition, budget);
        try {
            await this.options.ledger.acquireLease();
        } catch (error) {
            return this.unrecoverable("recovery-busy", error instanceof Error ? error.message : String(error));
        }
        let loaded;
        try {
            loaded = await this.options.ledger.read();
        } catch (error) {
            return this.unrecoverable(
                "ledger-unavailable",
                error instanceof Error ? error.message : String(error),
            );
        }
        if (loaded.corrupt) {
            this.options.onLog?.(`Recovery ledger is corrupt; automatic recovery stopped: ${loaded.corrupt.message}`);
            await this.options.ledger.releaseLease().catch(() => undefined);
            return {
                status: "unrecoverable",
                sessionId: "ledger-corrupt",
                message: loaded.corrupt.message,
            };
        }

        let session;
        try {
            session = await this.options.ledger.beginSession(composition, budget, failureMessage);
        } catch (error) {
            await this.options.ledger.releaseLease().catch(() => undefined);
            return this.unrecoverable("ledger-unavailable", error instanceof Error ? error.message : String(error));
        }
        this.sessionId = session.id;
        this.publish({
            sessionId: session.id,
            phase: "detected",
            usedBoots: 0,
            maxBoots: this.maxBoots,
            summary: failureMessage,
            canRestore: false,
        });
        const evidence: import("./types").HealthEvidence[] = [];
        for (const variant of variants) {
            if (signal.aborted) return this.cancelled(session.id);
            if (evidence.length >= this.maxBoots) break;
            this.publish({
                sessionId: session.id,
                phase: "searching",
                usedBoots: evidence.length,
                maxBoots: this.maxBoots,
                currentVariant: variant.id,
                summary: variant.assumption,
                canRestore: false,
            });
            const result = await this.options.oracle.evaluate(composition, variant, {
                sessionId: session.id,
                signal,
            });
            evidence.push(result);
            await this.options.ledger.appendEvidence(session.id, result);
            this.publish({
                sessionId: session.id,
                phase: "searching",
                usedBoots: evidence.length,
                maxBoots: this.maxBoots,
                currentVariant: variant.id,
                summary: `${variant.id}: ${result.verdict}`,
                canRestore: false,
            });
            if (result.cleanup.deferredCleanup) {
                return this.unrecoverable(
                    session.id,
                    "Recovery stopped because process or sandbox cleanup could not be verified.",
                );
            }
            // Design 7.2: an auth / URL / version / sandbox-build failure is an environment
            // problem, not a user bundle. Terminate rather than search, so an environment
            // error can never be misattributed to a bundle and persisted as a profile fix.
            if (variant.kind === "v1-reproduce" && TERMINAL_FAILURE_CLASSES.has(result.failureClass)) {
                return this.unrecoverable(
                    session.id,
                    `Recovery stopped: the original composition failed as ${result.failureClass}, ` +
                    "which is an environment or launcher problem rather than a user bundle.",
                );
            }
            if (variant.kind === "v1-reproduce" && result.verdict !== "healthy" && evidence.length < this.maxBoots) {
                const retryVariant = {
                    ...variant,
                    id: `${variant.id}-retry`,
                };
                const retryResult = await this.options.oracle.evaluate(composition, retryVariant, {
                    sessionId: session.id,
                    signal,
                });
                evidence.push(retryResult);
                await this.options.ledger.appendEvidence(session.id, retryResult);
                if (retryResult.verdict === "healthy") {
                    const attribution = this.variants.explain(retryVariant, evidence);
                    this.attribution = attribution;
                    return {
                        status: "retry",
                        sessionId: session.id,
                        composition,
                        ...(attribution === undefined ? {} : { attribution }),
                        message: "The original composition passed the second recovery health probe.",
                    };
                }
            }
            if (result.verdict !== "healthy") continue;
            const attribution = this.variants.explain(variant, evidence);
            if (attribution) this.attribution = attribution;

            if (variant.kind === "v1-reproduce") {
                return {
                    status: "retry",
                    sessionId: session.id,
                    composition,
                    ...(attribution === undefined ? {} : { attribution }),
                    message: "The original composition passed the recovery health probe.",
                };
            }
            const candidate = variant.candidateFix;
            if (!candidate) continue;
            if (candidate.kind === "disable-profile-bundles") {
                // Design 7.3 step 5 requires both directions: removing the candidate set
                // passes (the healthy variant found above) and re-adding *only* the
                // candidate set fails with a compatible failure class. Without the re-add
                // direction the monotonicity assumption is never falsified, and persisting
                // the fix would edit the user's profile on an unfounded attribution.
                const readd = this.variants.readdConfirmation(composition, candidate.targetIds);
                const confirmation = await this.options.oracle.evaluate(
                    readd.composition,
                    readd,
                    { sessionId: session.id, signal },
                );
                evidence.push(confirmation);
                await this.options.ledger.appendEvidence(session.id, confirmation);
                if (confirmation.cleanup.deferredCleanup) continue;
                // An inconclusive probe must never count as the "re-add fails" direction:
                // a cancelled/timed-out/sandbox-failed boot is not evidence that the bundle
                // is the culprit, and treating it as one would confirm an unfounded attribution.
                if (INCONCLUSIVE_VERDICTS.has(confirmation.verdict)) {
                    this.options.onLog?.(
                        `Re-add confirmation for ${candidate.targetIds.join(", ")} was inconclusive; the attribution is not confirmed.`,
                    );
                    continue;
                }
                const original = evidence.find((item) => item.verdict !== "healthy");
                if (confirmation.verdict === "healthy") {
                    this.options.onLog?.(
                        `Candidate ${candidate.targetIds.join(", ")} stayed healthy when re-added; the attribution is not confirmed.`,
                    );
                    continue;
                }
                if (original && confirmation.failureClass !== original.failureClass) {
                    this.options.onLog?.(
                        `Re-add confirmation failed as ${confirmation.failureClass}, incompatible with the original ${original.failureClass}; the attribution is not confirmed.`,
                    );
                    continue;
                }
            }
            if (
                candidate.kind === "disable-profile-bundles" &&
                this.options.allowBundleIsolation &&
                !this.options.allowBundleIsolation()
            ) {
                this.options.onLog?.("Automatic profile bundle isolation is disabled by configuration.");
                continue;
            }
            const fix = {
                ...candidate,
                evidenceBootIds: [...candidate.evidenceBootIds, result.bootId],
            };
            try {
                await this.options.ledger.planFix(session.id, fix, composition.compositionHash);
                const changed = await this.options.fixes.apply(fix, composition);
                // Design 794-795: before handing the real manifest back to a real start,
                // re-verify in the sandbox that the file we just wrote actually boots. Without
                // this, a bad write is only discovered by a real boot, and that failure path
                // marks the session unrecoverable without ever restoring the original file —
                // leaving the user's profile broken until they run restore by hand.
                // The file has already been written, so record it as applied BEFORE verifying:
                // restore() only reverts entries in the applied/verified state, and marking it
                // after verification would leave a rejected fix as `planned` and therefore
                // unrevertable — the write would silently survive the rollback.
                await this.options.ledger.markFixApplied(session.id, fix.id, changed.compositionHash);
                const verified = await this.verifyAppliedFix(fix, changed);
                if (!verified.ok) {
                    await this.options.fixes.restore();
                    await this.options.ledger.markFixConflict(session.id, fix.id, verified.reason);
                    this.options.onLog?.(`Recovery fix was rolled back: ${verified.reason}`);
                    continue;
                }
                this.publish({
                    sessionId: session.id,
                    phase: "fix-applied",
                    usedBoots: evidence.length,
                    maxBoots: this.maxBoots,
                    currentVariant: variant.id,
                    summary: attribution?.humanSummary ?? fix.reason,
                    canRestore: true,
                });
                return {
                    status: "candidate",
                    sessionId: session.id,
                    composition: changed,
                    fix,
                    ...(attribution === undefined ? {} : { attribution }),
                    message: fix.reason,
                };
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                await this.options.ledger.markFixConflict(session.id, fix.id, message);
                if (error instanceof FixConflictError) {
                    this.options.onLog?.(`Recovery fix was rejected: ${message}`);
                } else {
                    this.options.onLog?.(`Recovery fix failed: ${message}`);
                }
            }
        }
        const message = signal.aborted
            ? "Recovery was cancelled"
            : `Recovery exhausted its ${this.maxBoots}-boot budget without a verified fix.`;
        return signal.aborted ? this.cancelled(session.id) : this.unrecoverable(session.id, message);
    }

    private createBudget(): RecoveryBudget {
        return {
            maxBoots: this.maxBoots,
            usedBoots: 0,
            // Design 7.1: V1 and V4 are single shots, confirmation is one more, and V3 gets
            // `1 + ceil(log2(n)) + 1` — the all-removed baseline, the bisection steps and the
            // re-add confirmation. The V3 figure depends on the user's bundle count, so the
            // planner computes it once it knows n (see VariantEngine.plan).
            reserved: { v1: 1, v3: 0, v4: 1, confirmation: 1 },
            skipped: [],
        };
    }

    private async cancelled(sessionId: string): Promise<RecoveryOutcome> {
        await this.options.ledger.finishSession(sessionId, "cancelled", {
            attribution: this.attribution,
            error: "Recovery was cancelled",
        });
        this.publish({
            sessionId,
            phase: "cancelled",
            usedBoots: this.status?.usedBoots ?? 0,
            maxBoots: this.maxBoots,
            summary: "Recovery was cancelled",
            canRestore: true,
        });
        return { status: "cancelled", sessionId, message: "Recovery was cancelled" };
    }

    private async unrecoverable(sessionId: string, message: string): Promise<RecoveryOutcome> {
        if (
            sessionId !== "ledger-unavailable" &&
            sessionId !== "composition-unavailable" &&
            sessionId !== "recovery-busy"
        ) {
            try {
                await this.options.ledger.finishSession(sessionId, "unrecoverable", {
                    attribution: this.attribution,
                    error: message,
                });
            } catch (error) {
                this.options.onLog?.(`Failed to finalize recovery ledger: ${String(error)}`);
            }
        }
        this.publish({
            sessionId,
            phase: "unrecoverable",
            usedBoots: this.status?.usedBoots ?? 0,
            maxBoots: this.maxBoots,
            summary: message,
            canRestore: true,
        });
        return {
            status: "unrecoverable",
            sessionId,
            ...(this.attribution === undefined ? {} : { attribution: this.attribution }),
            message,
        };
    }

    /**
     * Design 794-795: after `apply` rewrites the real profile manifest, boot the changed
     * composition in the sandbox before any real start. A failure here means the write we just
     * made is not bootable, so the caller rolls it back instead of leaving the user's profile
     * broken. Returns a reason rather than throwing so the caller keeps the ledger in charge.
     */
    private async verifyAppliedFix(
        fix: CandidateFix,
        changed: CompositionDescriptor,
    ): Promise<{ ok: true; } | { ok: false; reason: string; }> {
        const variant: CompositionVariant = {
            id: `${fix.id}-verify`,
            kind: "v3-bundle-singleton",
            parentHash: changed.compositionHash,
            assumption: "Re-verify the profile manifest written by this fix in the sandbox.",
            bundleSelection: changed.bundles.filter((bundle) => bundle.selected).map((bundle) => bundle.packageName),
            composition: changed,
        };
        const canary = await this.options.oracle.evaluate(changed, variant, { sessionId: this.status?.sessionId ?? "" });
        if (canary.cleanup.deferredCleanup) {
            return { ok: false, reason: "Sandbox cleanup could not be verified after writing the profile manifest." };
        }
        if (canary.verdict !== "healthy") {
            return { ok: false, reason: `The manifest written by this fix does not boot: ${canary.failureClass ?? "unknown failure"}.` };
        }
        return { ok: true };
    }
    private publish(status: RecoveryStatusView): void {
        this.status = { ...status };
        this.options.onStatus?.({ ...status });
    }
}
