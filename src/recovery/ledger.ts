import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { mutateRuntimeLock, processHasExited, readRuntimeLock, removeRuntimeLock } from "../runtimeLock";
import type {
    CandidateFix,
    CompositionDescriptor,
    HealthEvidence,
    RecoveryBudget,
    RecoveryLedgerSession,
    RecoveryLedgerState,
} from "./types";

const EMPTY_LEDGER: RecoveryLedgerState = {
    schemaVersion: 1,
    revision: 0,
    clean: true,
    sessions: [],
    entries: [],
};

export class RecoveryLedgerCorruptError extends Error {
    public constructor(
        public readonly path: string,
        message: string,
    ) {
        super(message);
        this.name = "RecoveryLedgerCorruptError";
    }
}

export interface LedgerReadResult {
    state: RecoveryLedgerState;
    exists: boolean;
    corrupt?: RecoveryLedgerCorruptError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validLedger(value: unknown): value is RecoveryLedgerState {
    if (!isRecord(value) ||
        value.schemaVersion !== 1 ||
        typeof value.revision !== "number" ||
        !Number.isSafeInteger(value.revision) ||
        value.revision < 0 ||
        typeof value.clean !== "boolean" ||
        !Array.isArray(value.sessions) ||
        !Array.isArray(value.entries)) {
        return false;
    }
    if (value.activeSessionId !== undefined && typeof value.activeSessionId !== "string") return false;
    return value.sessions.every(session => isRecord(session) &&
        typeof session.id === "string" && typeof session.compositionHash === "string" &&
        typeof session.clean === "boolean" &&
        ["detected", "searching", "fix-applied", "recovered", "unrecoverable", "cancelled"].includes(String(session.phase)) &&
        isRecord(session.budget) && Number.isInteger(session.budget.usedBoots) &&
        Number.isInteger(session.budget.maxBoots) && Array.isArray(session.evidence) &&
        session.evidence.every(item => isRecord(item) && typeof item.variantId === "string" &&
            typeof item.verdict === "string" && isRecord(item.cleanup))) &&
        value.entries.every(entry => isRecord(entry) && typeof entry.id === "string" &&
            typeof entry.sessionId === "string" && typeof entry.status === "string" &&
            isRecord(entry.fix) && typeof entry.fix.kind === "string" &&
            Array.isArray(entry.fix.targetIds));
}

function cloneState(state: RecoveryLedgerState): RecoveryLedgerState {
    return JSON.parse(JSON.stringify(state)) as RecoveryLedgerState;
}

export class RecoveryLedgerStore {
    public readonly directory: string;
    public readonly path: string;
    private readonly leasePath: string;
    private leaseOwner?: string;

    public constructor(storagePath: string) {
        this.directory = join(storagePath, "recovery");
        this.path = join(this.directory, "ledger.json");
        this.leasePath = join(this.directory, "session.lease");
    }

    public async acquireLease(): Promise<void> {
        await mkdir(this.directory, { recursive: true });
        await mutateRuntimeLock(this.leasePath, async () => {
            const current = await readRuntimeLock(this.leasePath);
            // This window may already own the lease (a recovery session can retain it
            // while a restore is requested); re-acquiring must not look like contention.
            if (current?.record?.ownerId !== undefined && current.record.ownerId === this.leaseOwner) return;
            if (current) {
                if (!current.record || !processHasExited(current.record.pid) || !await removeRuntimeLock(current)) {
                    throw new Error("Another recovery or restore owns the recovery lease; retry after it finishes.");
                }
            }
            const ownerId = randomUUID();
            await writeFile(this.leasePath, JSON.stringify({ pid: process.pid, ownerId }), { flag: "wx", mode: 0o600 });
            this.leaseOwner = ownerId;
        });
    }

    public async releaseLease(): Promise<void> {
        const ownerId = this.leaseOwner;
        if (!ownerId) return;
        await mutateRuntimeLock(this.leasePath, async () => {
            const current = await readRuntimeLock(this.leasePath);
            if (current?.record?.ownerId === ownerId) await removeRuntimeLock(current);
        });
        this.leaseOwner = undefined;
    }

    public async assertLease(): Promise<void> {
        if (!this.leaseOwner || (await readRuntimeLock(this.leasePath))?.record?.ownerId !== this.leaseOwner) {
            throw new Error("Recovery lease ownership changed");
        }
    }

