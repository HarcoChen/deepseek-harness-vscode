#!/usr/bin/env node
// Smoke for the "adopt before search" recovery step (design 745-756): a healthy Runtime whose
// recorded composition hash matches ours is adopted outright; a healthy Runtime with a mismatched
// or absent hash is reported and left alone, so the normal recovery search still runs.
//
// Cases 2 and 3 exercise the private decision directly and synchronously (prototype call, stubbed
// collaborators): driving them through the real scheduleRuntimeRecovery path costs 21s of real
// timers plus a full sandbox search. Case 1 drives the real DshRuntime end to end, which is the
// regression guard that actually pins "no healthy Runtime listening -> adoption declines".
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const sleep = ms => new Promise(done => setTimeout(done, ms));
// The integration case must exhaust the real retry ladder (1s + 5s + 15s) before the
// unexpected-exit path runs, so the deadline covers that ladder plus a start and a stop.
const REPORT_DEADLINE_MS = 120_000;

/**
 * Unref everything: an assertion that throws mid-flight must not leave a listener, a polling
 * interval, or a deadline timer holding the event loop open. The report timeout below is armed
 * with ref() for the whole run for exactly that reason - a hung worker must still fail.
 */
function unrefAll() {
    for (const handle of [process.stdout, process.stdin, process.stderr]) handle?.unref?.();
}

