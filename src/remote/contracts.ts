/**
 * Wire contracts for the RC Remote API.
 *
 * Target contract: `deepseek-harness` tag `dsh-v0.1.5-rc.1`, commit
 * `183f08e9c6dde7e36cd2318eaee70b0da08fb35e`. Keep this pin next to the
 * carrier vocabulary: upgrading the managed Runtime requires an endpoint and
 * descriptor audit before changing it.
 */

export const REMOTE_API_PREFIX = "/api/";
export const REMOTE_STREAM_MUX_PATH = "/api/remote.mux";
export const REMOTE_EVENT_STREAM_ENDPOINT = "$events";
export const REMOTE_EVENT_RESULT_ENDPOINT = "$events/result";

export interface RemoteRpcFailure {
    code: string;
    message: string;
    details: Record<string, unknown>;
}

export type RemoteRpcResult<T> =
    | { ok: true; value?: T }
    | { ok: false; error: RemoteRpcFailure };

export interface RemoteClientRequest {
    type: "client-request";
    rpcId: string;
    method: string;
    payload: { args: Record<string, unknown> };
}

export interface RemoteServerResponse {
    type: "server-response";
    rpcId: string;
    result: RemoteRpcResult<unknown>;
}

export type RemoteStreamClientMessage =
    | {
          type: "open";
          streamId: string;
          endpoint: string;
          payload: { args: Record<string, unknown> };
      }
    | { type: "cancel"; streamId: string };

export type RemoteStreamServerMessage =
    | { type: "item"; streamId: string; value?: unknown }
    | { type: "error"; streamId: string; error: RemoteRpcFailure }
    | { type: "end"; streamId: string };

export interface RemoteEventReadyFrame {
    type: "ready";
    clientId: string;
    host: { home: string };
}

export interface RemoteEventEmitFrame {
    type: "emit";
    event: string;
    args: unknown[];
}

export interface RemoteEventWaterfallFrame {
    type: "waterfall";
    event: string;
    eventId: string;
    agentId: string;
    request: Record<string, unknown>;
}

export interface RemoteEventCancelFrame {
    type: "cancel";
    eventId: string;
}

export type RemoteEventFrame =
    | RemoteEventReadyFrame
    | RemoteEventEmitFrame
    | RemoteEventWaterfallFrame
    | RemoteEventCancelFrame;

export type RemoteEventOutcome =
    | { kind: "next" }
    | { kind: "result"; value?: unknown }
    | {
          kind: "rejected";
          error: { name: string; message: string; code?: string; details?: unknown };
      };

export interface RemoteEventResultRequest {
    clientId: string;
    eventId: string;
    outcome: RemoteEventOutcome;
}

/** Parse and validate one client-to-Host logical stream message. */
export function parseRemoteStreamClientMessage(text: string): RemoteStreamClientMessage {
    let value: unknown;
    try {
        value = JSON.parse(text) as unknown;
    } catch (cause) {
        throw new TypeError("Remote stream frame is not JSON", { cause });
    }
    if (!isPlainRecord(value)) throw new TypeError("Remote stream message is not an object");
    if (
        value.type === "cancel" &&
        exactKeys(value, ["type", "streamId"]) &&
        isNonEmptyString(value.streamId)
    ) {
        return { type: "cancel", streamId: value.streamId };
    }
    if (
        value.type === "open" &&
        exactKeys(value, ["type", "streamId", "endpoint", "payload"]) &&
        isNonEmptyString(value.streamId) &&
        typeof value.endpoint === "string" &&
        value.endpoint.length > 0 &&
        isPlainRecord(value.payload) &&
        exactKeys(value.payload, ["args"]) &&
        isPlainRecord(value.payload.args) &&
        isRemoteJsonValue(value.payload.args)
    ) {
        assertRemoteEndpoint(value.endpoint);
        return {
            type: "open",
            streamId: value.streamId,
            endpoint: value.endpoint,
            payload: { args: value.payload.args },
        };
    }
    throw new TypeError("Remote stream message is malformed");
}

export function remoteEndpointUrl(baseUrl: string, endpoint: string): string {
    assertRemoteEndpoint(endpoint);
    return new URL(`${REMOTE_API_PREFIX}${endpoint}`, `${baseUrl.replace(/\/+$/u, "")}/`).toString();
}