    public async read(): Promise<LedgerReadResult> {
        try {
            const contents = await readFile(this.path, "utf8");
            let parsed: unknown;
            try {
                parsed = JSON.parse(contents);
            } catch (error) {
                const corrupt = new RecoveryLedgerCorruptError(
                    this.path,
                    `Recovery ledger JSON is invalid: ${error instanceof Error ? error.message : String(error)}`,
                );
                return { state: cloneState(EMPTY_LEDGER), exists: true, corrupt };
            }
            if (!validLedger(parsed)) {
                const corrupt = new RecoveryLedgerCorruptError(
                    this.path,
                    "Recovery ledger schema is invalid",
                );
                return { state: cloneState(EMPTY_LEDGER), exists: true, corrupt };
            }
            return { state: cloneState(parsed), exists: true };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return { state: cloneState(EMPTY_LEDGER), exists: false };
            }
            throw error;
        }
    }

    public async update(
        mutator: (state: RecoveryLedgerState) => RecoveryLedgerState | void,
        expectedRevision?: number,
    ): Promise<RecoveryLedgerState> {
        return this.withMutation(async () => {
            const loaded = await this.read();
            if (loaded.corrupt) throw loaded.corrupt;
            if (expectedRevision !== undefined && loaded.state.revision !== expectedRevision) {
                throw new Error(
                    `Recovery ledger revision changed from ${expectedRevision} to ${loaded.state.revision}`,
                );
            }
            const next = cloneState(loaded.state);
            const returned = mutator(next);
            const updated = returned ? cloneState(returned) : next;
            updated.schemaVersion = 1;
            updated.revision = loaded.state.revision + 1;
            await this.writeUnlocked(updated);
            return updated;
        });
    }

    public async readEntries(): Promise<RecoveryLedgerState["entries"]> {
        const loaded = await this.read();
        if (loaded.corrupt) throw loaded.corrupt;
        return loaded.state.entries;
    }

    public async beginSession(
        composition: CompositionDescriptor,
        budget: RecoveryBudget,
        error?: string,
    ): Promise<RecoveryLedgerSession> {
        const id = randomUUID();
        const session: RecoveryLedgerSession = {
            id,
            startedAt: new Date().toISOString(),
            clean: false,
            phase: "detected",
            compositionHash: composition.compositionHash,
            budget,
            evidence: [],
            ...(error === undefined ? {} : { error }),
        };
        const loaded = await this.read();
        if (loaded.corrupt) throw loaded.corrupt;
        const unfinished = loaded.state.sessions.find(item => item.id === loaded.state.activeSessionId && !item.clean);
        if (unfinished) {
            const entries = loaded.state.entries.filter(entry => entry.sessionId === unfinished.id);
            const applied = entries.some(entry => entry.status === "applied" || entry.status === "verified");
            if (!entries.some(entry => entry.status === "planned") &&
                (applied || (unfinished.compositionHash === composition.compositionHash &&
                    entries.every(entry => entry.status === "reverted")))) {
                return unfinished;
            }
        }
        if (unfinished) throw new Error("Interrupted recovery has an unresolved file change or changed composition; inspect or restore it before retrying.");
        await this.update((state) => {
            state.clean = false;
            state.activeSessionId = id;
            state.sessions.push(session);
        }, loaded.state.revision);
        return session;
    }

    public async appendEvidence(
        sessionId: string,
        evidence: HealthEvidence,
    ): Promise<void> {
        await this.update((state) => {
            const session = state.sessions.find((candidate) => candidate.id === sessionId);
            if (!session) throw new Error(`Recovery session ${sessionId} does not exist`);
            session.phase = "searching";
            session.evidence.push(evidence);
            session.budget.usedBoots = Math.max(session.budget.usedBoots, session.evidence.length);
        });
    }

    public async planFix(
        sessionId: string,
        fix: CandidateFix,
        beforeCompositionHash: string,
    ): Promise<void> {
        await this.update((state) => {
            if (state.activeSessionId !== sessionId) throw new Error("Recovery session ownership changed");
            state.entries.push({
                id: fix.id,
                sessionId,
                status: "planned",
                fix,
                plannedAt: new Date().toISOString(),
                beforeCompositionHash,
            });
            const session = state.sessions.find((candidate) => candidate.id === sessionId);
            if (session) session.phase = "searching";
        });
    }

