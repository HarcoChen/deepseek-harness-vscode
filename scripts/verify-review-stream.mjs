#!/usr/bin/env node
/** Replay RC follow/history cuts through the compiled coordinator, store, chat and trace.
 * Usage: npx tsc -p tsconfig.json && node scripts/verify-review-stream.mjs
 * No network, persisted state, model calls, or editor process are needed.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { RemoteStateCoordinator } = require("../dist/remote/stateCoordinator");
const { HarnessSessionStore } = require("../dist/sessionStore");
const { projectChatMessages } = require("../dist/chatState");
const { projectSessionTrace } = require("../dist/traceProjector");

const sessionId = "review-stream";
const timed = { time: 10, chunk: { type: "text-delta", index: 0, text: "Hello" } };
const active = { attemptId: "attempt-1", startedAfterSeq: -1, turn: 1, step: 1,
    nextIndex: 1, stream: [{ type: "chunk", ...timed }] };
const settlement = { type: "assistant/message", seq: 0, time: 20, surfaceOp: "append",
    data: { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "text", text: "Hello" }] }, stream: active.stream } };
const opening = (records, cursor = 0) => ({ type: "snapshot", header: { id: sessionId, version: 3, createdAt: 1 },
    cursor, records: records.map(event => ({ type: "event", event })), hasMore: false,
    projections: { asOfSeq: cursor, values: {} }, assistantStream: { revision: 2, activeAttempt: active } });
const end = (outcome = { kind: "committed", seq: 0, eventType: "assistant/message" }) => ({
    type: "assistant-stream", frame: { type: "end", revision: 3, index: 1, attemptId: active.attemptId, outcome } });

async function follow(frames, inspect = () => {}, prepare = () => {}) {
    const abort = new AbortController();
    const connection = { unary: {}, onConnected() {}, onEvent() {}, onStateChange() {},
        async *open() {
            for (const frame of frames) { yield frame; inspect(coordinator, frame); }
            abort.abort();
        } };
    const coordinator = new RemoteStateCoordinator(connection);
    prepare(coordinator);
    // Replay the transport seam without starting unrelated catalog/control streams.
    await coordinator.consumeSession({ kind: "session", sessionId }, abort.signal);
    return coordinator.sessions.get(sessionId);
}

const scenarios = [
    ["opening durable settlement reconciles committed end", async () => {
        const snapshot = await follow([opening([settlement]), end()], (coordinator, frame) => {
            if (frame.type === "snapshot") assert.equal(coordinator.sessions.get(sessionId).assistantStream, undefined);
        });
        assert.equal(projectChatMessages(snapshot, []).filter(row => row.role === "assistant").length, 1);
        assert.equal(projectSessionTrace(snapshot).rows.filter(row => row.eventType === "assistant/message").length, 1);
    }],
    ["history arriving after the opening cut restores settlement metadata", async () => {
        const snapshot = await follow([opening([]), end()], (coordinator, frame) => {
            if (frame.type === "snapshot") coordinator.sessions.rebaseline(sessionId, { events: [{ event: settlement }] });
        });
        assert.equal(snapshot.assistantStream, undefined);
    }],
    ["a retained later retry cannot mask the settlement at the opening cursor", async () => {
        const attempt = { type: "assistant/attempt", seq: 0, time: 20,
            data: { turn: 1, step: 1, stream: active.stream } };
        const snapshot = await follow([opening([attempt]), end({ kind: "committed", seq: 0, eventType: "assistant/attempt" })],
            undefined, coordinator => {
                for (let seq = 1; seq < 5; seq += 1) coordinator.sessions.applyRemoteEvent(sessionId,
                    { type: "request/header", seq, time: 20 + seq, data: {} });
                coordinator.sessions.applyRemoteEvent(sessionId, { ...settlement, seq: 5, time: 25 });
            });
        assert.equal(snapshot.assistantStream, undefined);
        assert.equal(snapshot.events.at(-1).event.seq, 5);
    }],
    ["historical chunks and live prefix produce one assistant row", async () => {
        const historical = { type: "assistant/chunk", seq: 0, time: 10,
            data: { turn: 1, step: 1, chunk: timed.chunk } };
        const snapshot = await follow([opening([historical])]);
        const rows = projectChatMessages(snapshot, []).filter(row => row.role === "assistant");
        assert.equal(rows.length, 1);
        assert.equal(rows[0].text, "Hello");
    }],
    ["history ahead of the cursor does not settle an in-flight prefix early", async () => {
        const chunk = { type: "assistant-stream", frame: { type: "chunk", revision: 3,
            attemptId: active.attemptId, index: 1, time: 11, chunk: { ...timed.chunk, text: "!" } } };
        const committedEnd = end();
        Object.assign(committedEnd.frame, { revision: 4, index: 2 });
        const snapshot = await follow([opening([], -1), chunk, { type: "event", event: settlement }, committedEnd], (coordinator, frame) => {
            if (frame.type === "snapshot") coordinator.sessions.rebaseline(sessionId, { events: [{ event: settlement }] });
        });
        assert.equal(snapshot.assistantStream, undefined);
        assert.equal(projectChatMessages(snapshot, []).length, 1);
    }],
    ["a previous settlement does not settle a later attempt at the same location", async () => {
        const baseline = opening([settlement]);
        baseline.assistantStream.activeAttempt = { ...active, startedAfterSeq: 0 };
        await follow([baseline, end({ kind: "abandoned" })]);
    }],
    ["attempt settlement metadata preserves its event type", async () => {
        const attempt = { type: "assistant/attempt", seq: 0, time: 20,
            data: { turn: 1, step: 1, stream: active.stream } };
        const snapshot = await follow([opening([attempt]), end({ kind: "committed", seq: 0, eventType: "assistant/attempt" })]);
        assert.equal(projectSessionTrace(snapshot).rows[0].eventType, "assistant/attempt");
        assert.equal(snapshot.assistantStream, undefined);
    }],
    ["absent optional attempt stream remains projectable", async () => {
        const store = new HarnessSessionStore();
        store.rebaseline(sessionId, { events: [{ event: { type: "assistant/attempt", seq: 0, time: 20, data: { turn: 1, step: 1 } } }] });
        const projection = projectSessionTrace(store.get(sessionId));
        assert.equal(projection.rows[0].eventType, "assistant/attempt");
    }],
    ["malformed present attempt streams remain rejected", async () => {
        for (const stream of [null, {}, "bad"]) {
            const store = new HarnessSessionStore();
            store.rebaseline(sessionId, { events: [{ event: { type: "assistant/attempt", seq: 0, time: 20,
                data: { turn: 1, step: 1, stream } } }] });
            assert.throws(() => projectSessionTrace(store.get(sessionId)), /Assistant stream must be an array/);
        }
    }],
    ["settlement type, sequence, abandonment and frame continuity remain strict", async () => {
        for (const outcome of [{ kind: "committed", seq: 0, eventType: "assistant/attempt" },
            { kind: "committed", seq: 1, eventType: "assistant/message" }, { kind: "abandoned" }]) {
            await assert.rejects(follow([opening([settlement]), end(outcome)]), /does not match its durable settlement/);
        }
        for (const patch of [{ revision: 4 }, { index: 2 }]) {
            const frame = end();
            Object.assign(frame.frame, patch);
            await assert.rejects(follow([opening([settlement]), frame]), /gap/);
        }
    }],
];
let failures = 0;
for (const [name, run] of scenarios) {
    try { await run(); console.log(`PASS ${name}`); }
    catch (error) { failures += 1; console.error(`FAIL ${name}: ${error.message}`); }
}
if (failures) process.exitCode = 1;