export function remoteMuxUrl(baseUrl: string): string {
    const url = new URL(REMOTE_STREAM_MUX_PATH, `${baseUrl.replace(/\/+$/u, "")}/`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
}

/** RC Remote methods have exactly one namespace and one method segment. */
export function assertRemoteEndpoint(endpoint: string): void {
    const segments = endpoint.split("/");
    if (
        segments.length !== 2 ||
        segments.some(
            (segment) =>
                segment.length === 0 ||
                segment === "." ||
                segment === ".." ||
                !/^[A-Za-z0-9_$.-]+$/u.test(segment),
        )
    ) {
        // The two Gateway-internal event methods are the only exception to
        // the namespace/method rule.
        if (endpoint !== REMOTE_EVENT_STREAM_ENDPOINT && endpoint !== REMOTE_EVENT_RESULT_ENDPOINT) {
            throw new Error(`Remote endpoint is invalid: ${JSON.stringify(endpoint)}`);
        }
    }
}

export function parseRemoteServerResponse(value: unknown): RemoteServerResponse {
    if (
        !isPlainRecord(value) ||
        !exactKeys(value, ["type", "rpcId", "result"]) ||
        value.type !== "server-response" ||
        !isNonEmptyString(value.rpcId)
    ) {
        throw new TypeError("Remote response is not a server-response envelope");
    }
    if (!isPlainRecord(value.result)) {
        throw new TypeError("Remote response has no result envelope");
    }
    const result = value.result;
    if (result.ok === true) {
        if (
            !(
                exactKeys(result, ["ok"]) ||
                exactKeys(result, ["ok", "value"])
            ) ||
            (Object.hasOwn(result, "value") && !isRemoteJsonValue(result.value))
        ) {
            throw new TypeError("Remote response value is not JSON-safe");
        }
        return {
            type: "server-response",
            rpcId: value.rpcId,
            result: Object.hasOwn(result, "value")
                ? { ok: true, value: result.value }
                : { ok: true },
        };
    }
    if (
        result.ok !== false ||
        !exactKeys(result, ["ok", "error"]) ||
        !isPlainRecord(result.error)
    ) {
        throw new TypeError("Remote response has an invalid result");
    }
    const error = result.error;
    if (
        !exactKeys(error, ["code", "message", "details"]) ||
        !isNonEmptyString(error.code) ||
        typeof error.message !== "string" ||
        !isPlainRecord(error.details) ||
        !isRemoteJsonValue(error.details)
    ) {
        throw new TypeError("Remote response has an invalid failure");
    }
    return {
        type: "server-response",
        rpcId: value.rpcId,
        result: {
            ok: false,
            error: {
                code: error.code,
                message: error.message,
                details: error.details,
            },
        },
    };
}

export function parseRemoteStreamServerMessage(text: string): RemoteStreamServerMessage {
    let value: unknown;
    try {
        value = JSON.parse(text) as unknown;
    } catch (cause) {
        throw new TypeError("Remote stream frame is not JSON", { cause });
    }
    if (!isPlainRecord(value) || typeof value.type !== "string" || !isNonEmptyString(value.streamId)) {
        throw new TypeError("Remote stream frame is malformed");
    }
    if (
        value.type === "item" &&
        (exactKeys(value, ["type", "streamId"]) || exactKeys(value, ["type", "streamId", "value"])) &&
        (!Object.hasOwn(value, "value") || isRemoteJsonValue(value.value))
    ) {
        return value as unknown as RemoteStreamServerMessage;
    }
    if (value.type === "end" && exactKeys(value, ["type", "streamId"])) {
        return value as unknown as RemoteStreamServerMessage;
    }
    if (
        value.type === "error" &&
        exactKeys(value, ["type", "streamId", "error"]) &&
        isPlainRecord(value.error) &&
        exactKeys(value.error, ["code", "message", "details"]) &&
        isNonEmptyString(value.error.code) &&
        typeof value.error.message === "string" &&
        isPlainRecord(value.error.details) &&
        isRemoteJsonValue(value.error.details)
    ) {
        return value as unknown as RemoteStreamServerMessage;
    }
    throw new TypeError("Remote stream frame is malformed");
}

export function parseRemoteEventFrame(value: unknown): RemoteEventFrame {
    if (!isPlainRecord(value) || typeof value.type !== "string") {
        throw new TypeError("Remote event frame is malformed");
    }
    if (
        value.type === "ready" &&
        exactKeys(value, ["type", "clientId", "host"]) &&
        isNonEmptyString(value.clientId) &&
        isPlainRecord(value.host) &&
        exactKeys(value.host, ["home"]) &&
        typeof value.host.home === "string"
    ) {
        return value as unknown as RemoteEventReadyFrame;
    }
    if (
        value.type === "emit" &&
        exactKeys(value, ["type", "event", "args"]) &&
        isNonEmptyString(value.event) &&
        Array.isArray(value.args) &&
        isRemoteJsonValue(value.args)
    ) {
        return value as unknown as RemoteEventEmitFrame;
    }
    if (
        value.type === "waterfall" &&
        exactKeys(value, ["type", "event", "eventId", "agentId", "request"]) &&
        isNonEmptyString(value.event) &&
        isNonEmptyString(value.eventId) &&
        isNonEmptyString(value.agentId) &&
        isPlainRecord(value.request) &&
        isRemoteJsonValue(value.request)
    ) {
        return value as unknown as RemoteEventWaterfallFrame;
    }
    if (value.type === "cancel" && exactKeys(value, ["type", "eventId"]) && isNonEmptyString(value.eventId)) {
        return value as unknown as RemoteEventCancelFrame;
    }
    throw new TypeError("Remote event frame is malformed");
}

export function isRemoteJsonValue(value: unknown): boolean {
    return visitJsonValue(value, new Set<object>());
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return isRecord(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
}

function exactKeys(value: object, expected: readonly string[]): boolean {
    const keys = Reflect.ownKeys(value);
    return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function visitJsonValue(value: unknown, ancestors: Set<object>): boolean {
    if (value === null || typeof value === "string" || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0);
    if (typeof value !== "object" || ancestors.has(value)) return false;
    ancestors.add(value);
    try {
        if (Array.isArray(value)) {
            if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) {
                return false;
            }
            for (let index = 0; index < value.length; index += 1) {
                if (!Object.hasOwn(value, index) || !visitJsonValue(value[index], ancestors)) return false;
            }
            return true;
        }
        if (!isPlainRecord(value)) return false;
        for (const key of Reflect.ownKeys(value)) {
            if (typeof key !== "string") return false;
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (descriptor?.enumerable !== true || !visitJsonValue(Reflect.get(value, key), ancestors)) return false;
        }
        return true;
    } finally {
        ancestors.delete(value);
    }
}