    public async markFixApplied(
        sessionId: string,
        fixId: string,
        afterCompositionHash?: string,
    ): Promise<void> {
        await this.update((state) => {
            const entry = state.entries.find((candidate) =>
                candidate.sessionId === sessionId && candidate.id === fixId,
            );
            if (!entry) throw new Error(`Recovery fix ${fixId} does not exist`);
            entry.status = "applied";
            entry.appliedAt = new Date().toISOString();
            if (afterCompositionHash !== undefined) entry.afterCompositionHash = afterCompositionHash;
            const session = state.sessions.find((candidate) => candidate.id === sessionId);
            if (session) session.phase = "fix-applied";
        });
    }

    public async finishSession(
        sessionId: string,
        phase: RecoveryLedgerSession["phase"],
        options: {
            composition?: CompositionDescriptor;
            attribution?: RecoveryLedgerSession["attribution"];
            error?: string;
        } = {},
    ): Promise<void> {
        await this.update((state) => {
            const session = state.sessions.find((candidate) => candidate.id === sessionId);
            if (!session) throw new Error(`Recovery session ${sessionId} does not exist`);
            session.phase = phase;
            session.clean = phase === "recovered" || phase === "cancelled" || phase === "unrecoverable";
            session.finishedAt = new Date().toISOString();
            if (options.attribution !== undefined) session.attribution = options.attribution;
            if (options.error !== undefined) session.error = options.error;
            const active = state.activeSessionId === sessionId;
            if (active) {
                state.clean = session.clean;
                delete state.activeSessionId;
            }
            if (phase === "recovered" && options.composition) {
                state.lastKnownGood = options.composition;
            }
            for (const entry of state.entries) {
                if (entry.sessionId !== sessionId) continue;
                if (entry.status === "applied" && phase === "recovered") {
                    entry.status = "verified";
                    entry.verifiedAt = new Date().toISOString();
                } else if (entry.status === "planned" && phase !== "recovered") {
                    entry.status = "conflicted";
                    entry.note = "Recovery session ended before this fix was applied.";
                }
            }
        });
    }

    public async markFixConflict(sessionId: string, fixId: string, note: string): Promise<void> {
        await this.update((state) => {
            const entry = state.entries.find((candidate) =>
                candidate.sessionId === sessionId && candidate.id === fixId,
            );
            if (!entry) return;
            entry.status = "conflicted";
            entry.note = note;
        });
    }

    public async restoreEntry(
        fixId: string,
        status: "reverted" | "conflicted" = "reverted",
        note?: string,
    ): Promise<void> {
        await this.update((state) => {
            const entry = [...state.entries].reverse().find((candidate) => candidate.id === fixId);
            if (!entry) throw new Error(`Recovery fix ${fixId} does not exist`);
            entry.status = status;
            entry.revertedAt = new Date().toISOString();
            if (note !== undefined) entry.note = note;
        });
    }

    private async writeUnlocked(state: RecoveryLedgerState): Promise<void> {
        await atomicWrite(this.path, `${JSON.stringify(state, null, 2)}\n`);
    }

    private async withMutation<T>(action: () => Promise<T>): Promise<T> {
        await mkdir(this.directory, { recursive: true });
        return mutateRuntimeLock(this.path, action);
    }
}

/** Bounded retry budget for a Windows sharing violation on the atomic rename. */
const ATOMIC_WRITE_RETRIES = 5;
const ATOMIC_WRITE_RETRY_MS = 50;
const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

export async function atomicWrite(path: string, contents: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporary, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
        await renameWithRetry(temporary, path);
    } finally {
        await rm(temporary, { force: true });
    }
}

/**
 * `rename` is atomic, but on Windows it fails with EPERM/EACCES/EBUSY while another
 * process holds the destination open (an editor, an indexer, a concurrent reader).
 * Those are transient sharing violations, not corruption: retry briefly before failing
 * closed, so a momentary lock cannot be reported as a broken ledger.
 */
async function renameWithRetry(source: string, target: string): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
        try {
            await rename(source, target);
            return;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code ?? "";
            if (attempt >= ATOMIC_WRITE_RETRIES || !RETRYABLE_RENAME_CODES.has(code)) throw error;
            await new Promise((resolve) => { setTimeout(resolve, ATOMIC_WRITE_RETRY_MS); });
        }
    }
}
