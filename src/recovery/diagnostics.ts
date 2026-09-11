import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { compositionDiff } from "./composition";
import type {
    CompositionDescriptor,
    RecoveryBootLog,
    RecoveryLedgerState,
} from "./types";

const MAX_BOOT_BYTES = 240 * 1024;
const MIN_TAIL_BYTES = 32 * 1024;

export function redactRecoveryText(value: string): string {
    return value
        .replace(/([?&](?:token|access_token|auth|api_key|apikey|secret|password)=)[^&\s"<>]+/giu, "$1<redacted>")
        .replace(/((?:authorization|proxy-authorization|cookie|set-cookie)\s*:\s*)([^\r\n]+)/giu, "$1<redacted>")
        .replace(/((?:[\w-]*(?:api[-_]?key|secret|password|credential|token))["']?\s*[=:]\s*)[^\r\n]+/giu, "$1<redacted>")
        .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu, "Bearer <redacted>")
        .replace(/\b(?:sk|key|token|secret|password)[-_]?[A-Za-z0-9]{16,}\b/giu, "<redacted>");
}

/** Sanitize strings before JSON encoding, so redaction cannot corrupt the document. */
export function diagnosticValue(value: unknown, key = ""): unknown {
    if (typeof value === "string") return redactRecoveryText(value);
    if (Array.isArray(value)) {
        return value.map((item, index) =>
            /args$/iu.test(key) && index > 0 && typeof value[index - 1] === "string" &&
            /^--?[\w-]*(?:token|secret|password|api[-_]?key)$/iu.test(value[index - 1])
                ? "<redacted>" : diagnosticValue(item));
    }
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([name, item]) => [
            name, /^(?:token|cookie|authorization|password|apiKey|secret)$/iu.test(name)
                ? "<redacted>" : diagnosticValue(item, name),
        ]));
    }
    return value;
}

function textBytes(value: string): number {
    return Buffer.byteLength(value, "utf8");
}

function keepBounded(value: string): { value: string; truncated: boolean } {
    if (textBytes(value) <= MAX_BOOT_BYTES) {
        return { value, truncated: false };
    }
    const bytes = Buffer.from(value, "utf8");
    const head = bytes.subarray(0, 32 * 1024).toString("utf8");
    const tail = bytes.subarray(-Math.max(MIN_TAIL_BYTES, MAX_BOOT_BYTES - textBytes(head) - 256)).toString("utf8");
    return {
        value: `${head}\n[recovery log truncated]\n${tail}`,
        truncated: true,
    };
}

export class RecoveryDiagnostics {
    public readonly directory: string;
    public readonly logsDirectory: string;
    public readonly exportsDirectory: string;

    public constructor(storagePath: string) {
        this.directory = join(storagePath, "recovery");
        this.logsDirectory = join(this.directory, "logs");
        this.exportsDirectory = join(this.directory, "diagnostics");
    }

    public async beginBoot(
        sessionId: string,
        variantId: string,
        compositionHash: string,
        bootId = randomUUID(),
    ): Promise<RecoveryBootLog> {
        if (!/^[a-zA-Z0-9-]+$/u.test(sessionId) || !/^[a-zA-Z0-9-]+$/u.test(bootId)) {
            throw new Error("Invalid recovery log identity");
        }
        const directory = join(this.logsDirectory, sessionId);
        const path = join(directory, `${bootId}.log`);
        await mkdir(directory, { recursive: true });
        await this.rotate(sessionId);
        let contents = [
            `bootId=${bootId}`,
            `sessionId=${sessionId}`,
            `variantId=${variantId}`,
            `compositionHash=${compositionHash}`,
            `startedAt=${new Date().toISOString()}`,
            "",
        ].join("\n");
        let truncated = false;
        await writeFile(path, contents, { encoding: "utf8", mode: 0o600 });
        return {
            path,
            append: async (stream, text) => {
                const safe = redactRecoveryText(text);
                const line = `[${stream}] ${safe}\n`;
                const next = keepBounded(`${contents}${line}`);
                contents = next.value;
                // Persist incrementally: if the extension dies during the boot, finish()
                // never runs and the crash evidence must already be on disk (design 46, 466).
                if (next.truncated) {
                    truncated = true;
                    await writeFile(path, contents, { encoding: "utf8", mode: 0o600 });
                } else {
                    await appendFile(path, line, { encoding: "utf8", mode: 0o600 });
                }
            },
            finish: async (summary) => {
                const tail = redactRecoveryText(summary.outputTail);
                const summaryText = [
                    "",
                    "summary:",
                    JSON.stringify(diagnosticValue({
                        bootId: summary.bootId,
                        verdict: summary.verdict,
                        failureClass: summary.failureClass,
                        finishedAt: summary.finishedAt,
                        durationMs: summary.durationMs,
                        process: summary.process,
                        endpoint: summary.endpoint,
                        cleanup: summary.cleanup,
                        classifierNotes: summary.classifierNotes,
                        outputTail: tail,
                        outputTruncated: summary.outputTruncated || truncated,
                    })),
                    "",
                ].join("\n");
                const next = keepBounded(`${contents}${summaryText}`);
                await writeFile(path, next.value, { encoding: "utf8", mode: 0o600 });
            },
        };
    }

    public async export(
        ledger: RecoveryLedgerState,
        current?: CompositionDescriptor,
        corrupt?: { path: string; message: string },
    ): Promise<string> {
        const exportId = `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`;
        const target = join(this.exportsDirectory, exportId);
        await mkdir(join(target, "logs"), { recursive: true });
        await writeFile(
            join(target, "manifest.json"),
            `${JSON.stringify({
                schemaVersion: 1,
                generatedAt: new Date().toISOString(),
                sessionId: ledger.activeSessionId,
                revision: ledger.revision,
            }, null, 2)}\n`,
            { encoding: "utf8", mode: 0o600 },
        );
        await writeFile(join(target, "ledger.json"), `${JSON.stringify(diagnosticValue(ledger), null, 2)}\n`, {
            encoding: "utf8",
            mode: 0o600,
        });
        await writeFile(join(target, "composition-current.json"), `${JSON.stringify(diagnosticValue(current ?? null), null, 2)}\n`, {
            encoding: "utf8",
            mode: 0o600,
        });
        await writeFile(
            join(target, "composition-last-known-good.json"),
            `${JSON.stringify(diagnosticValue(ledger.lastKnownGood ?? null), null, 2)}\n`,
            { encoding: "utf8", mode: 0o600 },
        );
        await writeFile(
            join(target, "composition-diff.json"),
            `${JSON.stringify(diagnosticValue(compositionDiff(current, ledger.lastKnownGood)), null, 2)}\n`,
            { encoding: "utf8", mode: 0o600 },
        );
        await writeFile(join(target, "conclusion.txt"), redactRecoveryText(corrupt?.message ??
            ledger.sessions.at(-1)?.error ?? ledger.sessions.at(-1)?.attribution?.humanSummary ?? "No recovery recorded."),
            { encoding: "utf8", mode: 0o600 });
        if (corrupt) {
            // The damaged original stays in place; exporting it verbatim could expose credentials.
            await writeFile(join(target, "ledger-corrupt.txt"), redactRecoveryText(await readFile(corrupt.path, "utf8")),
                { encoding: "utf8", mode: 0o600 });
        }
        await this.copyRecentLogs(target);
        return target;
    }

    private async copyRecentLogs(target: string): Promise<void> {
        const gone = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";
        let sessions: string[] = [];
        try {
            sessions = (await readdir(this.logsDirectory, { withFileTypes: true }))
                .filter((entry) => entry.isDirectory())
                .map((entry) => entry.name);
        } catch (error) {
            if (!gone(error)) throw error;
        }
        // `rotate` deletes old session directories, so anything listed above can vanish
        // before we stat or read it. Skip the disappeared entries instead of letting one
        // of them reject and fail the whole export.
        const dated: Array<{ name: string; time: number }> = [];
        for (const name of sessions) {
            try {
                dated.push({ name, time: (await stat(join(this.logsDirectory, name))).mtimeMs });
            } catch (error) {
                if (!gone(error)) throw error;
            }
        }
        const recent = dated.sort((a, b) => b.time - a.time).slice(0, 5).map(item => item.name);
        for (const session of recent) {
            const files = await readdir(join(this.logsDirectory, session), { withFileTypes: true })
                .catch((error: unknown) => {
                    if (!gone(error)) throw error;
                    return undefined;
                });
            if (!files) continue;
            const destination = join(target, "logs", basename(session));
            await mkdir(destination, { recursive: true });
            for (const file of files) {
                if (!file.isFile() || !file.name.endsWith(".log")) continue;
                const contents = await readFile(join(this.logsDirectory, session, file.name), "utf8")
                    .catch((error: unknown) => {
                        if (!gone(error)) throw error;
                        return undefined;
                    });
                if (contents === undefined) continue;
                await writeFile(join(destination, file.name), redactRecoveryText(contents),
                    { encoding: "utf8", mode: 0o600 });
            }
        }
    }

    private async rotate(active: string): Promise<void> {
        const entries = await readdir(this.logsDirectory, { withFileTypes: true });
        const dated = await Promise.all(entries.filter(item => item.isDirectory() && item.name !== active)
            .map(async item => ({ name: item.name, time: (await stat(join(this.logsDirectory, item.name))).mtimeMs })));
        for (const item of dated.sort((a, b) => b.time - a.time).slice(4)) {
            await rm(join(this.logsDirectory, item.name), { recursive: true, force: true }).catch(() => undefined);
        }
    }
}
