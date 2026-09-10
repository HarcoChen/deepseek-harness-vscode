#!/usr/bin/env node
/** Integration smoke against a real DSH launcher, using the extension's compiled Remote clients.
 * Usage: npm run compile && node scripts/verify-remote-runtime.mjs --launcher /path/to/dsh [--keep]
 * All state is isolated; model requests go only to an in-process loopback mock server.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zstdCompressSync } from "node:zlib";
import { createServer } from "node:http";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { RemoteConnectionController } = require(join(root, "dist/remote/connection"));
const { RemoteStateCoordinator } = require(join(root, "dist/remote/stateCoordinator"));
const { RemoteUnaryClient } = require(join(root, "dist/remote/unaryClient"));
const argv = process.argv.slice(2);
const launcherIndex = argv.indexOf("--launcher");
if (launcherIndex < 0 || !argv[launcherIndex + 1]) throw new Error("Pass --launcher /absolute/path/to/dsh");
const launcher = resolve(argv[launcherIndex + 1]);
const keep = argv.includes("--keep");
const storage = await mkdtemp(join(tmpdir(), "dsh-remote-verify-"));
const dshHome = join(storage, "home");
const workspacePath = join(storage, "workspace");
const seededSessionId = randomUUID();
const projectKey = `--${workspacePath.replace(/[\\/:]+/gu, "-").replace(/^-+/u, "").slice(0, 251)}--`;
const sessionDirectory = join(dshHome, "sessions", projectKey, seededSessionId);
await Promise.all([mkdir(sessionDirectory, { recursive: true }), mkdir(workspacePath)]);

// Native V3 packed records seed durable history without a model or external service.
const records = [{ type: "session", version: 3, id: seededSessionId, createdAt: Date.now(),
    cwd: workspacePath, isSeeded: false, delegationDepth: 0, agentPreset: "minimal" }];
for (let turn = 1; turn <= 8; turn += 1) {
    records.push({ type: "turn/start", data: { turn } });
    records.push({ type: "user/message", data: { id: `user-${turn}`, role: "user",
        source: { kind: "user" }, content: [{ type: "text", text: `Smoke prompt ${turn}` }] }, surfaceOp: "append" });
    records.push({ type: "assistant/message", data: { turn, step: 1,
        message: { id: `assistant-${turn}`, role: "assistant", source: { kind: "model", provider: "smoke", model: "local" },
            content: [{ type: "text", text: `Smoke answer ${turn}` }] },
        stream: [{ type: "chunk", time: Date.now(), chunk: { type: "block-start", index: 0, blockType: "text" } },
            { type: "text-chunks", time0: Date.now(), index: 0, dt: [], texts: [`Smoke answer ${turn}`] },
            { type: "chunk", time: Date.now(), chunk: { type: "block-end", index: 0, block: { type: "text", text: `Smoke answer ${turn}` } } },
            { type: "chunk", time: Date.now(), chunk: { type: "finish", reason: { kind: "stop" } } }] }, surfaceOp: "append" });
    records.push({ type: "turn/end", data: { turn, reason: { kind: "completed" } } });
}
await writeFile(join(sessionDirectory, "session.v3.jsonl.zstd"), Buffer.concat(
    records.map((record, index) => zstdCompressSync(Buffer.from(JSON.stringify(index === 0
        ? record : { ...record, seq: index - 1, time: Date.now() + index }) + "\n"))),
));

// Allowlist environment variables: do not inherit API keys, user profile paths, or loader overrides.
const env = Object.fromEntries(["PATH", "SystemRoot", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "TMPDIR"]
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
env.DSH_HOME = dshHome;
env.NO_COLOR = "1";
env.DSH_SMOKE_API_KEY = "local-smoke-only";
let finishStream;
let heldStream = false;
let modelRequests = 0;
const model = createServer(async (request, response) => {
    if (request.url === "/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ object: "list", data: [{ id: "deepseek-flash", object: "model" }] }));
        return;
    }
    if (request.url !== "/chat/completions") { response.writeHead(404); response.end(); return; }
    let body = "";
    for await (const part of request) body += part;
    const payload = JSON.parse(body);
    modelRequests += 1;
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const chunk = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({
        id: "smoke-completion", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000),
        model: payload.model, choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`);
    chunk({ role: "assistant", content: "Hello" });
    if (!heldStream && JSON.stringify(payload.messages).includes("SMOKE_STREAM")) {
        heldStream = true;
        await new Promise(resolveFinish => { finishStream = resolveFinish; });
    }
    chunk({ content: " world" });
    chunk({}, "stop");
    response.write("data: [DONE]\n\n");
    response.end();
});
await new Promise((resolveListen, rejectListen) => {
    model.once("error", rejectListen);
    model.listen(0, "127.0.0.1", resolveListen);
});
await writeFile(join(dshHome, "settings.yaml"), `llm-deepseek:\n  apiKeyEnv: DSH_SMOKE_API_KEY\n  baseURL: http://127.0.0.1:${model.address().port}\n  thinking: disabled\n`);
const patchPath = join(storage, "smoke.patch.yml");
await writeFile(patchPath, "- id: goal-round-driver\n  name: '@deepseek-ai/dsh-goal-round-driver'\n  disabled: true\n");
const child = spawn(launcher, ["--profile", "web", "--patch", patchPath, "--no-open", "--host", "127.0.0.1", "--port", "0"], {
    cwd: workspacePath, env, stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
let exited;
let launchError;
child.stdout.on("data", data => { output += data; });
child.stderr.on("data", data => { output += data; });
child.once("error", error => { launchError = error; });
child.once("exit", (code, signal) => { exited = { code, signal }; });
let connection;
let coordinator;
const diagnostics = [];
const wireFrames = [];
const remoteEvents = [];
const redact = text => text.replace(/([?&]token=)[A-Za-z0-9_-]+/gu, "$1<redacted>");
async function until(check, label, timeout = 30000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (launchError) throw launchError;
        if (exited) throw new Error(`Runtime exited: ${JSON.stringify(exited)}\n${redact(output.slice(-6000))}`);
        const value = await check();
        if (value) return value;
        await new Promise(resolveWait => setTimeout(resolveWait, 50));
    }
    throw new Error(`Timed out: ${label}\n${diagnostics.slice(-5).join("\n")}\n${redact(output.slice(-4000))}`);
}
function pass(label) { console.log(`PASS ${label}`); }
function goalReference(value) { return value.ref ?? value; }
async function first(endpoint, args = {}) {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(new Error(`${endpoint} timed out`)), 15000);
    try {
        for await (const frame of connection.open(endpoint, args, abort.signal)) return frame;
        throw new Error(`${endpoint} ended without a frame`);
    } finally { clearTimeout(timeout); abort.abort(); }
}
try {
    console.log(`Isolated DSH home: ${dshHome}`);
    const launchUrl = await until(() => output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/u)?.[0], "authenticated launch URL", 90000);
    const baseUrl = new URL(launchUrl).origin;
    const unauthorized = new RemoteUnaryClient({ baseUrl, timeoutMs: 10000 });
    await assert.rejects(() => unauthorized.probe(), error => error.status === 401 || error.status === 403);
    const exchange = await fetch(launchUrl, { redirect: "manual" });
    assert.equal(exchange.status, 303);
    const cookie = exchange.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(cookie);
    const requestHeaders = () => ({ cookie });
    pass("unauthenticated RPC rejected; launch token exchanged for cookie");
    connection = new RemoteConnectionController({ baseUrl, requestHeaders,
        onEvent: frame => remoteEvents.push(frame),
        onDiagnostic: (message, cause) => diagnostics.push(`${message}: ${cause?.message ?? cause ?? ""}`) });
    // Observe decoded server frames while retaining the actual extension mux and state coordinator.
    const open = connection.open.bind(connection);
    connection.open = async function* (endpoint, args, signal) {
        for await (const frame of open(endpoint, args, signal)) {
            wireFrames.push({ endpoint, frame, generation: connection.currentGeneration });
            yield frame;
        }
    };
    let descriptions = 0;
    coordinator = new RemoteStateCoordinator(connection, {
        onHostDescription: () => { descriptions += 1; },
        onDiagnostic: (message, cause) => diagnostics.push(`${message}: ${cause?.message ?? cause ?? ""}`),
    }, { historyPageSize: 2, runtimeVersion: "0.1.5-rc.1" });
    coordinator.start();
    await until(() => descriptions > 0, "coordinator baseline");
    await connection.unary.probe();
    pass("authenticated unary, mux $events, workspace and control baselines");
    assert.ok(coordinator.catalog.snapshot().sessions.some(session => session.sessionId === seededSessionId));
    const workspace = await connection.unary.call("workspace/create", { request: { path: workspacePath } });
    const workspaceId = workspace.workspace?.workspaceId ?? workspace.workspaceId;
    assert.ok(workspaceId, JSON.stringify(workspace));
    await until(() => coordinator.catalog.snapshot().workspaces.some(item => item.workspaceId === workspaceId), "workspace update");
    const created = await connection.unary.call("session/create", { request: { workspaceId, agentPreset: "minimal" } });
    assert.equal(typeof created.sessionId, "string");
    await coordinator.refreshCatalog();
    assert.ok(coordinator.catalog.snapshot().sessions.some(session => session.sessionId === created.sessionId));
    pass("workspace/create and session/create update the live catalog");
    coordinator.watchSession(seededSessionId);
    await coordinator.syncHistory(seededSessionId);
    const history = await until(() => {
        const state = coordinator.sessions.get(seededSessionId);
        return state?.surface.nodes.length === 16 && state.surface.complete && state;
    }, "V3 paginated durable history");
    assert.ok(history.events.length >= 32);
    assert.equal(history.needsHistoryBaseline, false);
    const tail = await first("session/follow", { request: { address: { kind: "session", sessionId: seededSessionId }, maxMessages: 2 } });
    assert.equal(tail.type, "snapshot");
    assert.equal(tail.hasMore, true);
    pass("V3 packed session/follow snapshot and backward session/page history (16 message surfaces)");
    await connection.unary.call("session/rename", { request: { sessionId: seededSessionId, title: "Runtime smoke renamed" } });
    await until(() => coordinator.catalog.snapshot().sessions.some(session => session.sessionId === seededSessionId && session.title === "Runtime smoke renamed"), "live title projection");
    pass("live session title projection reaches catalog");
    const oldGeneration = connection.currentGeneration;
    const oldDescriptions = descriptions;
    connection.reconnect();
    await until(() => connection.currentGeneration > oldGeneration && descriptions > oldDescriptions, "reconnect baselines");
    await coordinator.syncHistory(seededSessionId);
    assert.equal(coordinator.sessions.get(seededSessionId).surface.nodes.length, 16);
    assert.equal(coordinator.catalog.snapshot().workspaces.length, 1);
    pass("reconnect reopens event/control/workspace/session streams without duplicate surfaces");
    coordinator.watchSession(created.sessionId);
    await coordinator.syncHistory(created.sessionId);
    await connection.unary.call("session/prompt", { request: { sessionId: created.sessionId,
        requestId: randomUUID(), mode: "queue", content: [{ type: "text", text: "SMOKE_STREAM" }] } });
    await until(() => JSON.stringify(coordinator.sessions.get(created.sessionId)?.assistantStream)?.includes("Hello"), "live assistant prefix");
    assert.ok(JSON.stringify(coordinator.sessions.get(created.sessionId).assistantStream).includes("Hello"));
    const streamingGeneration = connection.currentGeneration;
    connection.reconnect();
    await until(() => connection.currentGeneration > streamingGeneration &&
        wireFrames.some(({ endpoint, frame, generation }) => endpoint === "session/follow" && frame.type === "snapshot" &&
            generation === connection.currentGeneration && frame.assistantStream?.activeAttempt) &&
        JSON.stringify(coordinator.sessions.get(created.sessionId)?.assistantStream)?.includes("Hello"), "reconnected assistant prefix");
    assert.equal(typeof finishStream, "function");
    finishStream();
    await until(() => {
        const state = coordinator.sessions.get(created.sessionId);
        return !state?.assistantStream && state?.events.some(({ event }) => event.type === "turn/end");
    }, "committed assistant settlement");
    const live = coordinator.sessions.get(created.sessionId);
    const assistantMessages = live.surface.nodes.filter(({ event }) => event.type === "assistant/message");
    assert.equal(assistantMessages.length, 1);
    assert.equal(assistantMessages[0].event.data.message.content[0].text, "Hello world");
    assert.ok(wireFrames.some(({ frame }) => frame.type === "assistant-stream" && frame.frame.type === "start"));
    assert.ok(wireFrames.some(({ frame }) => frame.type === "assistant-stream" && frame.frame.type === "chunk"));
    assert.ok(wireFrames.some(({ frame }) => frame.type === "assistant-stream" && frame.frame.type === "end"));
    pass("local model live start/chunk/end, reconnect prefix, and one final committed message");
    let goalRef = goalReference(await connection.unary.call("goals/create", { agentId: created.sessionId,
        request: { objective: "Local integration smoke", maxGoalRounds: 1 } }));
    assert.equal((await connection.unary.call("goals/get", { agentId: created.sessionId })).activation, "armed");
    goalRef = goalReference(await connection.unary.call("goals/pause", { agentId: created.sessionId, ref: goalRef }));
    assert.equal((await connection.unary.call("goals/get", { agentId: created.sessionId })).activation, "disarmed");
    goalRef = goalReference(await connection.unary.call("goals/resume", { agentId: created.sessionId, ref: goalRef }));
    assert.equal((await connection.unary.call("goals/get", { agentId: created.sessionId })).activation, "armed");
    await connection.unary.call("goals/clear", { agentId: created.sessionId, ref: goalRef });
    assert.equal(await connection.unary.call("goals/get", { agentId: created.sessionId }), undefined);
    await until(() => remoteEvents.filter(event => event.event === "goal/activation-changed").length >= 4, "goal activation events");
    const activations = remoteEvents.filter(event => event.event === "goal/activation-changed")
        .map(event => event.args[0]).filter(value => value.sessionId === created.sessionId);
    assert.ok(activations.some(value => value.goal?.activation === "armed"));
    assert.ok(activations.some(value => value.goal?.activation === "disarmed"));
    assert.ok(activations.some(value => value.goal === undefined));
    pass("goal create/pause/resume/clear and process-local activation events");
    await connection.unary.call("commands/execute", { agentId: created.sessionId, line: "/help", submittedAttachments: [] });
    pass("commands/execute accepts submittedAttachments envelope");
    await assert.rejects(() => connection.unary.call("subagents/prompt", { request: {
        parentSessionId: created.sessionId, childSessionId: "missing-smoke-child", mode: "continuable",
        delivery: "queue", requestId: randomUUID(), content: [{ type: "text", text: "Smoke" }],
    } }), error => error.isDSHRemoteError === true && error.code === "subagent/not-resumable");
    pass("subagents/prompt request/delivery envelope reaches missing-child validation");
    const streamTypes = [...new Set(wireFrames.map(({ endpoint, frame }) => `${endpoint}:${frame.type}`))];
    console.log(`Observed frames: ${streamTypes.join(", ")}`);
    assert.equal(diagnostics.length, 0, diagnostics.join("\n"));
    console.log(`OK: real Runtime integration smoke passed; ${modelRequests} local mock model request(s), no external model calls.`);
} catch (error) {
    console.error(error.stack ?? error);
    console.error(`Mock requests: ${modelRequests}; recent wire frames: ${JSON.stringify(wireFrames.slice(-8))}`);
    process.exitCode = 1;
} finally {
    finishStream?.();
    await coordinator?.stop().catch(() => undefined);
    if (!coordinator) await connection?.stop().catch(() => undefined);
    if (!exited) child.kill("SIGTERM");
    await Promise.race([new Promise(resolveExit => {
        if (exited || launchError) resolveExit();
        else child.once("exit", resolveExit);
    }), new Promise(resolveTimeout => setTimeout(resolveTimeout, 3000))]);
    if (!exited && !launchError) { child.kill("SIGKILL"); await new Promise(resolveExit => child.once("exit", resolveExit)); }
    model.closeAllConnections();
    await new Promise(resolveClose => model.close(resolveClose));
    if (keep) console.log(`Kept isolated storage: ${storage}`);
    else await rm(storage, { recursive: true, force: true });
}
