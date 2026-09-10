#!/usr/bin/env node
// Integration: real CLI executables, PATH/npm-prefix discovery, startup arguments,
// versioned locks and owned-child shutdown; no downloads, model calls or user data.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), "..");
const pause = ms => new Promise(done => setTimeout(done, ms));
if (!process.argv.includes("--worker")) {
    if (process.platform === "win32") throw new Error("This executable-fixture smoke requires POSIX; run Windows validation separately.");
    for (const scenario of ["config-local", "config-pnpm", "config-managed", "local", "prefix", "old", "unknown", "missing", "newer", "npx-fallback", "timeout", "cancel", "explicit-old", "explicit-missing", "explicit-pnpm", "explicit-npx", "legacy-args", "legacy-version"]) {
        const directory = await mkdtemp(join(tmpdir(), "dsh-discovery-verify-"));
        try {
            const child = spawn(process.execPath, [script, "--worker", scenario], {
                env: { ...process.env, TMPDIR: directory, TMP: directory, TEMP: directory,
                    DSH_HOME: join(directory, "home"), DSH_DISCOVERY_VERIFY_DIRECTORY: directory }, stdio: "inherit",
            });
            const code = await new Promise((done, reject) => { child.once("error", reject); child.once("exit", done); });
            assert.equal(code, 0, `scenario ${scenario} failed`);
        } finally { await rm(directory, { recursive: true, force: true }); }
    }
} else {
    const directory = process.env.DSH_DISCOVERY_VERIFY_DIRECTORY;
    assert.ok(directory);
    assert.equal(resolve(tmpdir()), resolve(directory));
    const scenario = process.argv.at(-1);
    const bin = join(directory, "bin");
    const prefix = join(directory, "prefix");
    const marker = join(directory, "launched.json");
    const probeMarker = join(directory, "probe-started");
    await mkdir(bin);
    await mkdir(join(prefix, "bin"), { recursive: true });
    await symlink("/bin/ps", join(bin, "ps"));
    const executable = async (path, name, version) => writeFile(path, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) {
    fs.writeFileSync(${JSON.stringify(probeMarker)}, 'started');
    if (${JSON.stringify(version)} === 'hang') {
        fs.writeFileSync(${JSON.stringify(probeMarker)}, 'started');
        setInterval(() => {}, 1000);
    } else { console.log(${JSON.stringify(version)}); process.exit(0); }
} else {
if (args[0] === 'prefix') { console.log(${JSON.stringify(prefix)}); process.exit(0); }
if (args[0] === 'config') { console.log('https://registry.npmjs.org'); process.exit(0); }
fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({name:${JSON.stringify(name)}, args}));
setInterval(() => {}, 1000);
}
`, { mode: 0o700 });
    const localVersion = scenario === "old" || scenario === "explicit-old" || scenario === "prefix" ? "0.1.2-rc.1"
        : scenario === "unknown" ? "not a version" : scenario === "newer" ? "0.1.5-rc.2"
        : ["timeout", "cancel"].includes(scenario) ? "hang" : "0.1.5-rc.1";
    if (!["missing", "npx-fallback", "config-managed"].includes(scenario)) await executable(join(bin, "dsh"), "local", localVersion);
    if (scenario === "prefix") await executable(join(prefix, "bin", "dsh"), "prefix", "0.1.5-rc.1");
    if (scenario !== "config-managed") {
        await executable(join(bin, "npm"), "npm", "11.0.0");
        if (scenario !== "npx-fallback") await executable(join(bin, "pnpm"), "pnpm", "10.0.0");
        await executable(join(bin, "npx"), "npx", "11.0.0");
    }
    process.env.PATH = bin;
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    const defaults = manifest.contributes.configuration.properties;
    const settings = new Map([["enableCompaction", false], ["installWhenMissing", false]]);
    if (scenario.startsWith("config-")) settings.set("runtimeVersion", "0.1.2-rc.1");
    if (scenario === "config-pnpm") settings.set("command", "pnpm");
    if (scenario === "explicit-old") settings.set("command", join(bin, "dsh"));
    if (scenario === "explicit-missing") settings.set("command", join(bin, "absent-dsh"));
    if (scenario === "explicit-pnpm") settings.set("command", "pnpm");
    if (scenario === "explicit-npx") settings.set("command", "npx");
    if (scenario === "legacy-args") settings.set("commandArgs", ["dlx", "@deepseek-ai/dsh", "web", "--no-open", "--port", "49151"]);
    if (scenario === "legacy-version") settings.set("commandArgs", ["dlx", "@deepseek-ai/dsh@0.1.2-rc.1", "web", "--no-open"]);
    const configuration = {
        get: (key, fallback) => settings.has(key) ? settings.get(key) : defaults[`dsh.${key}`]?.default ?? fallback,
        inspect: key => ({ defaultValue: defaults[`dsh.${key}`]?.default, globalValue: settings.get(key) }),
    };
    const require = createRequire(import.meta.url);
    const Module = require("node:module");
    const originalLoad = Module._load;
    Module._load = function (id, ...args) {
        if (id === "vscode") return {
            workspace: { isTrusted: true, getConfiguration: () => configuration },
            window: { withProgress: async (_options, action) => action({ report() {} }, { onCancellationRequested() { return { dispose() {} }; } }) },
            ProgressLocation: { Notification: 15 },
        };
        return originalLoad.call(this, id, ...args);
    };
    const { DshRuntime } = require(join(root, "dist/dshRuntime"));
    Module._load = originalLoad;
    const runtime = new DshRuntime({ appendLine() {}, append() {} }, join(directory, "storage"));
    // Exclude external Runtime discovery/RPC only; launcher selection, subprocess
    // version probes, actual spawn, argv and lock lifecycle remain production code.
    runtime.findExistingRuntime = async () => undefined;
    runtime.harnessState.start = () => {};
    runtime.waitForReady = async () => {
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
            try { await readFile(marker); return "http://127.0.0.1:1"; } catch { await pause(20); }
        }
        throw new Error("CLI never launched");
    };
    try {
        if (scenario.startsWith("config-")) {
            await assert.rejects(() => runtime.start(directory), /dsh\.runtimeVersion.*0\.1\.2-rc\.1.*0\.1\.5-rc\.1/u);
            await assert.rejects(() => runtime.diagnoseEnvironment(directory), /dsh\.runtimeVersion/u);
            await assert.rejects(() => readFile(probeMarker), { code: "ENOENT" });
            await assert.rejects(() => readFile(marker), { code: "ENOENT" });
            await assert.rejects(() => readFile(join(directory, "dsh-runtime.lock")), { code: "ENOENT" });
        } else if (scenario === "cancel") {
            const starting = assert.rejects(() => runtime.start(directory), /cancelled/u);
            const deadline = Date.now() + 3000;
            while (Date.now() < deadline) {
                try { await readFile(probeMarker); break; } catch { await pause(20); }
            }
            assert.equal(await readFile(probeMarker, "utf8"), "started");
            await runtime.stop();
            await starting;
            assert.equal(runtime.getStatus().state, "stopped");
            await assert.rejects(() => readFile(marker), { code: "ENOENT" });
        } else if (["explicit-old", "explicit-missing", "legacy-version"].includes(scenario)) {
            await assert.rejects(() => runtime.start(directory), scenario === "explicit-missing" ? /absent-dsh/u : /0\.1\.2-rc\.1/u);
            await assert.rejects(() => readFile(marker), { code: "ENOENT" });
            await assert.rejects(() => readFile(join(directory, "dsh-runtime.lock")), { code: "ENOENT" });
        } else {
            await runtime.start(directory);
            const launched = JSON.parse(await readFile(marker, "utf8"));
            const expected = scenario === "prefix" ? "prefix" : ["explicit-npx", "npx-fallback"].includes(scenario) ? "npx"
                : ["local", "legacy-args"].includes(scenario) ? "local" : "pnpm";
            assert.equal(launched.name, expected, "default discovery must prefer a compatible local CLI and otherwise pin the fallback");
            const appArgs = scenario === "legacy-args" ? ["web", "--no-open", "--port", "49151"] : ["web", "--no-open", "--port", "0"];
            assert.deepEqual(launched.args, expected === "pnpm" ? ["dlx", "@deepseek-ai/dsh@0.1.5-rc.1", ...appArgs]
                : expected === "npx" ? ["--yes", "@deepseek-ai/dsh@0.1.5-rc.1", ...appArgs] : appArgs);
            const lock = JSON.parse(await readFile(join(directory, "dsh-runtime.lock"), "utf8"));
            assert.equal(lock.runtimeVersion, "0.1.5-rc.1");
            assert.equal(lock.runtimePid, runtime.child.pid);
        }
        console.log(`PASS ${scenario}: launcher selection, actual argv and versioned lock`);
    } finally { await runtime.dispose(); }
    await assert.rejects(() => readFile(join(directory, "dsh-runtime.lock")), { code: "ENOENT" });
}
