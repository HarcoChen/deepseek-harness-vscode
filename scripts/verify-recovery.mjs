#!/usr/bin/env node
// Process-level recovery smoke. Every fixture owns a fresh temp home/storage.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

if (!process.argv.includes("--worker")) {
    const directory = await mkdtemp(join(tmpdir(), "dsh-recovery-verify-"));
    try {
        const child = spawn(process.execPath, [script, "--worker"], {
            env: {
                ...process.env,
                TMPDIR: directory,
                TMP: directory,
                TEMP: directory,
                DSH_RECOVERY_VERIFY_DIRECTORY: directory,
            },
            stdio: "inherit",
        });
        process.exitCode = await new Promise((done, reject) => {
            child.once("error", reject);
            child.once("exit", code => done(code ?? 1));
        });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
} else {
    const directory = process.env.DSH_RECOVERY_VERIFY_DIRECTORY;
    assert.ok(directory, "worker must receive an isolated directory");
    assert.equal(resolve(tmpdir()), resolve(directory), "tmpdir must be redirected to the smoke directory");

    const require = createRequire(import.meta.url);
    const {
        buildComposition,
    } = require(join(resolve(dirname(script), ".."), "dist/recovery/composition"));
    const { RecoveryDiagnostics } = require(join(resolve(dirname(script), ".."), "dist/recovery/diagnostics"));
    const { FixExecutor } = require(join(resolve(dirname(script), ".."), "dist/recovery/fixExecutor"));
    const { HealthOracle } = require(join(resolve(dirname(script), ".."), "dist/recovery/healthOracle"));
    const { RecoveryLedgerStore } = require(join(resolve(dirname(script), ".."), "dist/recovery/ledger"));
    const { RecoverySession } = require(join(resolve(dirname(script), ".."), "dist/recovery/recoverySession"));
    const { SandboxManager } = require(join(resolve(dirname(script), ".."), "dist/recovery/sandbox"));

    const fixturePath = join(directory, "fixture.cjs");
    await writeFile(fixturePath, `
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

function bundles() {
  try {
    const file = path.join(process.env.DSH_HOME, "profiles", "web", "package.json");
    return JSON.parse(fs.readFileSync(file, "utf8")).dsh?.profile?.bundles ?? [];
  } catch (error) {
    console.error("fixture manifest error", error.message);
    return ["@fixture/bad"];
  }
}

if (process.env.RECOVERY_VERIFY_MODE === "transient" &&
    !fs.existsSync(process.env.RECOVERY_VERIFY_MARKER)) {
  fs.writeFileSync(process.env.RECOVERY_VERIFY_MARKER, "failed-once");
  console.error("transient fixture failure");
  process.exit(17);
}

const selected = bundles();
if (process.env.RECOVERY_VERIFY_MODE === "interaction") {
  if (selected.includes("@fixture/good") && selected.includes("@fixture/bad")) {
    console.error("interaction failure");
    process.exit(29);
  }
} else if (selected.includes("@fixture/bad")) {
  console.error("bad bundle activated");
  process.exit(23);
}

const server = http.createServer((request, response) => {
  if (request.method !== "POST" || request.url !== "/api/session/list") {
    response.statusCode = 404;
    response.end();
    return;
  }
  let body = "";
  request.setEncoding("utf8");
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    let parsed;
    try { parsed = JSON.parse(body); } catch {
      response.statusCode = 400;
      response.end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      type: "server-response",
      rpcId: parsed.rpcId,
      result: { ok: true, value: { items: [] } },
    }));
  });
});

const stop = () => server.close(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
server.listen(0, "127.0.0.1", () => {
  console.log("http://127.0.0.1:" + server.address().port);
});
`, { encoding: "utf8", mode: 0o600 });

    const makeFixture = async (name, bundles) => {
        const root = join(directory, name);
        const dshHome = join(root, "home");
        const profile = join(dshHome, "profiles", "web");
        const storage = join(root, "storage");
        await mkdir(join(profile, "node_modules", "@fixture", "good"), { recursive: true });
        await mkdir(join(profile, "node_modules", "@fixture", "bad"), { recursive: true });
        await writeFile(join(profile, "node_modules", "@fixture", "good", "package.json"), JSON.stringify({ name: "@fixture/good" }));
        await writeFile(join(profile, "node_modules", "@fixture", "bad", "package.json"), JSON.stringify({ name: "@fixture/bad" }));
        await writeFile(join(profile, "package.json"), JSON.stringify({
            name: "fixture-profile",
            dsh: { profile: { bundles },
            },
        }, null, 2) + "\n");
        return { root, dshHome, profile, storage };
    };

    const makeComposition = async (fixture, source) => buildComposition({
        command: process.execPath,
        source: "fixture",
        launcherArgs: [fixturePath],
        appArgs: [fixturePath],
        workspaceRoot: join(fixture.root, "workspace"),
        dshHome: fixture.dshHome,
        profile: "web",
    });

    const runSession = async (fixture, source, mode) => {
        const diagnostics = new RecoveryDiagnostics(fixture.storage);
        const ledger = new RecoveryLedgerStore(fixture.storage);
        const fixes = new FixExecutor(ledger);
        const oracle = new HealthOracle(
            new SandboxManager(fixture.root),
            {
                timeoutMs: 8_000,
                diagnostics,
            },
        );
        const session = new RecoverySession({
            maxBoots: 8,
            oracle,
            ledger,
            fixes,
        });
        if (mode) {
            process.env.RECOVERY_VERIFY_MODE = mode;
            process.env.RECOVERY_VERIFY_MARKER = join(fixture.root, "transient.marker");
        } else {
            delete process.env.RECOVERY_VERIFY_MODE;
            delete process.env.RECOVERY_VERIFY_MARKER;
        }
        const composition = await makeComposition(fixture, source);
        const outcome = await session.recover(composition, "fixture startup failed");
        return { composition, outcome, diagnostics, fixes, ledger, session };
    };

    const bundleFixture = await makeFixture("bundle", ["@fixture/good", "@fixture/bad"]);
    const bundleRun = await runSession(bundleFixture, fixturePath);
    assert.equal(bundleRun.outcome.status, "candidate", "bad bundle must produce a persisted candidate fix");
    assert.equal(bundleRun.outcome.fix?.kind, "disable-profile-bundles");
    assert.deepEqual(bundleRun.outcome.fix?.targetIds, ["@fixture/bad"]);
    const changedManifest = JSON.parse(await readFile(join(bundleFixture.profile, "package.json"), "utf8"));
    assert.deepEqual(changedManifest.dsh.profile.bundles, ["@fixture/good"]);

    const changed = await makeComposition(bundleFixture, fixturePath);
    const retryVariant = {
        id: "real-after-fix",
        kind: "v1-reproduce",
        parentHash: changed.compositionHash,
        assumption: "Verify the persisted fix with the exact post-fix composition.",
        composition: changed,
    };
    // Recreate the public health boundary for the final post-fix verification.
    const postFixOracle = new HealthOracle(new SandboxManager(bundleFixture.root), { timeoutMs: 8_000 });
    const postFix = await postFixOracle.evaluate(changed, retryVariant);
    assert.equal(postFix.verdict, "healthy", "post-fix composition must pass the real process/RPC probe");
    await bundleRun.session.confirm(changed, bundleRun.outcome.attribution);
    let ledger = await bundleRun.ledger.read();
    assert.equal(ledger.state.clean, true);
    assert.equal(ledger.state.lastKnownGood.compositionHash, changed.compositionHash);

    const restored = await bundleRun.fixes.restore();
    assert.deepEqual(restored, [bundleRun.outcome.fix.id]);
    const restoredManifest = JSON.parse(await readFile(join(bundleFixture.profile, "package.json"), "utf8"));
    assert.deepEqual(restoredManifest.dsh.profile.bundles, ["@fixture/good", "@fixture/bad"]);
    console.log("PASS bad-bundle-auto-recover: sandbox boot, session/list, profile isolation, LKG, and restore");

    const transientFixture = await makeFixture("transient", []);
    const transientRun = await runSession(transientFixture, fixturePath, "transient");
    assert.equal(transientRun.outcome.status, "retry", "transient failure must be resolved by the second V1 probe");
    assert.equal(transientRun.outcome.fix, undefined);
    await transientRun.session.confirm(transientRun.composition, transientRun.outcome.attribution);
    ledger = await transientRun.ledger.read();
    assert.equal(ledger.state.clean, true);
    assert.equal(ledger.state.entries.length, 0, "transient recovery must not persist a file fix");
    console.log("PASS transient-v1: second exact-composition probe succeeds without mutation");

    const corruptFixture = await makeFixture("corrupt", []);
    const corruptLedger = new RecoveryLedgerStore(corruptFixture.storage);
    await mkdir(dirname(corruptLedger.path), { recursive: true });
    await writeFile(corruptLedger.path, "{not-json", "utf8");
    const corruptRun = await runSession(corruptFixture, fixturePath);
    assert.equal(corruptRun.outcome.status, "unrecoverable");
    assert.equal(corruptRun.outcome.sessionId, "ledger-corrupt");
    assert.equal(await readFile(corruptLedger.path, "utf8"), "{not-json");
    console.log("PASS ledger-corrupt: original ledger preserved and no sandbox fix applied");

    const interactionFixture = await makeFixture("interaction", ["@fixture/good", "@fixture/bad"]);
    const interactionRun = await runSession(interactionFixture, fixturePath, "interaction");
    assert.equal(interactionRun.outcome.status, "unrecoverable",
        "a non-monotonic failure must not be persisted as a bundle fix");
    assert.equal(interactionRun.outcome.fix, undefined);
    const interactionManifest = JSON.parse(await readFile(join(interactionFixture.profile, "package.json"), "utf8"));
    assert.deepEqual(interactionManifest.dsh.profile.bundles, ["@fixture/good", "@fixture/bad"],
        "the profile manifest must stay untouched when the re-add confirmation is healthy");
    const interactionLedger = await interactionRun.ledger.read();
    assert.ok(interactionLedger.state.sessions.every(session => session.budget.skipped.length > 0),
        "duplicate variants dropped by the planner must be recorded in budget.skipped");
    console.log("PASS interaction-rejected: healthy re-add blocks an unfounded bundle fix");

    await sleep(50);
}