if (!process.argv.includes("--worker")) {
    const directory = await mkdtemp(join(tmpdir(), "dsh-verify-adopt-"));
    // A fresh port per run: a listener leaked by an aborted earlier run must never be mistaken
    // for the fixture (an unrelated healthy harness on the configured port makes the extension's
    // discovery fail fast on the shared lock's version check).
    let timer;
    try {
        const child = spawn(process.execPath, [script, "--worker"], {
            env: { ...process.env, TMPDIR: directory, TMP: directory, TEMP: directory,
                // homedir() is read from these at module-load time; point them at the fixture
                // so both the extension and the fake runtime resolve the same DSH home.
                USERPROFILE: directory, HOME: directory,
                // DSH_HOME is the supported whole-home redirect (dshRuntime.ts resolves the
                // launch composition from it); homedir() alone is not reliable on Windows.
                DSH_HOME: join(directory, ".dsh"),
                // The native shim launcher re-executes node; pass its path explicitly rather
                // than depending on PATH inside the sandboxed child.
                DSH_SHIM_NODE: process.execPath,
                ADOPT_DIRECTORY: directory,
                ADOPT_PORT: String(20000 + Math.floor(Math.random() * 20000)),
                ADOPT_BOOT_MARKER: join(directory, ".booted"),
                ADOPT_DIE_FILE: join(directory, ".die") }, stdio: "inherit",
        });
        const outcome = new Promise((done, reject) => {
            child.once("error", reject);
            child.once("exit", code => done(code ?? 1));
        });
        const hung = await Promise.race([
            outcome,
            new Promise(done => {
                timer = setTimeout(() => done("hung"), REPORT_DEADLINE_MS);
                timer.ref();
            }),
        ]);
        if (hung === "hung") {
            console.error("FAIL verify-adopt: no verdict from the worker within " + REPORT_DEADLINE_MS + "ms");
            // The worker's fixture tree (shim -> node -> listener) must die too, or it outlives
            // this run and poisons the next one on the same port.
            if (child.pid !== undefined) {
                spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
            }
            child.kill();
            await outcome.catch(() => undefined);
            process.exitCode = 1;
        } else {
            process.exitCode = hung;
        }
    } finally {
        if (timer !== undefined) clearTimeout(timer);
        // ADOPT_KEEP=1 keeps the fixture (fake Runtime, fake DSH home) for triage.
        // The fake Runtime may still be releasing its cwd; a lost fixture directory is not a
        // test failure, so retry briefly and otherwise leave it for the OS to reap.
        if (process.env.ADOPT_KEEP !== "1") {
            for (let attempt = 0; attempt < 5; attempt += 1) {
                try { await rm(directory, { recursive: true, force: true }); break; }
                catch { await new Promise(done => setTimeout(done, 300)); }
            }
        }
        else console.log("fixture kept at " + directory);
        unrefAll();
    }
} else {
    const directory = process.env.ADOPT_DIRECTORY;
    assert.ok(directory, "the worker must receive the fixture directory");
    const adoptPort = Number(process.env.ADOPT_PORT);
    assert.ok(Number.isInteger(adoptPort) && adoptPort > 0, "the worker must receive a port");
    unrefAll();
    const require = createRequire(import.meta.url);

    // ---- isolated DSH home + a profile whose manifest is the composition fingerprint ----
    const profileDir = join(directory, ".dsh", "profiles", "web");
    const storage = join(directory, "storage");
    const workspace = join(directory, "workspace");
    await mkdir(join(profileDir, "node_modules", "@fixture", "good"), { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(join(profileDir, "node_modules", "@fixture", "good", "package.json"), '{"name":"@fixture/good"}');
    await writeFile(join(profileDir, "package.json"), JSON.stringify({
        name: "fixture-profile", dsh: { profile: { bundles: ["@fixture/good"] } },
    }, null, 2) + "\n");

    // A fake dsh launcher: answers --version, then serves the RC Remote health probe.
    // First boot: come up healthy, then die - the unexpected exit that starts the retry
    // ladder. Later boots: die immediately, so the three raw retries fail fast and the
    // unexpected-exit path (where the adopt probe lives) is reached deterministically.
    const fakeDsh = join(directory, "fake-dsh.cjs");    await writeFile(fakeDsh, `const http = require("node:http");
const fs = require("node:fs");
// The extension probes a custom command with --version before it will launch it.
if (process.argv.includes("--version")) {
  console.log("0.1.5-rc.1");
  process.exit(0);
}
const argv = process.argv.slice(2);
const portIndex = argv.indexOf("--port");
const requested = portIndex >= 0 ? Number(argv[portIndex + 1]) : 0;
const bootMarker = process.env.ADOPT_BOOT_MARKER;
if (bootMarker && fs.existsSync(bootMarker)) { process.exit(9); }
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", c => { body += c; });
  req.on("end", () => {
    let parsed = {};
    try { parsed = JSON.parse(body); } catch {}
    res.setHeader("content-type", "application/json");
    // Answer the health probe the way the Oracle expects.
    res.end(JSON.stringify({ type: "server-response", rpcId: parsed.rpcId,
      result: { ok: true, value: { items: [] } } }));
  });
});
server.listen(requested, "127.0.0.1", () => console.log("http://127.0.0.1:" + server.address().port));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
// Stay healthy until the WORKER signals (it watches the extension reach "running"), then die -
// the unexpected exit that starts the retry ladder. A fixed timer would race the readiness
// probe on a loaded machine and flake the whole scenario.
fs.writeFileSync(bootMarker, "booted");
const dieFile = process.env.ADOPT_DIE_FILE;
const dieWatch = setInterval(() => { if (dieFile && fs.existsSync(dieFile)) { clearInterval(dieWatch); process.exit(9); } }, 100);
setTimeout(() => process.exit(9), 15_000);
`, { encoding: "utf8", mode: 0o600 });
    // A dsh-shaped launcher: answers --version itself (the extension probes any custom
    // command), then hands the real launch to node running the fake runtime.
    // The launcher must be a DIRECT .exe: the Oracle treats any non-.exe command as a cmd.exe
    // wrapper, whose descendant ownership Windows cannot verify, and it then defers cleanup and
    // aborts the whole search after a single boot.
    const shimDir = join(directory, "shim");
    await mkdir(shimDir, { recursive: true });
    const shim = join(shimDir, "dsh.exe");
    await writeFile(join(shimDir, "fake-dsh.cjs"), await readFile(fakeDsh, "utf8"), { encoding: "utf8" });
    const nodeExe = process.execPath;
    // The C# launcher lives in a sibling file so it needs no nested template escaping.
    await writeFile(join(shimDir, "shim.cs"), await readFile(join(dirname(script), "verify-adopt-shim.cs"), "utf8"), { encoding: "utf8" });
    const csc = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
    const built = await new Promise((done, reject) => {
        const child = spawn(csc, ["/nologo", "/out:" + shim, join(shimDir, "shim.cs")],
            { stdio: ["ignore", "pipe", "pipe"] });
        let detail = "";
        child.stdout.on("data", chunk => { detail += chunk; });
        child.stderr.on("data", chunk => { detail += chunk; });
        child.once("error", reject);
        child.once("exit", code => {
            if (code === 0) done(true);
            else reject(new Error(`csc failed (exit ${code ?? "null"}): ${detail}`));
        });
    });
    assert.ok(built && existsSync(shim), "the native launcher shim must build");


    const Module = require("node:module");
    const originalLoad = Module._load;
    const settings = new Map([
        ["recovery.enabled", true],
        ["command", shim],
        ["commandArgs", ["web", "--no-open"]],
        ["autoStart", false],
        ["requestTimeoutMs", 5_000],
        ["startupTimeoutMs", 15_000],
        // A dedicated per-run port keeps discovery off any other Runtime on this machine.
        ["serverPort", adoptPort],
    ]);
    const configuration = { get: (key, fallback) => settings.has(key) ? settings.get(key) : fallback };
    Module._load = function (id, ...args) {
        if (id === "vscode") return {
            workspace: { isTrusted: true, getConfiguration: () => configuration,
                workspaceFolders: [{ uri: { fsPath: workspace } }] },
            window: { showWarningMessage: async () => undefined, showInformationMessage: async () => undefined },
            env: { openExternal: async () => true },
            Uri: { parse: value => ({ toString: () => value }) },
            Disposable: class { constructor(call) { this.call = call; } dispose() { this.call?.(); } },
        };
        return originalLoad.call(this, id, ...args);
    };
    const { DshRuntime } = require(join(resolve(dirname(script), ".."), "dist/dshRuntime"));
    const { buildComposition } = require(join(resolve(dirname(script), ".."), "dist/recovery/composition"));
    Module._load = originalLoad;

    const composition = await buildComposition({
        command: shim,
        resolvedPath: shim,
        source: "configured",
        version: "0.1.5-rc.1",
        launcherArgs: [],
        appArgs: ["web", "--no-open", "--port", String(adoptPort)],
        workspaceRoot: workspace,
        dshHome: process.env.DSH_HOME,
        profile: "web",
    });
    assert.equal(composition.profile, "web", "the fixture composition must resolve the web profile");

    // ---- cases 2 and 3: the adoption decision itself, stubbed and synchronous ----
    // A fake receiver carries only what adoptExistingRuntime touches. The prototype is the real
    // class's, so this exercises the shipped decision rather than a re-implementation of it.
    const makeReceiver = recordedHash => {
        const logs = [];
        const statuses = [];
        const confirms = [];
        const recovers = [];
        let endpoint;
        let harnessStarts = 0;
        // Prototype-backed: the stubs above override what they stub, and anything else the real
        // methods call (adoptExistingRuntime, beginUnexpectedExitRecovery) resolves to the
        // shipped class code instead of missing on a plain object.
        return Object.assign(Object.create(DshRuntime.prototype), {
            configuration: () => configuration,
            output: { appendLine: message => logs.push(String(message)) },
            runtimeLock: recordedHash === "absent" ? undefined : { record: { compositionHash: recordedHash } },
            findExistingRuntime: async () => endpoint,
            setRuntimeEndpoint: value => { endpoint = value; },
            setStatus: status => statuses.push(status),
            harnessState: { start: () => { harnessStarts += 1; } },
            recoverySession: { confirm: async value => { confirms.push(value); },
                recover: async value => { recovers.push(value); return { status: "unrecoverable", message: "stub" }; } },
            startedByExtension: false,
            disposed: false,
            automaticRecoveryInFlight: false,
            recoveryEnabled: () => true,
            lastRecoveryComposition: composition,
            probe: value => { endpoint = value; },
            logs,
            statuses,
            confirms,
            recovers,
            harnessStarts: () => harnessStarts,
        });
    };

    // Case 2: a healthy Runtime answers, but its recorded hash is not ours.
    {
        const receiver = makeReceiver("f".repeat(64));
        receiver.probe({ baseUrl: `http://127.0.0.1:${adoptPort}` });
        const adopted = await DshRuntime.prototype.adoptExistingRuntime.call(receiver, composition);
        assert.equal(adopted, false, "a mismatched composition hash must not be adopted");
        assert.ok(receiver.logs.some(line => line.includes("different composition")),
            "the mismatch must be reported as a different composition");
        assert.equal(receiver.statuses.length, 0, "a refused adoption must not publish a running status");
        assert.equal(receiver.harnessStarts(), 0, "a refused adoption must not start Remote state");
        assert.equal(receiver.confirms.length, 0, "a refused adoption must not confirm a recovery session");
        assert.equal(receiver.startedByExtension, false, "a refused adoption must not claim runtime ownership");
        console.log("PASS adopt-mismatch: healthy Runtime with a different composition hash is reported, not adopted");
    }

    // Case 2b: a healthy Runtime with no composition evidence at all (design 69).
    {
        const receiver = makeReceiver("absent");
        receiver.probe({ baseUrl: `http://127.0.0.1:${adoptPort}` });
        const adopted = await DshRuntime.prototype.adoptExistingRuntime.call(receiver, composition);
        assert.equal(adopted, false, "a Runtime without composition evidence must not be adopted");
        assert.ok(receiver.logs.some(line => line.includes("carries no composition evidence")),
            "the missing evidence must be reported");
        assert.equal(receiver.statuses.length, 0, "a refused adoption must not publish a running status");
        console.log("PASS adopt-no-evidence: healthy Runtime without a composition hash is reported, not adopted");
    }

    // Case 3: the same healthy listener, now with proof that it is OUR composition -> adopted.
    {
        const receiver = makeReceiver(composition.compositionHash);
        receiver.probe({ baseUrl: `http://127.0.0.1:${adoptPort}`, launchUrl: `http://127.0.0.1:${adoptPort}/?token=abcdef` });
        const adopted = await DshRuntime.prototype.adoptExistingRuntime.call(receiver, composition);
        assert.equal(adopted, true, "a matching composition hash must be adopted");
        assert.ok(receiver.logs.some(line => line.includes("adopted an already-healthy Runtime")),
            "a taken adoption must be logged");
        assert.deepEqual(receiver.statuses, [{ state: "running", url: `http://127.0.0.1:${adoptPort}` }],
            "adoption must publish exactly one running status for the adopted endpoint");
        assert.equal(receiver.harnessStarts(), 1, "adoption must start Remote state for the adopted Runtime");
        assert.deepEqual(receiver.confirms, [composition],
            "adoption must confirm the recovery session against the adopted composition");
        assert.equal(receiver.startedByExtension, false, "an adopted Runtime was not started by this extension");
        // beginUnexpectedExitRecovery returns on adoption, so the search phase is never entered.
        assert.equal(receiver.logs.some(line => line.includes("searching")), false,
            "adoption must not enter the recovery search phase");
        console.log("PASS adopt-match: healthy Runtime with our composition hash is adopted without a search");
    }

    // Wiring pin: the REAL beginUnexpectedExitRecovery must try adoption first and return
    // without recovering when it succeeds, and must fall through to recoverySession.recover
    // when the probe declines. This is what breaks if someone removes the call site.
    {
        const receiver = makeReceiver(composition.compositionHash);
        receiver.probe({ baseUrl: `http://127.0.0.1:${adoptPort}` });
        DshRuntime.prototype.beginUnexpectedExitRecovery.call(receiver, workspace);
        await sleep(50);
        assert.deepEqual(receiver.confirms, [composition],
            "the unexpected-exit path must adopt a matching healthy Runtime before searching");
        assert.equal(receiver.recovers.length, 0,
            "an adopted Runtime must not enter the recovery search");
        console.log("PASS adopt-wiring: the unexpected-exit path adopts before any search");
    }
    {
        const receiver = makeReceiver(composition.compositionHash); // no probe: nothing listening
        DshRuntime.prototype.beginUnexpectedExitRecovery.call(receiver, workspace);
        await sleep(50);
        assert.deepEqual(receiver.recovers, [composition],
            "a declined adoption must hand the composition to the recovery search");
        console.log("PASS adopt-wiring-decline: a declined probe falls through to the recovery search");
    }

    // ---- case 4: the real DshRuntime end to end, unexpected exit after a healthy start ----
    // The fixture comes up once (so the FIRST start really succeeds), then dies; every later
    // boot dies instantly. The three raw retries therefore exhaust (~21s) and the
    // unexpected-exit path runs - the only place the adopt-before-search step is wired.
    const logs = [];
    const output = { appendLine: message => logs.push(String(message)), append: () => {}, show() {},
        dispose: () => {}, clear: () => {}, replace: () => {}, hide: () => {} };
    const runtime = new DshRuntime(output, storage);
    const dieFile = join(directory, ".die");
    const adoptedNow = () => logs.some(line => line.includes("adopted an already-healthy Runtime"));
    const ladderExhausted = () => logs.some(line => line.includes("Runtime recovery exhausted"));

    let settled = false;
    let dieSignaled = false;
    const watch = setInterval(() => {
        const status = runtime.getStatus();
        // The initial start must reach "running" first; then signal the fixture to die so the
        // unexpected exit happens at a deterministic point (after the extension saw it healthy).
        if (!dieSignaled && status.state === "running") {
            dieSignaled = true;
            void writeFile(dieFile, "now").catch(() => {});
        }
        // Settle on TERMINAL states only: adopting, or the recovery session's unrecoverable
        // conclusion. Retry attempts surface transient error states that are NOT terminal, and
        // settling on one would assert on a moving snapshot.
        if (adoptedNow() || (status.state === "error" && status.recovery?.phase === "unrecoverable")) {
            settled = true;
        }
    }, 100);
    const started = runtime.start(workspace).then(
        () => undefined,
        error => { logs.push("start rejected: " + String(error)); },
    );
    const deadline = Date.now() + 90_000;
    while (!settled && Date.now() < deadline) await sleep(100);
    clearInterval(watch);
    // Capture BEFORE stop(): stop() resets the transient status view. Give the final status
  // write a beat after the watch fires so the terminal view is the one captured.
    await sleep(500);
    const preStop = runtime.getStatus();
    await runtime.stop().catch(error => logs.push("stop failed: " + String(error)));
    await started;
    await sleep(300);

    console.log("--- runtime log (adoption/recovery lines) ---");
    for (const line of logs.filter(text => text.includes("adopt") || text.includes("recovery") || text.includes("exited"))) {
        console.log("  " + line);
    }
    console.log("--- pre-stop status ---");
    console.log("  " + JSON.stringify(preStop));

    // The claim under test: with nothing to adopt, the adopt probe declines and recovery
    // proceeds normally. Boot depth is governed by pre-existing Oracle abort behavior, so it
    // is reported, not asserted.
    const logsRoot = join(storage, "recovery", "logs");
    const bootLogs = await readdir(logsRoot, { recursive: true }).then(
        entries => entries.filter(entry => entry.endsWith(".log")),
        () => [],
    );
    console.log("  boot logs written by the search: " + bootLogs.length);
    assert.ok(dieSignaled, "the initial start must reach running before the unexpected exit");
    assert.ok(ladderExhausted(),
        "the raw retry ladder must exhaust so the unexpected-exit path (and its adopt probe) runs");
    assert.equal(adoptedNow(), false, "no adoption may happen when nothing was listening");
    assert.ok(preStop.recovery?.sessionId,
        "the unexpected-exit path must open a recovery session when adoption declines");
    assert.equal(preStop.state, "error",
        "a declined adoption must end in a reported error, never a false running state");
    console.log("PASS adopt-absent: nothing to adopt -> probe declined, recovery session ran and reported the failure");

    await runtime.dispose();
    console.log("PASS verify-adopt: adoption is taken only on matching composition evidence");
    // Every assertion has run. The probe server and the fake Runtime child keep handles alive,
    // so exit explicitly instead of waiting for the loop to drain (which never happens).
    process.exit(0);
}
