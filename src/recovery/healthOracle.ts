import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { spawnOwnedRuntime, terminateOwnedRuntime } from "../runtimeProcess";
import { RemoteHttpError } from "../remote/errors";
import { RemoteUnaryClient } from "../remote/unaryClient";
import { redactRecoveryText, RecoveryDiagnostics } from "./diagnostics";
import { SandboxBuildError, SandboxManager, type RecoverySandbox } from "./sandbox";
import type { CompositionDescriptor, CompositionVariant, HealthEvidence, RecoveryBootLog } from "./types";

const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** A 401/403 is a terminal auth failure, not a transient probe error worth retrying. */
function isAuthenticationFailure(error: unknown): boolean {
    return error instanceof RemoteHttpError && error.isAuthenticationFailure;
}

export interface HealthOracleOptions {
    timeoutMs?: number;
    diagnostics?: RecoveryDiagnostics;
    onOutput?: (message: string) => void;
}

export class HealthOracle {
    public constructor(
        private readonly sandboxManager = new SandboxManager(),
        private readonly options: HealthOracleOptions = {},
    ) {}

    public async evaluate(
        composition: CompositionDescriptor,
        variant: CompositionVariant,
        options: { sessionId?: string; signal?: AbortSignal } = {},
    ): Promise<HealthEvidence> {
        const started = Date.now();
        const bootId = randomUUID();
        const controller = new AbortController();
        const relay = (): void => controller.abort(options.signal?.reason);
        options.signal?.addEventListener("abort", relay, { once: true });
        if (options.signal?.aborted) relay();
        const timer = setTimeout(() => controller.abort(new Error("Recovery boot timed out")), this.options.timeoutMs ?? 20_000);
        let sandbox: RecoverySandbox | undefined;
        let child: ReturnType<typeof spawnOwnedRuntime> | undefined;
        let log: RecoveryBootLog | undefined;
        let endpoint: { baseUrl: string; launchUrl?: string; cookie?: string } | undefined;
        let launchError: Error | undefined;
        let exited = false;
        let wrapper = false;
        const notes: string[] = [];
        const evidence: HealthEvidence = {
            bootId, variantId: variant.id,
            verdict: "unhealthy", failureClass: "unknown",
            startedAt: new Date(started).toISOString(), finishedAt: "", durationMs: 0,
            process: { launcherExited: false, descendantOwnership: "not-needed" },
            outputTail: "", outputTruncated: false,
            cleanup: { processStopped: true, secretFilesRemoved: true, sandboxRemoved: true },
            classifierNotes: [],
        };
        try {
            controller.signal.throwIfAborted();
            if (options.sessionId && this.options.diagnostics) {
                log = await this.options.diagnostics.beginBoot(options.sessionId, variant.id,
                    variant.composition.compositionHash, bootId);
            }
            sandbox = await this.sandboxManager.create(composition, variant);
            controller.signal.throwIfAborted();
            const launch = sandbox.launch;
            const shell = process.platform === "win32" && !/\.exe$/iu.test(launch.command);
            wrapper = shell || /\b(?:pnpm|npx)\b/iu.test(launch.source);
            if (shell && [launch.command, ...launch.args].some(value => /["%!\r\n&|<>^]/u.test(value))) {
                throw new Error("Recovery launcher arguments cannot be safely invoked through cmd.exe");
            }
            child = spawnOwnedRuntime(shell ? `"${launch.command}"` : launch.command,
                shell ? launch.args.map(value => `"${value}"`) : [...launch.args], {
                    cwd: launch.cwd, env: launch.env, shell, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
                });
            evidence.process.pid = child.pid;
            evidence.process.descendantOwnership = "owned";
            const output = (text: string, stream: "stdout" | "stderr"): void => {
                for (const match of text.matchAll(/http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+(?:\/\?token=[A-Za-z0-9_-]+)?/gu)) {
                    const url = new URL(match[0]);
                    const authenticated = url.searchParams.has("token");
                    // Runtime output routinely mentions a bare loopback URL. Letting such a
                    // line replace the endpoint would drop the stored launchUrl/cookie and
                    // the probe would then keep running unauthenticated until it timed out.
                    if (endpoint && !authenticated) continue;
                    if (endpoint?.launchUrl === url.href) continue;
                    endpoint = {
                        baseUrl: url.origin,
                        ...(authenticated ? { launchUrl: url.href } : {}),
                    };
                }
                const safe = redactRecoveryText(text);
                const bytes = Buffer.from(evidence.outputTail + safe);
                evidence.outputTruncated ||= bytes.length > 32 * 1024;
                evidence.outputTail = bytes.subarray(-32 * 1024).toString("utf8");
                this.options.onOutput?.(safe);
                if (log) void log.append(stream, safe).catch(error => notes.push(redactRecoveryText(String(error))));
            };
            for (const [stream, pipe] of [["stdout", child.stdout], ["stderr", child.stderr]] as const) {
                const decoder = new StringDecoder("utf8");
                let pending = "";
                let oversized = false;
                pipe?.on("data", (chunk: Buffer) => {
                    pending += decoder.write(chunk);
                    let newline: number;
                    while ((newline = pending.indexOf("\n")) >= 0) {
                        const line = pending.slice(0, newline + 1);
                        output(oversized || line.length > 64 * 1024 ? "[oversized output line omitted]\n" : line, stream);
                        pending = pending.slice(newline + 1);
                        oversized = false;
                    }
                    if (pending.length > 64 * 1024) { pending = ""; oversized = true; }
                });
                pipe?.once("end", () => {
                    const tail = decoder.end();
                    pending += tail;
                    if (pending && !oversized) output(pending, stream);
                    pending = "";
                });
            }
            child.once("error", error => { launchError = error; exited = true; });
            child.once("exit", () => { exited = true; });
            while (true) {
                controller.signal.throwIfAborted();
                if (exited) {
                    evidence.failureClass = launchError ? "launcher" : "boot-exit";
                    throw launchError ?? new Error("Recovery Runtime exited before becoming healthy");
                }
                if (endpoint) {
                    try {
                        if (endpoint.launchUrl && !endpoint.cookie) {
                            const response = await fetch(endpoint.launchUrl, {
                                redirect: "manual", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(1_500)]),
                            });
                            const cookie = response.headers.get("set-cookie")?.split(";", 1)[0]?.trim();
                            if (response.status !== 303 || !cookie || !/^[^=;]+=[^;]*$/u.test(cookie)) {
                                throw response.status === 401 || response.status === 403
                                    ? new RemoteHttpError(endpoint.baseUrl, response.status)
                                    : new Error(`Runtime authentication returned HTTP ${response.status}`);
                            }
                            endpoint.cookie = cookie;
                        }
                        await new RemoteUnaryClient({
                            baseUrl: endpoint.baseUrl, timeoutMs: 1_500,
                            requestHeaders: (): Record<string, string> =>
                                endpoint?.cookie === undefined ? {} : { cookie: endpoint.cookie },
                        }).probe(controller.signal);
                        controller.signal.throwIfAborted();
                        if (exited) continue;
                        evidence.verdict = "healthy";
                        evidence.failureClass = "none";
                        evidence.endpoint = { baseUrl: endpoint.baseUrl, authenticated: Boolean(endpoint.cookie), probe: "session/list" };
                        break;
                    } catch (error) {
                        notes.push(redactRecoveryText(String(error)));
                        if (notes.length > 20) notes.shift();
                        // Retrying a 401/403 at ~10/s until the timeout would misreport the
                        // cause as `boot-timeout` instead of the design-required `auth`.
                        if (isAuthenticationFailure(error)) {
                            evidence.failureClass = "auth";
                            throw error;
                        }
                    }
                }
                await pause(100);
            }
        } catch (error) {
            notes.push(redactRecoveryText(String(error)));
            evidence.verdict = options.signal?.aborted ? "cancelled"
                : controller.signal.aborted ? "timeout"
                    : error instanceof SandboxBuildError ? "sandbox-error" : "process-error";
            if (evidence.failureClass === "unknown") {
                evidence.failureClass = error instanceof SandboxBuildError ? "sandbox-build"
                    : controller.signal.aborted ? "boot-timeout" : "launcher";
            }
        } finally {
            clearTimeout(timer);
            options.signal?.removeEventListener("abort", relay);
            evidence.process.launcherExited = exited;
            if (child) {
                evidence.process.exitCode = child.exitCode;
                evidence.process.signal = child.signalCode;
                try {
                    const deadDirect = process.platform === "win32" && !wrapper &&
                        (child.exitCode !== null || child.signalCode !== null);
                    if (!deadDirect) await terminateOwnedRuntime(child);
                    evidence.process.descendantOwnership = "verified-exited";
                } catch (error) {
                    evidence.cleanup.processStopped = false;
                    evidence.process.descendantOwnership = "unknown";
                    notes.push(redactRecoveryText(String(error)));
                }
            }
            if (sandbox && evidence.cleanup.processStopped) {
                const cleanup = await sandbox.cleanup();
                evidence.cleanup.secretFilesRemoved = cleanup.secretFilesRemoved;
                evidence.cleanup.sandboxRemoved = cleanup.removed;
                evidence.sandboxPath = sandbox.root;
            } else if (sandbox) {
                evidence.cleanup.secretFilesRemoved = false;
                evidence.cleanup.sandboxRemoved = false;
                evidence.sandboxPath = sandbox.root;
                notes.push("Sandbox retained because Runtime process ownership was not verified.");
            }
            if (!evidence.cleanup.processStopped || !evidence.cleanup.sandboxRemoved || !evidence.cleanup.secretFilesRemoved) {
                evidence.cleanup.deferredCleanup = true;
                if (evidence.verdict === "healthy") {
                    evidence.verdict = "sandbox-error";
                    evidence.failureClass = "sandbox-cleanup";
                }
            }
            evidence.durationMs = Date.now() - started;
            evidence.finishedAt = new Date().toISOString();
            evidence.classifierNotes = notes.slice(-20);
            if (log) { evidence.logPath = log.path; await log.finish(evidence); }
        }
        return evidence;
    }
}
