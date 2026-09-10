import { ChildProcess, execFile, spawn, type SpawnOptions } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const owned = new WeakMap<ChildProcess, { pid: number; group?: number; termination?: Promise<void> }>();
const pause = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));

/** Ownership is minted only by this spawn, never reconstructed from a lock or a PID supplied by a peer. */
export function spawnOwnedRuntime(command: string, args: string[], options: SpawnOptions): ChildProcess {
    const group = process.platform !== "win32";
    const child = spawn(command, args, { ...options, detached: group });
    if (child.pid !== undefined) owned.set(child, { pid: child.pid, ...(group ? { group: child.pid } : {}) });
    return child;
}

interface ProcessRow { pid: number; group: number; state: string }

async function processRows(): Promise<ProcessRow[]> {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,pgid=,stat="], {
        timeout: 250, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    });
    return stdout.trim().split("\n").filter(Boolean).map(line => {
        const [pid, group, state] = line.trim().split(/\s+/u);
        if (!/^\d+$/u.test(pid ?? "") || !/^\d+$/u.test(group ?? "") || !state) {
            throw new Error("Cannot verify the owned Runtime process group");
        }
        return { pid: Number(pid), group: Number(group), state };
    });
}

/** Liveness only: this function never signals any process. Failure to inspect means not proven exited. */
export async function processGroupHasExited(groupPid: number): Promise<boolean> {
    if (process.platform === "win32" || !Number.isSafeInteger(groupPid) || groupPid <= 1) return false;
    try { return !(await processRows()).some(row => row.group === groupPid && !row.state.startsWith("Z")); }
    catch { return false; }
}

async function terminateGroup(child: ChildProcess, pid: number): Promise<void> {
    // detached POSIX spawn creates a fresh group whose ID is the child's PID.
    // Revalidate the live leader, if present, before signalling that owned group.
    const rows = await processRows();
    const leader = rows.find(row => row.pid === pid);
    if (leader && leader.group !== pid) throw new Error("Runtime process group ownership changed; refusing shutdown");
    if (leader && !leader.state.startsWith("Z") && (child.exitCode !== null || child.signalCode !== null)) {
        throw new Error("Runtime launcher PID has been reused; refusing shutdown");
    }
    if (!rows.some(row => row.group === pid && !row.state.startsWith("Z"))) return;
    const signal = (value: NodeJS.Signals): void => {
        try { process.kill(-pid, value); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    };
    signal("SIGTERM");
    const gracefulDeadline = Date.now() + 1_200;
    while (Date.now() < gracefulDeadline) {
        if (await processGroupHasExited(pid)) return;
        await pause(50);
    }
    signal("SIGKILL");
    const killDeadline = Date.now() + 500;
    do {
        if (await processGroupHasExited(pid)) return;
        await pause(50);
    } while (Date.now() < killDeadline);
    throw new Error(`Owned Runtime process group ${pid} did not exit within the shutdown deadline`);
}

async function terminateWindowsTree(child: ChildProcess, pid: number): Promise<void> {
    // taskkill scopes /T to this still-live child. Never use an image name or a
    // PID recovered from a stale lock, and never chase a reused root PID.
    if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error("Runtime launcher already exited; descendant ownership cannot be verified on Windows");
    }
    await execFileAsync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        timeout: 2_000, windowsHide: true,
    });
    const deadline = Date.now() + 500;
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await pause(25);
    if (child.exitCode === null && child.signalCode === null) throw new Error("Owned Runtime tree shutdown was not confirmed");
}

/** Bounded and idempotent for each owned launch, including children surviving their launcher. */
export function terminateOwnedRuntime(child: ChildProcess): Promise<void> {
    const ownership = owned.get(child);
    if (!ownership) {
        if (child.pid === undefined) return Promise.resolve(); // spawn failed before creating a process
        return Promise.reject(new Error("Refusing to terminate a Runtime not launched by this extension instance"));
    }
    if (!ownership.termination) {
        ownership.termination = ownership.group === undefined
            ? terminateWindowsTree(child, ownership.pid)
            : terminateGroup(child, ownership.group);
        // A failed cleanup may be retried; a successful one must never signal a reused PID.
        void ownership.termination.catch(() => { ownership.termination = undefined; });
    }
    return ownership.termination;
}

export async function withinShutdownDeadline<T>(operation: Promise<T>, label: string, milliseconds = 2_500): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} exceeded the shutdown deadline`)), milliseconds);
        })]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
}
