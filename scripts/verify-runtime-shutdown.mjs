#!/usr/bin/env node
// Real process/listener smoke in a fresh temp directory; never uses the user's DSH_HOME or locks.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, createServer } from "node:net";

const script = fileURLToPath(import.meta.url);
const sleep = milliseconds => new Promise(done => setTimeout(done, milliseconds));
if (!process.argv.includes("--worker")) {
    const directory = await mkdtemp(join(tmpdir(), "dsh-shutdown-verify-"));
    try {
        const child = spawn(process.execPath, [script, "--worker"], {
            env: { ...process.env, TMPDIR: directory, TMP: directory, TEMP: directory,
                DSH_HOME: join(directory, "home"), DSH_SHUTDOWN_VERIFY_DIRECTORY: directory }, stdio: "inherit",
        });
        process.exitCode = await new Promise((done, reject) => {
            child.once("error", reject);
            child.once("exit", code => done(code ?? 1));
        });
    } finally { await rm(directory, { recursive: true, force: true }); }
} else {
    assert.ok(process.env.DSH_SHUTDOWN_VERIFY_DIRECTORY);
    assert.equal(resolve(tmpdir()), resolve(process.env.DSH_SHUTDOWN_VERIFY_DIRECTORY));
    const require = createRequire(import.meta.url);
    const Module = require("node:module");
    const originalLoad = Module._load;
    const settings = new Map();
    Module._load = function (id, ...args) {
        if (id === "vscode") return { workspace: { isTrusted: true,
            getConfiguration: () => ({ get: (key, fallback) => settings.has(key) ? settings.get(key) : fallback }) } };
        return originalLoad.call(this, id, ...args);
    };
    const { DshRuntime } = require(join(resolve(dirname(script), ".."), "dist/dshRuntime"));
    Module._load = originalLoad;
    let spawnRuntime = spawn;
    try { spawnRuntime = require("../dist/runtimeProcess").spawnOwnedRuntime; }
    catch (error) { if (error.code !== "MODULE_NOT_FOUND") throw error; }
    const output = { appendLine() {}, append() {} };
    const listening = port => new Promise(done => {
        const socket = connect({ host: "127.0.0.1", port });
        socket.once("connect", () => { socket.destroy(); done(true); });
        socket.once("error", () => done(false));
        socket.setTimeout(300, () => { socket.destroy(); done(true); });
    });
    const serverPath = join(tmpdir(), "server.cjs");
    const wrapperPath = join(tmpdir(), "wrapper.cjs");
    await writeFile(serverPath, `const net = require('node:net');
process.on('SIGTERM', () => {});
const server = net.createServer(socket => socket.end());
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ pid: process.pid, port: server.address().port })));
`);
    await writeFile(wrapperPath, `const { spawn } = require('node:child_process');
spawn(process.execPath, [${JSON.stringify(serverPath)}], { stdio: ['ignore', 'inherit', 'inherit'] });
setInterval(() => {}, 1000);
`);
    const probeBin = join(tmpdir(), "probe-bin");
    const probeMarker = join(tmpdir(), "probe-once");
    if (process.platform !== "win32") {
        await mkdir(probeBin);
        await writeFile(join(probeBin, "ps"), `#!/bin/sh
if [ "$1" = "--warmup" ]; then exit 0; fi
if [ ! -f ${JSON.stringify(probeMarker)} ]; then
    printf started > ${JSON.stringify(probeMarker)}
    exec /bin/sleep 1
fi
exec /bin/ps "$@"
`, { mode: 0o700 });
        // macOS may inspect a newly created executable before running its body;
        // warm that path so the timed failure measures ps, not first-run policy.
        const warmup = spawn(join(probeBin, "ps"), ["--warmup"], { stdio: "ignore" });
        assert.equal(await new Promise((done, reject) => { warmup.once("error", reject); warmup.once("exit", done); }), 0);
    }
    for (const mode of ["advertised", "before-url", "stalled-stream", ...(process.platform === "win32" ? [] : ["ps-retry"])]) {
    const previousPath = process.env.PATH;
    const child = spawnRuntime(process.execPath, [wrapperPath], {
        detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], cwd: tmpdir(),
    });
    child.stderr.on("data", chunk => process.stderr.write(chunk));
    const owner = new DshRuntime(output, join(tmpdir(), "storage"));
    try {
        const server = await new Promise((done, reject) => {
            let text = "";
            const timer = setTimeout(() => reject(new Error("fixture listener did not start")), 5000);
            child.stdout.on("data", chunk => {
                text += chunk;
                if (text.includes("\n")) { clearTimeout(timer); done(JSON.parse(text.trim())); }
            });
            child.once("error", reject);
        });
        assert.equal(await listening(server.port), true);
        assert.equal(await owner.acquireRuntimeLock("0.1.5-rc.1"), true);
        owner.child = child;
        owner.startedByExtension = true;
        owner.runtimeLock.record.runtimePid = child.pid;
        owner.runtimeLock.record.runtimeProcess = "wrapper";
        if (process.platform !== "win32") owner.runtimeLock.record.runtimeProcessGroup = child.pid;
        await owner.publishRuntimeLockUrl(mode === "before-url" ? undefined : { baseUrl: `http://127.0.0.1:${server.port}` });
        if (mode === "stalled-stream") owner.harnessState.stop = () => new Promise(() => {});
        if (mode === "ps-retry") process.env.PATH = probeBin;
        const start = Date.now();
        const stopping = Promise.all([owner.dispose(), owner.dispose(), owner.stop()]);
        if (mode === "stalled-stream") await assert.rejects(stopping, /shutdown failed/u);
        else await stopping;
        assert.ok(Date.now() - start < 5000, "shutdown must finish within the host's bounded exit window");
        if (mode === "ps-retry") assert.ok(Date.now() - start < 2500, "probe retry must leave time for process-tree shutdown");
        assert.equal(await listening(server.port), false, "the wrapper's child listener must stop before dispose resolves");
        await assert.rejects(() => readFile(join(tmpdir(), "dsh-runtime.lock")), { code: "ENOENT" });
        console.log(`PASS ${mode}: bounded concurrent shutdown removes the child listener and then releases the lock`);
        if (mode !== "stalled-stream") await assert.rejects(() => owner.start(tmpdir()), /disposed/u);
    } finally {
        if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
        // Only this smoke's newly spawned, isolated process group may be cleaned up.
        try { if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill(); } catch {}
        await sleep(100);
    }
    }

    if (process.platform !== "win32") {
        const delayedLauncher = join(tmpdir(), "delayed-launcher.cjs");
        const versionMarker = join(tmpdir(), "version-started");
        const launchMarker = join(tmpdir(), "runtime-started");
        await writeFile(delayedLauncher, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.includes('--version')) {
    fs.writeFileSync(${JSON.stringify(versionMarker)}, 'ready');
    setTimeout(() => console.log('0.1.5-rc.1'), 400);
} else fs.writeFileSync(${JSON.stringify(launchMarker)}, 'started');
`, { mode: 0o700 });
        settings.set("command", delayedLauncher);
        settings.set("commandArgs", ["web", "--no-open"]);
        const runtime = new DshRuntime(output, join(tmpdir(), "storage"));
        // Exclude machine-wide port discovery: this smoke must never contact a user's Runtime.
        runtime.findExistingRuntime = async () => undefined;
        const starting = runtime.start(tmpdir());
        const rejected = assert.rejects(starting, /cancelled/u);
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
            try { await readFile(versionMarker); break; } catch { await sleep(20); }
        }
        assert.equal(await readFile(versionMarker, "utf8"), "ready");
        await runtime.stop();
        await rejected;
        await assert.rejects(() => readFile(launchMarker), { code: "ENOENT" });
        await assert.rejects(() => readFile(join(tmpdir(), "dsh-runtime.lock")), { code: "ENOENT" });
        assert.equal(runtime.getStatus().state, "stopped");
        console.log("PASS stop during asynchronous launcher preparation prevents a late Runtime spawn or lock claim");

        // Real child exit and lock/recovery pipeline, with the unavailable
        // Windows termination boundary represented by its precise error type.
        const { RuntimeDescendantOwnershipUnknownError } = require("../dist/runtimeProcess");
        for (const failure of ["unknown-descendants", "unknown-live-listener", "taskkill-failed", "taskkill-timeout"]) {
            let survivingListener;
            const exitMarker = join(tmpdir(), `${failure}.started`);
            const exitLauncher = join(tmpdir(), `${failure}.cjs`);
            await writeFile(exitLauncher, `#!${process.execPath}
if (process.argv.includes('--version')) console.log('0.1.5-rc.1');
else { require('node:fs').writeFileSync(${JSON.stringify(exitMarker)}, 'started'); setInterval(() => {}, 1000); }
`, { mode: 0o700 });
            settings.set("command", exitLauncher);
            const runtime = new DshRuntime(output, join(tmpdir(), "storage"));
            runtime.findExistingRuntime = async () => undefined;
            runtime.harnessState.start = () => {};
            runtime.waitForReady = async () => {
                const deadline = Date.now() + 3000;
                while (Date.now() < deadline) {
                    try { await readFile(exitMarker); return "http://127.0.0.1:1"; } catch { await sleep(20); }
                }
                throw new Error("exit fixture did not start");
            };
            const terminate = runtime.terminate.bind(runtime);
            try {
                await runtime.start(tmpdir());
                runtime.runtimeLock.record.runtimeProcess = "wrapper";
                if (failure === "unknown-live-listener") {
                    survivingListener = createServer(socket => socket.end());
                    await new Promise(done => survivingListener.listen(0, "127.0.0.1", done));
                    await runtime.publishRuntimeLockUrl({ baseUrl: `http://127.0.0.1:${survivingListener.address().port}` });
                }
                runtime.terminate = async () => {
                    if (failure.startsWith("unknown-")) {
                        throw RuntimeDescendantOwnershipUnknownError ? new RuntimeDescendantOwnershipUnknownError()
                            : new Error("Runtime launcher already exited; descendant ownership cannot be verified on Windows");
                    }
                    throw new Error(failure);
                };
                const child = runtime.child;
                const exited = new Promise(done => child.once("exit", done));
                child.kill("SIGTERM");
                await exited;
                const deadline = Date.now() + 1500;
                while (Date.now() < deadline && runtime.getStatus().state !== "error" && !runtime.runtimeRecoveryTimer) await sleep(10);
                assert.equal(Boolean(runtime.runtimeRecoveryTimer), failure.startsWith("unknown-"),
                    "only the explicit unknown-descendant error may enter guarded recovery");
                if (!failure.startsWith("unknown-")) assert.equal(runtime.getStatus().state, "error");
                if (survivingListener) {
                    assert.ok(runtime.runtimeLock, "guarded recovery must retain a lock with a live listener");
                    assert.ok(await readFile(join(tmpdir(), "dsh-runtime.lock")));
                }
                console.log(`PASS ${failure}: real child exit keeps the correct recovery/error path`);
            } finally {
                runtime.cancelRuntimeRecovery();
                if (survivingListener) await new Promise(done => survivingListener.close(done));
                runtime.terminate = terminate;
                await runtime.dispose();
            }
        }
    }
}
