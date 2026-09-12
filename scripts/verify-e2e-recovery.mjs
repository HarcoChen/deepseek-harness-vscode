#!/usr/bin/env node
// End-to-end integration smoke for PR#19 automatic recovery: drives the REAL DshRuntime
// (not the recovery module in isolation) against a genuinely broken DSH profile, and asserts
// the user-visible outcome: status transitions, the persisted profile fix, and restore.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const sleep = ms => new Promise(done => setTimeout(done, ms));

if (!process.argv.includes("--worker")) {
    const directory = await mkdtemp(join(tmpdir(), "dsh-e2e-recovery-"));
    try {
        const child = spawn(process.execPath, [script, "--worker"], {
            env: { ...process.env, TMPDIR: directory, TMP: directory, TEMP: directory,
                // homedir() is read from these at module-load time; point them at the fixture
                // so both the extension and the fake runtime resolve the same DSH home.
                USERPROFILE: directory, HOME: directory,
                // DSH_HOME is the supported whole-home redirect (dshRuntime.ts resolves the
                // launch composition from it); homedir() alone is not reliable on Windows.
                DSH_HOME: join(directory, ".dsh"),
                E2E_DIRECTORY: directory }, stdio: "inherit",
        });
        process.exitCode = await new Promise((done, reject) => {
            child.once("error", reject);
            child.once("exit", code => done(code ?? 1));
        });
    } finally {
        // Set E2E_KEEP=1 to keep the fixture (sandbox trees, ledger, diagnostics) for triage.
        if (process.env.E2E_KEEP !== "1") await rm(directory, { recursive: true, force: true });
        else console.log("fixture kept at " + directory);
    }
} else {
    const directory = process.env.E2E_DIRECTORY;
    assert.ok(directory);
    const require = createRequire(import.meta.url);

    // ---- isolated home + a broken profile: the "bad" bundle makes dsh exit non-zero ----
    const profileDir = join(directory, ".dsh", "profiles", "web");
    const storage = join(directory, "storage");
    const workspace = join(directory, "workspace");
    await mkdir(join(profileDir, "node_modules", "@fixture", "bad"), { recursive: true });
    await mkdir(join(profileDir, "node_modules", "@fixture", "good"), { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(join(profileDir, "node_modules", "@fixture", "bad", "package.json"), '{"name":"@fixture/bad"}');
    await writeFile(join(profileDir, "node_modules", "@fixture", "good", "package.json"), '{"name":"@fixture/good"}');
    const manifestPath = join(profileDir, "package.json");
    await writeFile(manifestPath, JSON.stringify({
        name: "fixture-profile", dsh: { profile: { bundles: ["@fixture/good", "@fixture/bad"] } },
    }, null, 2) + "\n");

    // A fake dsh launcher: fails when the bad bundle is active, healthy (real HTTP) otherwise.
    const fakeDsh = join(directory, "fake-dsh.cjs");
    await writeFile(fakeDsh, `const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
// The extension probes a custom command with --version before it will launch it.
if (process.argv.includes("--version")) {
  console.log("0.1.5-rc.1");
  process.exit(0);
}
function dshHome() {
  return process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || "", ".dsh");
}
function bundles() {
  try {
    const file = path.join(dshHome(), "profiles", "web", "package.json");
    return JSON.parse(fs.readFileSync(file, "utf8")).dsh?.profile?.bundles ?? [];
  } catch { return []; }
}
if (bundles().includes("@fixture/bad")) {
  console.error("bad bundle activated");
  process.exit(23);
}
const argv = process.argv.slice(2);
const portIndex = argv.indexOf("--port");
const requested = portIndex >= 0 ? Number(argv[portIndex + 1]) : 0;
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
`, { encoding: "utf8", mode: 0o600 });

    // A dsh-shaped launcher: answers --version itself (the extension probes any custom
    // command), then hands the real launch to node running the fake runtime.
    // The launcher must be a DIRECT .exe: the Oracle treats any non-.exe command as a cmd.exe
    // wrapper, whose descendant ownership Windows cannot verify, and it then defers cleanup and
    // aborts the whole search after a single boot. It must also answer --version itself, because
    // a custom command is version-probed before the extension will launch it. Build both into a
    // small native shim.
    const shimDir = join(directory, "shim");
    await mkdir(shimDir, { recursive: true });
    const shim = join(shimDir, "dsh.exe");
    const shimTarget = join(shimDir, "fake-dsh.cjs");
    await writeFile(shimTarget, await readFile(fakeDsh, "utf8"), { encoding: "utf8" });
    const nodeExe = process.execPath;
    await writeFile(join(shimDir, "shim.cs"), `using System;
using System.Diagnostics;
using System.IO;
using System.Text;
class DshShim {
    static int Main(string[] args) {
        foreach (var a in args) {
            if (a == "--version") { Console.WriteLine("0.1.5-rc.1"); return 0; }
        }
        var dir = AppDomain.CurrentDomain.BaseDirectory;
        var psi = new ProcessStartInfo(${JSON.stringify(nodeExe)},
            "\\"" + Path.Combine(dir, "fake-dsh.cjs") + "\\" " + JoinArgs(args));
        psi.UseShellExecute = false;
        var p = Process.Start(psi);
        p.WaitForExit();
        return p.ExitCode;
    }
    static string JoinArgs(string[] args) {
        var sb = new StringBuilder();
        foreach (var a in args) { sb.Append('\\"'); sb.Append(a.Replace("\\"", "\\\\\\"")); sb.Append('\\"'); sb.Append(' '); }
        return sb.ToString();
    }
}
`, { encoding: "utf8" });
    const csc = "C:\\\\Windows\\\\Microsoft.NET\\\\Framework64\\\\v4.0.30319\\\\csc.exe";
    const built = await new Promise((done, reject) => {
        const child = spawn(csc, ["/nologo", "/out:" + shim, join(shimDir, "shim.cs")],
            { stdio: ["ignore", "ignore", "pipe"] });
        let err = "";
        child.stderr.on("data", chunk => { err += chunk; });
        child.once("error", reject);
        child.once("exit", code => code === 0 ? done(true) : reject(new Error("csc failed: " + err)));
    });
    assert.ok(built && existsSync(shim), "the native launcher shim must build");

    const Module = require("node:module");
    const originalLoad = Module._load;
    const settings = new Map([
        ["recovery.enabled", process.env.E2E_DISABLE_RECOVERY !== "1"],
        ["recovery.autoPersistBundleIsolation", true],
        ["command", shim],
        ["commandArgs", ["web", "--no-open"]],
        ["autoStart", false],
        ["requestTimeoutMs", 5_000],
    ]);
    const configuration = { get: (key, fallback) => settings.has(key) ? settings.get(key) : fallback };
    Module._load = function (id, ...args) {
        if (id === "vscode") return {
            workspace: { isTrusted: true, getConfiguration: () => configuration,
                workspaceFolders: [{ uri: { fsPath: workspace } }] },
            window: { showWarningMessage: async () => undefined, showInformationMessage: async () => undefined },
            env: { openExternal: async () => true },
            Uri: { parse: value => ({ toString: () => value }) },
        };
        return originalLoad.call(this, id, ...args);
    };
    const { DshRuntime } = require(join(resolve(dirname(script), ".."), "dist/dshRuntime"));
    Module._load = originalLoad;

    const lines = [];
    const output = { appendLine: m => lines.push(String(m)), append: () => {}, show() {},
        dispose: () => {}, clear: () => {}, replace: () => {}, hide: () => {} };
    const runtime = new DshRuntime(output, storage);

    const seen = [];
    const deadline = Date.now() + 180_000;
    let settled;
    const watch = setInterval(() => {
        const status = runtime.getStatus();
        const last = seen[seen.length - 1];
        if (!last || last.state !== status.state || last.phase !== status.recovery?.phase) {
            seen.push({ state: status.state, phase: status.recovery?.phase, message: status.message });
        }
        if (status.state === "running" || status.state === "error" || Date.now() > deadline) {
            clearInterval(watch);
            settled = status;
        }
    }, 250);

    // Kick off the real, user-visible entry point.
    runtime.start(workspace).catch(error => lines.push("start rejected: " + String(error)));
    while (!settled) await sleep(250);
    await sleep(500);

    console.log("--- runtime log (recovery lines) ---");
    for (const line of lines.filter(l => l.includes("recovery") || l.includes("exited") || l.includes("discovered"))) {
        console.log("  " + line);
    }
    console.log("--- status transitions ---");
    for (const step of seen) console.log("  " + step.state + " / " + (step.phase ?? "-") + " : " + (step.message ?? ""));

    const after = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.deepEqual(after.dsh.profile.bundles, ["@fixture/good"],
        "the bad bundle must be isolated from the profile manifest");
    assert.ok(seen.some(s => s.phase === "recovered"),
        "recovery must reach the recovered phase");

    // Restore is guarded: the Runtime must be stopped first (a deliberate, user-visible rule).
    const refused = await runtime.restoreRecovery().then(() => undefined, error => error);
    assert.ok(refused, "restore must refuse while the Runtime is running");
    await runtime.stop();
    const restored = await runtime.restoreRecovery();
    assert.equal(restored.length, 1, "exactly one applied fix must be restored");
    const restoredManifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.deepEqual(restoredManifest.dsh.profile.bundles, ["@fixture/good", "@fixture/bad"],
        "restore must put the user's original bundle list back");
    console.log("PASS e2e-auto-recovery: broken profile recovered end-to-end and restored");

    const exported = await runtime.exportRecoveryDiagnostics();
    assert.ok(existsSync(exported), "the exported diagnostics directory must exist");
    // The export contract: a manifest, the ledger, the composition diff, and a conclusion.
    const manifest = JSON.parse(await readFile(join(exported, "manifest.json"), "utf8"));
    assert.equal(manifest.schemaVersion, 1, "the diagnostics manifest must carry its schema version");
    const exportedLedger = JSON.parse(await readFile(join(exported, "ledger.json"), "utf8"));
    assert.ok(exportedLedger.sessions.length >= 1, "the export must contain the recovery session");
    const conclusion = await readFile(join(exported, "conclusion.txt"), "utf8");
    assert.ok(conclusion.length > 0, "the export must explain what happened");
    // The report must describe the bundle fix that actually recovered the profile.
    assert.ok(await readFile(join(exported, "composition-diff.json"), "utf8"),
        "the export must include the composition diff");
    console.log("PASS e2e-diagnostics: recovery diagnostics exported to " + exported);

    await runtime.dispose();
    await sleep(200);
}
