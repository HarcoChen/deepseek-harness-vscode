import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { lstat, open, readFile, unlink } from "node:fs/promises";
import type { Stats } from "node:fs";
import { t } from "./localize";
import { processGroupHasExited } from "./runtimeProcess";

/** `pid` remains the editor PID for peers using the original shared-lock format. */
export interface RuntimeLockRecord {
    pid: number;
    createdAt?: number;
    ownerId?: string;
    runtimeVersion?: string;
    /** Spawned launcher PID; pnpm/npx may have a surviving server descendant. */
    runtimePid?: number;
    runtimeProcess?: "direct" | "wrapper";
    /** POSIX group owned by this launch, never the editor's process group. */
    runtimeProcessGroup?: number;
    /** Composition evidence for recovery and orphan diagnosis. */
    compositionHash?: string;
    recoverySessionId?: string;
    url?: string;
    launchUrl?: string;
}

export interface RuntimeLockSnapshot {
    path: string;
    stat: Stats;
    contents: string;
    record?: RuntimeLockRecord;
}

export function validPid(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function exactRuntimeVersion(value: unknown): value is string {
    return typeof value === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(value);
}

/** Only ESRCH proves absence. Access-denied and unknown errors never authorize cleanup. */
export function processHasExited(pid: number): boolean {
    try { process.kill(pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

export async function readRuntimeLock(path: string): Promise<RuntimeLockSnapshot | undefined> {
    try {
        const stat = await lstat(path);
        // Do not follow a substituted lock symlink or treat it as available.
        if (!stat.isFile()) return { path, stat, contents: "" };
        const contents = await readFile(path, "utf8");
        let record: RuntimeLockRecord | undefined;
        try {
            const value: unknown = JSON.parse(contents);
            if (typeof value === "object" && value !== null && !Array.isArray(value)) {
                const raw = value as Record<string, unknown>;
                if (validPid(raw.pid) &&
                    (raw.runtimePid === undefined || validPid(raw.runtimePid)) &&
                    (raw.runtimeProcess === undefined || raw.runtimeProcess === "direct" || raw.runtimeProcess === "wrapper") &&
                    (raw.runtimeProcessGroup === undefined || (validPid(raw.runtimeProcessGroup) && raw.runtimeProcessGroup === raw.runtimePid)) &&
                    (raw.runtimeVersion === undefined || exactRuntimeVersion(raw.runtimeVersion)) &&
                    (raw.ownerId === undefined || (typeof raw.ownerId === "string" && raw.ownerId.length > 0)) &&
                    (raw.compositionHash === undefined || (typeof raw.compositionHash === "string" && /^[a-f0-9]{64}$/u.test(raw.compositionHash))) &&
                    (raw.recoverySessionId === undefined || (typeof raw.recoverySessionId === "string" && raw.recoverySessionId.length > 0)) &&
                    (raw.url === undefined || typeof raw.url === "string") &&
                    (raw.launchUrl === undefined || typeof raw.launchUrl === "string")) record = raw as unknown as RuntimeLockRecord;
            }
        } catch { /* A partial write or corrupt lock is occupied, not stale. */ }
        return { path, stat, contents, record };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    }
}

/** An explicitly refused local TCP connection, not HTTP/auth failure or a timeout. */
async function listenerHasExited(address: string): Promise<boolean> {
    let url: URL;
    try { url = new URL(address); } catch { return false; }
    if (url.protocol !== "http:" || !url.port || url.username || url.password ||
        !["127.0.0.1", "localhost", "0.0.0.0", "[::1]"].includes(url.hostname)) return false;
    // A localhost alias may resolve differently across processes. Refuse to reclaim on that ambiguity.
    if (url.hostname === "localhost") return false;
    const host = url.hostname === "[::1]" ? "::1" : url.hostname === "0.0.0.0" ? "127.0.0.1" : url.hostname;
    return new Promise(resolve => {
        const socket = createConnection({ host, port: Number(url.port) });
        const finish = (exited: boolean): void => { socket.destroy(); resolve(exited); };
        socket.setTimeout(1_000, () => finish(false));
        socket.once("connect", () => finish(false));
        socket.once("error", error => finish((error as NodeJS.ErrnoException).code === "ECONNREFUSED"));
    });
}

export async function runtimeHasExited(record: RuntimeLockRecord): Promise<boolean> {
    if (record.runtimeProcessGroup !== undefined) {
        if (!await processGroupHasExited(record.runtimeProcessGroup)) return false;
    } else if (record.runtimePid !== undefined && !processHasExited(record.runtimePid)) return false;
    const address = record.url ?? record.launchUrl;
    if (!address) return record.runtimeProcessGroup !== undefined ||
        (record.runtimePid !== undefined && record.runtimeProcess === "direct");
    if (record.url && record.launchUrl) {
        try { if (new URL(record.url).origin !== new URL(record.launchUrl).origin) return false; }
        catch { return false; }
    }
    // An old lock has no Runtime PID, but its published listener is still usable
    // liveness evidence. canReclaim also requires the original editor to be dead.
    return listenerHasExited(address);
}

export async function canReclaimRuntimeLock(snapshot: RuntimeLockSnapshot): Promise<boolean> {
    const record = snapshot.record;
    return record !== undefined && processHasExited(record.pid) && await runtimeHasExited(record);
}

export function sameRuntimeLockFile(left: Stats, right: Stats): boolean {
    return left.dev === right.dev && left.ino === right.ino && right.isFile();
}

/**
 * Serialize create/publish/reclaim/release across updated editors. Identity checks
 * alone cannot prevent two stale readers from unlinking each other's replacement.
 * A crashed mutation is deliberately fail-closed: never recursively reclaim a
 * mutex using the same racy check-and-unlink operation it exists to protect.
 */
export async function mutateRuntimeLock<T>(path: string, action: () => Promise<T>): Promise<T> {
    const guardPath = `${path}.mutation`;
    const deadline = Date.now() + 2_000;
    let guard;
    while (!guard) {
        try { guard = await open(guardPath, "wx", 0o600); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            if (Date.now() >= deadline) {
                throw new Error(t("DSH Runtime lock mutation is busy or abandoned: {path}. Retry; if it persists, verify its owner has exited before manual cleanup.", { path: guardPath }));
            }
            await new Promise(resolve => setTimeout(resolve, 25));
        }
    }
    const contents = JSON.stringify({ pid: process.pid, createdAt: Date.now(), ownerId: randomUUID() });
    try {
        await guard.writeFile(contents, "utf8");
        return await action();
    } finally {
        const stat = await guard.stat();
        await guard.close();
        const current = await readRuntimeLock(guardPath);
        if (current && current.contents === contents && sameRuntimeLockFile(stat, current.stat)) await removeRuntimeLock(current);
    }
}

/** Check both file identity and contents after async liveness probes before unlinking. */
export async function removeRuntimeLock(snapshot: RuntimeLockSnapshot): Promise<boolean> {
    const current = await readRuntimeLock(snapshot.path);
    if (!current || !sameRuntimeLockFile(snapshot.stat, current.stat) || current.contents !== snapshot.contents) return false;
    try { await unlink(snapshot.path); return true; }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
}
