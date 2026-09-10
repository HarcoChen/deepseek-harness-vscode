#!/usr/bin/env node
// Loopback Remote HTTP -> runtime goal adapter -> activation controller integration smoke.
// Usage: npx tsc -p tsconfig.json && node scripts/verify-review-goal.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const originalLoad = Module._load;
let DshRuntime;
try {
    Module._load = function (id, ...args) {
        return id === "vscode" ? {} : originalLoad.call(this, id, ...args);
    };
    ({ DshRuntime } = require("../dist/dshRuntime"));
} finally { Module._load = originalLoad; }
const { RemoteUnaryClient } = require("../dist/remote/unaryClient");
const { GoalActivationController } = require("../dist/goalActivation");
const queued = [];
let requests = 0;
const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const envelope = JSON.parse(body);
    assert.equal(envelope.method, "goals/get");
    assert.equal(envelope.payload.args.agentId, "session");
    requests++;
    const next = queued.shift();
    if (!next) {
        response.writeHead(500).end();
        return;
    }
    const value = await next.value;
    response.writeHead(200, { "content-type": "application/json" });
    // Undefined is omitted exactly as in the harness Gateway's invokeRpc.
    response.end(JSON.stringify({ type: "server-response", rpcId: envelope.rpcId,
        result: { ok: true, value } }));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const runtime = Object.create(DshRuntime.prototype);
runtime.apiClient = new RemoteUnaryClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, timeoutMs: 2000 });
const goal = { id: "goal", revision: 1, activation: "armed" };
const enqueue = value => queued.push({ value });
const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};
const failures = [];
async function scenario(label, run) {
    try { await run(); console.log(`PASS ${label}`); }
    catch (error) { failures.push(error); console.error(`FAIL ${label}: ${error.message}`); }
}
function view() {
    let ref = goal;
    let running = false;
    const pending = [];
    const controller = new GoalActivationController(sessionId => {
        const read = runtime.getGoalActivation(sessionId);
        pending.push(read);
        return read;
    }, () => {
        // Match ChatView's state publication: observe the projection again.
        controller.observe("session", ref, running);
    });
    return {
        controller,
        observe(nextRef = ref, nextRunning = running) {
            ref = nextRef; running = nextRunning;
            controller.observe("session", ref, running);
        },
        async settle() {
            await Promise.allSettled(pending.splice(0));
            await new Promise(resolve => setImmediate(resolve));
        },
        async settleLatest() {
            await pending.at(-1);
            await new Promise(resolve => setImmediate(resolve));
        },
        activation: () => controller.activationFor("session", ref),
    };
}
try {
    await scenario("null is normalized to absent activation", async () => {
        enqueue(null);
        assert.equal(await runtime.getGoalActivation("session"), undefined);
    });
    for (const absence of [undefined, null]) {
        await scenario(`${String(absence)} clears cached activation without repeated reads`, async () => {
            const state = view();
            try {
                enqueue(goal); state.observe(); await state.settle();
                assert.equal(state.activation(), "armed");
                const before = requests;
                enqueue(absence); state.observe(goal, true); await state.settle();
                assert.equal(state.activation(), undefined);
                assert.equal(requests, before + 1);
            } finally { state.controller.dispose(); }
        });
    }
    await scenario("old absent read cannot clear a newer activation event", async () => {
        const state = view();
        const old = deferred();
        try {
            enqueue(old.promise); state.observe();
            state.controller.accept({ sessionId: "session", goal });
            old.resolve(null); await state.settle();
            assert.equal(state.activation(), "armed");
        } finally { old.resolve(null); state.controller.dispose(); }
    });
    await scenario("old absent read cannot clear a newer projection revision", async () => {
        const state = view();
        const old = deferred();
        const newer = { ...goal, revision: 2, activation: "disarmed" };
        try {
            enqueue(old.promise); state.observe();
            enqueue(newer); state.observe(newer);
            await state.settleLatest();
            assert.equal(state.activation(), "disarmed");
            old.resolve(undefined); await state.settle();
            assert.equal(state.activation(), "disarmed");
        } finally { old.resolve(undefined); state.controller.dispose(); }
    });
    await scenario("malformed goal payload still rejects and preserves known activation", async () => {
        const state = view();
        try {
            enqueue(goal); state.observe(); await state.settle();
            enqueue({ ...goal, activation: "invalid" }); state.observe(goal, true); await state.settle();
            assert.equal(state.activation(), "armed");
            enqueue({ id: null, revision: 1, activation: "armed" });
            await assert.rejects(() => runtime.getGoalActivation("session"), /invalid goal activation/u);
        } finally { state.controller.dispose(); }
    });
} finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
}
if (failures.length) throw new AggregateError(failures, "Goal activation integration failed");
