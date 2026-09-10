import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RemoteProtocolError } from "./remote/errors";
import {
    mutateRuntimeLock, processHasExited, readRuntimeLock, removeRuntimeLock,
    runtimeHasExited, sameRuntimeLockFile, type RuntimeLockSnapshot,
} from "./runtimeLock";
import { t } from "./localize";

const exec = promisify(execFile);

export class RuntimeMigrationRequiredError extends RemoteProtocolError {
    public constructor(public readonly snapshot: RuntimeLockSnapshot, expectedVersion: string) {
        super(t("The shared DSH Runtime is {actual}; this extension requires {expected}. Upgrade the existing Runtime before reconnecting.", {
            actual: snapshot.record?.runtimeVersion ?? t("unversioned (legacy lock)"), expected: expectedVersion,
        }));
    }
}

export interface LegacyRuntimeIdentity {
    pid: number;
    /** Birth time and command line, used only for identity checks; never shown in diagnostics. */
    signature: string;
    baseUrl: string;
}

function migrationUrl(snapshot: RuntimeLockSnapshot): URL | undefined {
    try {
        const url = new URL(snapshot.record?.url ?? snapshot.record?.launchUrl ?? "");
        if (url.protocol !== "http:" || !url.port || url.username || url.password || url.hash ||
            url.pathname !== "/" || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)) return undefined;
        return url;
    } catch { return undefined; }
}

async function listenerIdentity(port: number): Promise<{ pid: number; signature: string; command: string } | undefined> {
    try {
        if (process.platform === "win32") {
            // The only interpolation is an integer port parsed from a validated local URL.
            const script = `$pids = @(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique); if ($pids.Count -ne 1) { exit 2 }; $p = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $pids[0]); @{pid=$p.ProcessId; command=$p.CommandLine; born=$p.CreationDate.ToString("o")} | ConvertTo-Json -Compress`;
            const { stdout } = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 3_000, windowsHide: true });
            const value = JSON.parse(stdout) as { pid?: unknown; command?: unknown; born?: unknown };
            if (!Number.isSafeInteger(value.pid) || Number(value.pid) <= 0 || typeof value.command !== "string" || typeof value.born !== "string") return undefined;
            return { pid: Number(value.pid), command: value.command, signature: `${value.born}\n${value.command}` };
        }
        const { stdout } = await exec("lsof", ["-nP", "-a", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], { timeout: 2_000 });
        const pids = [...new Set(stdout.split("\n").filter(line => /^p\d+$/u.test(line)).map(line => Number(line.slice(1))))];
        if (pids.length !== 1 || pids[0] <= 0) return undefined;
        const { stdout: signature } = await exec("ps", ["-p", String(pids[0]), "-o", "lstart=,args="], { timeout: 2_000 });
        const { stdout: command } = await exec("ps", ["-p", String(pids[0]), "-o", "args="], { timeout: 2_000 });
        return { pid: pids[0], signature: signature.trim(), command: command.trim() };
    } catch { return undefined; }
}

/** Recovery is offered only for an orphan with a positively identified DSH npm entrypoint. */
export async function inspectLegacyRuntime(snapshot: RuntimeLockSnapshot): Promise<LegacyRuntimeIdentity | undefined> {
    if (!snapshot.record || !processHasExited(snapshot.record.pid)) return undefined;
    const url = migrationUrl(snapshot);
    if (!url) return undefined;
    const candidate = await listenerIdentity(Number(url.port));
    if (!candidate || candidate.pid === process.pid) return undefined;
    // Validate the executable entrypoint, not a later prompt/argument merely containing the package name.
    const command = candidate.command.replace(/\\/gu, "/");
    if (!/^(?:"[^"]*\/node(?:\.exe)?"|\S*\bnode(?:\.exe)?)\s+(?:"[^"\r\n]*\/@deepseek-ai\/dsh\/lib\/bin\.js"|[^\s"\r\n]*\/@deepseek-ai\/dsh\/lib\/bin\.js)(?:\s|$)/u.test(command)) return undefined;
    return { pid: candidate.pid, signature: candidate.signature, baseUrl: url.origin };
}

/** Called only after the user confirms the specific PID/address in a modal dialog. */
export async function stopLegacyRuntime(snapshot: RuntimeLockSnapshot, approved: LegacyRuntimeIdentity, sharedLockPath: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await mutateRuntimeLock(sharedLockPath, async () => {
        signal?.throwIfAborted();
        const current = await readRuntimeLock(snapshot.path);
        if (!current || !sameRuntimeLockFile(snapshot.stat, current.stat) || current.contents !== snapshot.contents) {
            throw new Error(t("The Runtime lock changed while awaiting confirmation. Retry without stopping any process."));
        }
        const actual = await inspectLegacyRuntime(current);
        if (!actual || actual.pid !== approved.pid || actual.signature !== approved.signature || actual.baseUrl !== approved.baseUrl) {
            throw new Error(t("The old Runtime process changed or its owner is still alive. No process was stopped."));
        }
        signal?.throwIfAborted();
        process.kill(actual.pid, "SIGTERM");
        const deadline = Date.now() + 3_000;
        while (Date.now() < deadline && (!processHasExited(actual.pid) || !await runtimeHasExited(current.record!))) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        if (!processHasExited(actual.pid) || !await runtimeHasExited(current.record!)) {
            throw new Error(t("The old Runtime did not finish shutting down. Its lock was retained; no forced termination was attempted."));
        }
        if (!await removeRuntimeLock(current)) {
            throw new Error(t("The Runtime stopped, but its lock changed. Retry to inspect the current lock."));
        }
    });
}
