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
    const { FixConflictError, FixExecutor } = require(join(resolve(dirname(script), ".."), "dist/recovery/fixExecutor"));
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
// Only the fully-removed baseline is always healthy; the [good]-only set boots ONCE (so the
// search finds a healthy candidate and apply() writes) and fails on the next boot, which is
// what the post-write sandbox re-verification must catch. Any set still holding @fixture/bad
// always fails, so the fix is genuinely attributable to that bundle.
if (process.env.RECOVERY_VERIFY_MODE === "rollback") {
  if (selected.includes("@fixture/bad")) {
    console.error("rollback fixture: @fixture/bad is unbootable");
    process.exit(31);
  }
  if (selected.length > 0) {
    const stamp = process.env.RECOVERY_VERIFY_MARKER + ".once";
    if (fs.existsSync(stamp)) {
      console.error("rollback fixture: the written manifest does not boot");
      process.exit(32);
    }
    fs.writeFileSync(stamp, "booted-once");
  }
}

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

    // Write-time sandbox re-verification (design 794-795): a fix is only persisted after the
    // CHANGED manifest has been proven bootable. Here the removed bundle turns out to be
    // load-bearing for the remaining set, so the post-fix composition still fails. The fix must
    // be rolled back immediately instead of leaving the user's profile broken for a real start.
    const rollbackFixture = await makeFixture("rollback", ["@fixture/good", "@fixture/bad"]);
    const rollbackRun = await runSession(rollbackFixture, fixturePath, "rollback");
    assert.notEqual(rollbackRun.outcome.status, "candidate",
        "a fix whose post-write manifest does not boot must never be handed back as a candidate");
    const rollbackManifest = JSON.parse(await readFile(join(rollbackFixture.profile, "package.json"), "utf8"));
    assert.deepEqual(rollbackManifest.dsh.profile.bundles, ["@fixture/good", "@fixture/bad"],
        "a rejected fix must leave the user's original manifest bytes intact");
    // The rolled-back entry must be accounted for, not left dangling as an applied fix that a
    // later restore would try to revert against a manifest that never actually changed.
    const rollbackLedger = await rollbackRun.ledger.read();
    assert.equal(rollbackLedger.state.clean, true,
        "a rolled-back fix must leave the ledger with no unfinished session");
    assert.ok(rollbackLedger.state.entries.every(entry => entry.status !== "applied"),
        "an unverified fix must never be recorded as applied");
    console.log("PASS write-time-verify-rollback: an unbootable manifest is rolled back, not persisted");
    // Restore conflicts (design 16.1): a fix whose backing file drifted after it was applied
    // must be reported as conflicted, must not be reverted, and must not silently swallow the
    // entries restored around it.
    const conflictFixture = await makeFixture("conflict", ["@fixture/good", "@fixture/bad"]);
    const conflictRun = await runSession(conflictFixture, fixturePath);
    assert.equal(conflictRun.outcome.status, "candidate", "the bad bundle must still be isolated");
    const conflictManifestPath = join(conflictFixture.profile, "package.json");
    // Simulate a user edit landing after the automated fix was applied.
    const edited = JSON.parse(await readFile(conflictManifestPath, "utf8"));
    edited.dsh.profile.bundles = ["@fixture/good", "@fixture/bad", "@fixture/later-addition"];
    await writeFile(conflictManifestPath, `${JSON.stringify(edited, null, 2)}\n`, "utf8");
    const conflictError = await conflictRun.fixes.restore().then(() => undefined, error => error);
    assert.ok(conflictError, "a drifted manifest must surface a restore conflict");
    assert.deepEqual(conflictError.restored, [], "nothing may be reported as restored when the target drifted");
    const afterConflict = JSON.parse(await readFile(conflictManifestPath, "utf8"));
    assert.deepEqual(afterConflict.dsh.profile.bundles, ["@fixture/good", "@fixture/bad", "@fixture/later-addition"],
        "a conflicted restore must leave the user's newer file untouched");
    const conflictLedger = await conflictRun.ledger.read();
    const conflictedEntry = conflictLedger.state.entries.find(entry => entry.id === conflictRun.outcome.fix.id);
    assert.equal(conflictedEntry.status, "conflicted", "the entry must be recorded, not left as applied");
    console.log("PASS restore-conflict: drifted manifest blocks the revert and is recorded");

    // Restore with an unreadable backup (design 16.1 "restore-conflict"): a missing backup must
    // be reported as a conflict for THAT entry while every other entry is still attempted and
    // still accounted for. An escaping throw would strand the rest with no record.
    const missingFixture = await makeFixture("missing-backup", ["@fixture/good", "@fixture/bad"]);
    const missingRun = await runSession(missingFixture, fixturePath);
    assert.equal(missingRun.outcome.status, "candidate", "the bad bundle must be isolated first");
    const backupFile = join(missingRun.ledger.directory, "backups", `${missingRun.outcome.fix.id}.json`);
    await rm(backupFile, { force: true });
    const missingError = await missingRun.fixes.restore().then(() => undefined, error => error);
    assert.ok(missingError, "an unreadable backup must surface a restore conflict");
    const missingLedger = await missingRun.ledger.read();
    const stranded = missingLedger.state.entries.find(entry => entry.id === missingRun.outcome.fix.id);
    assert.equal(stranded.status, "conflicted",
        "an entry whose backup cannot be read must be marked conflicted, not left as applied");
    assert.ok(String(missingError.message).includes("backup"),
        "the conflict must name the unavailable backup so the user can diagnose it");
    assert.deepEqual(missingError.restored, [],
        "an entry with no readable backup must not be reported as restored");
    console.log("PASS restore-missing-backup: unreadable backup is recorded as a conflict");

    // Restore when the TARGET manifest itself is gone (design 16.1 "restore-conflict"): the
    // user deleted or renamed the profile manifest after the automated fix landed. Reading the
    // target is part of the per-entry attempt, so this must be recorded as a conflict for THAT
    // entry and the remaining entries must still be reverted — an escaping ENOENT would strand
    // every earlier entry as "applied" and hide the ones that did come back.
    const targetFixture = await makeFixture("missing-target", ["@fixture/good", "@fixture/bad"]);
    const targetRun = await runSession(targetFixture, fixturePath);
    assert.equal(targetRun.outcome.status, "candidate", "the bad bundle must be isolated first");
    const targetManifest = join(targetFixture.profile, "package.json");
    await rm(targetManifest, { force: true });
    const targetError = await targetRun.fixes.restore().then(() => undefined, error => error);
    assert.ok(targetError, "a missing target manifest must surface a restore conflict");
    assert.ok(targetError instanceof FixConflictError,
        "the conflict must be reported as a recovery conflict, not a raw filesystem error");
    const targetLedger = await targetRun.ledger.read();
    const targetEntry = targetLedger.state.entries.find(entry => entry.id === targetRun.outcome.fix.id);
    assert.equal(targetEntry.status, "conflicted",
        "an entry whose target manifest is gone must be marked conflicted, not left as applied");
    assert.deepEqual(targetError.restored, [],
        "an entry whose target is gone must not be reported as restored");
    console.log("PASS restore-missing-target: deleted manifest is recorded as a conflict");

    await sleep(50);
}
