#!/usr/bin/env node
// Filesystem/process integration smoke. Never reads or mutates the user's shared lock.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const script = fileURLToPath(import.meta.url);
if (!process.argv.includes("--worker")) {
    const directory = await mkdtemp(join(tmpdir(), "dsh-lock-verify-"));
    try {
        const child = spawn(process.execPath, [script, "--worker"], {
            env: { ...process.env, TMPDIR: directory, TMP: directory, TEMP: directory,
                DSH_LOCK_VERIFY_DIRECTORY: directory }, stdio: "inherit",
        });
        process.exitCode = await new Promise((done, reject) => {
            child.once("error", reject);
            child.once("exit", code => done(code ?? 1));
        });
    } finally { await rm(directory, { recursive: true, force: true }); }
} else {
    assert.ok(process.env.DSH_LOCK_VERIFY_DIRECTORY, "worker requires the parent's isolated directory");
    assert.equal(resolve(tmpdir()), resolve(process.env.DSH_LOCK_VERIFY_DIRECTORY));
    const require = createRequire(import.meta.url);
    const Module = require("node:module");
    const originalLoad = Module._load;
    // VS Code is absent in a CLI. The startup path only needs its workspace trust flag.
    Module._load = function (id, ...args) {
        if (id === "vscode") return { workspace: { isTrusted: true } };
        return originalLoad.call(this, id, ...args);
    };
    const { DshRuntime } = require(join(resolve(dirname(script), ".."), "dist/dshRuntime"));
    Module._load = originalLoad;
    const path = join(tmpdir(), "dsh-runtime.lock");
    const legacyPath = join(tmpdir(), "dsh-vscode-runtime.lock");
    const runtime = () => Object.assign(Object.create(DshRuntime.prototype), {
        runtimeLockWrite: Promise.resolve(), output: { appendLine() {} },
    });
    const contents = () => readFile(path, "utf8").then(JSON.parse);
    const absent = async target => assert.rejects(() => readFile(target), { code: "ENOENT" });
    if (process.argv.includes("--contender")) {
        const owner = runtime();
        process.send(await owner.acquireRuntimeLock("0.1.5-rc.1"));
        process.once("message", async () => { await owner.releaseRuntimeLock(); process.exit(0); });
    } else {
        const exited = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
        await new Promise(done => exited.once("exit", done));
        const deadPid = exited.pid;
        const first = runtime();
        assert.equal(await first.acquireRuntimeLock("0.1.5-rc.1"), true);
        let record = await contents();
        assert.equal(record.runtimeVersion, "0.1.5-rc.1", "new locks must advertise the launch version");
        assert.equal(record.pid, process.pid);
        assert.equal(typeof record.ownerId, "string");
        assert.equal(await runtime().acquireRuntimeLock("0.1.5-rc.1"), false);
        await first.releaseRuntimeLock();
        await absent(path);
        console.log("PASS versioned creation, exclusive acquisition, and normal owner release");

        const server = createServer(socket => socket.end());
        await new Promise(done => server.listen(0, "127.0.0.1", done));
        const url = `http://127.0.0.1:${server.address().port}`;
        const owner = runtime();
        try {
            assert.equal(await owner.acquireRuntimeLock("0.1.5-rc.1"), true);
            owner.child = { pid: process.pid };
            await owner.publishRuntimeLockUrl({ baseUrl: url, launchUrl: `${url}/?token=smoke-only` });
            record = await contents();
            assert.equal(record.runtimeVersion, "0.1.5-rc.1");
            assert.equal(record.runtimePid, process.pid);
            assert.equal((await runtime().readRuntimeEndpoint()).baseUrl, url);
            // Releasing while the child is alive must not expose a second writer.
            await owner.releaseRuntimeLock();
            assert.equal((await contents()).ownerId, record.ownerId);
            assert.ok(owner.runtimeLock, "retained live lock must retain ownership for later release");
            await writeFile(path, JSON.stringify({ ...record, pid: deadPid, runtimePid: deadPid }));
            assert.equal(await runtime().acquireRuntimeLock("0.1.5-rc.1"), false,
                "a surviving listener blocks reclamation even when recorded PIDs exited");
            await writeFile(path, JSON.stringify({ ...record, pid: deadPid, runtimeVersion: "0.1.2-rc.1" }));
            await assert.rejects(() => runtime().readRuntimeEndpoint(), /0\.1\.2-rc\.1/u);
            await writeFile(path, JSON.stringify({ pid: deadPid, url }));
            await assert.rejects(() => runtime().readRuntimeEndpoint(), /version|版本/u);
            assert.equal(await runtime().acquireRuntimeLock("0.1.5-rc.1"), false);
            console.log("PASS live/orphan service preserved; mismatched and unversioned locks rejected");
        } finally {
            await new Promise(done => server.close(done));
            // The on-disk record is now an unversioned replacement, so close the old handle without deleting it.
            await owner.releaseRuntimeLock();
        }

        // An old advertised lock has no reliable Runtime PID: refuse even after its port closes.
        assert.equal(await runtime().acquireRuntimeLock("0.1.5-rc.1"), false);
        await rm(path);
        // Failure before URL publication cannot prove that a wrapper's descendant exited.
        await writeFile(path, JSON.stringify({ pid: deadPid, runtimePid: deadPid,
            runtimeVersion: "0.1.5-rc.1", runtimeProcess: "wrapper" }));
        assert.equal(await runtime().acquireRuntimeLock("0.1.5-rc.1"), false);
        await rm(path);
        await writeFile(path, JSON.stringify({ ...record, pid: deadPid, runtimePid: deadPid }));
        const replacement = runtime();
        assert.equal(await replacement.acquireRuntimeLock("0.1.5-rc.1"), true);
        assert.notEqual((await contents()).ownerId, record.ownerId);
        await replacement.releaseRuntimeLock();
        console.log("PASS confirmed dead owner/child and refused local port allow stale cleanup");

        await writeFile(path, "{incomplete");
        assert.equal(await runtime().acquireRuntimeLock("0.1.5-rc.1"), false);
        await assert.rejects(() => runtime().readRuntimeEndpoint(), /lock|锁/u);
        assert.equal(await readFile(path, "utf8"), "{incomplete");
        await rm(path);
        await writeFile(legacyPath, JSON.stringify({ pid: process.pid }));
        assert.equal(await runtime().acquireRuntimeLock("0.1.5-rc.1"), false);
        await rm(legacyPath);
        console.log("PASS malformed/legacy locks are not silently removed");

        const superseded = runtime();
        assert.equal(await superseded.acquireRuntimeLock("0.1.5-rc.1"), true);
        const nextOwner = { ...await contents(), ownerId: "different-owner" };
        await rm(path);
        await writeFile(path, JSON.stringify(nextOwner));
        await superseded.releaseRuntimeLock();
        assert.deepEqual(await contents(), nextOwner);
        await rm(path);
        console.log("PASS release cannot unlink another owner's replacement lock");

        const retained = runtime();
        assert.equal(await retained.acquireRuntimeLock("0.1.5-rc.1"), true);
        retained.runtimeLock.record.runtimePid = process.pid;
        retained.runtimeLock.record.runtimeProcess = "direct";
        await retained.publishRuntimeLockUrl();
        await retained.releaseRuntimeLock();
        assert.ok(retained.runtimeLock);
        retained.runtimeLock.record.runtimePid = deadPid;
        await retained.publishRuntimeLockUrl();
        await retained.releaseRuntimeLock();
        await absent(path);
        console.log("PASS retained ownership can release after the recorded runtime exits");

        // A cached endpoint from failed automatic discovery must never bypass the shared version gate.
        await writeFile(path, JSON.stringify({ pid: process.pid, url, runtimeVersion: "0.1.2-rc.1" }));
        const cached = runtime();
        cached.baseUrl = url;
        cached.listeners = new Set();
        cached.configuration = () => ({ get: (_key, fallback) => fallback });
        cached.isHarnessHealthy = async () => true; // network boundary only; real start/discovery/version logic
        await assert.rejects(() => cached.startInternal(tmpdir()), /0\.1\.2-rc\.1/u);
        await assert.rejects(() => cached.startInternal(tmpdir()), /0\.1\.2-rc\.1/u);
        await rm(path);
        console.log("PASS cached automatic endpoint cannot bypass lock version checks on retry");

        await writeFile(path, JSON.stringify({ ...record, pid: deadPid, runtimePid: deadPid }));
        const contenders = [0, 1].map(() => spawn(process.execPath, [script, "--worker", "--contender"], {
            env: process.env, stdio: ["ignore", "inherit", "inherit", "ipc"],
        }));
        const results = await Promise.all(contenders.map(child => new Promise((done, reject) => {
            child.once("message", done);
            child.once("error", reject);
            child.once("exit", code => reject(new Error(`Contender exited before reporting: ${code}`)));
        })));
        const exits = contenders.map(child => new Promise(done => child.once("exit", done)));
        for (const child of contenders) child.send("release");
        await Promise.all(exits);
        assert.equal(results.filter(Boolean).length, 1);
        await absent(path);
        await absent(`${path}.mutation`);
        console.log("PASS concurrent stale reclamation has exactly one owner and removes mutation guards");

        const abandoned = JSON.stringify({ pid: deadPid, createdAt: Date.now() });
        await writeFile(`${path}.mutation`, abandoned);
        await assert.rejects(() => runtime().acquireRuntimeLock("0.1.5-rc.1"), /mutation/u);
        assert.equal(await readFile(`${path}.mutation`, "utf8"), abandoned);
        await rm(`${path}.mutation`);
        console.log("PASS abandoned mutation guard is reported and preserved for manual inspection");
    }
}
