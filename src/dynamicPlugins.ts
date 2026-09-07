import { isRecord } from "./guards";
import type {
    DshDynamicPluginActiveRun,
    DshDynamicPluginDiagnostic,
    DshDynamicPluginDiagnosticPhase,
    DshDynamicPluginHalf,
    DshDynamicPluginHalfStatus,
    DshDynamicPluginPackage,
    DshDynamicPluginRemoveResult,
    DshDynamicPluginResolveResult,
    DshDynamicPluginRow,
    DshDynamicPluginRunAttempt,
    DshDynamicPluginRunMode,
    DshDynamicPluginRunStatus,
    DshDynamicPluginStopResult,
} from "./types";

const MAX_DYNAMIC_PLUGINS = 512;
const MAX_DYNAMIC_PACKAGES = 256;
const MAX_DYNAMIC_WAITING_SERVICES = 128;
const MAX_DYNAMIC_STRING = 8_192;
const MAX_DYNAMIC_STACK = 64 * 1_024;

function boundedString(value: unknown, maximum = MAX_DYNAMIC_STRING): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function optionalString(value: unknown, maximum = MAX_DYNAMIC_STRING): value is string | undefined {
    return value === undefined || boundedString(value, maximum);
}

function oneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
    return typeof value === "string" && values.includes(value as T);
}

const RUN_MODES: readonly DshDynamicPluginRunMode[] = ["run", "update"];
const RUN_STATUSES: readonly DshDynamicPluginRunStatus[] = [
    "awaiting-approval",
    "starting-host",
    "client-pending",
    "running",
    "waiting",
    "rejected",
    "failed",
    "cancelled",
    "stopped",
];
const HALF_STATUSES: readonly DshDynamicPluginHalfStatus[] = [
    "absent",
    "pending",
    "stopped",
    "running",
    "waiting",
    "failed",
];
const DIAGNOSTIC_PHASES: readonly DshDynamicPluginDiagnosticPhase[] = [
    "approval",
    "host-load",
    "host-apply",
    "client-load",
    "client-apply",
    "client-render",
];

function dynamicPackage(value: unknown): DshDynamicPluginPackage | undefined {
    if (
        !isRecord(value) ||
        !boundedString(value.packageId) ||
        !boundedString(value.name) ||
        !boundedString(value.purpose) ||
        typeof value.hasHostHalf !== "boolean" ||
        typeof value.hasClientHalf !== "boolean"
    ) return undefined;
    return {
        packageId: value.packageId,
        name: value.name,
        purpose: value.purpose,
        hasHostHalf: value.hasHostHalf,
        hasClientHalf: value.hasClientHalf,
    };
}

function dynamicHalf(value: unknown): DshDynamicPluginHalf | undefined {
    if (
        !isRecord(value) ||
        !oneOf(value.status, HALF_STATUSES) ||
        !Array.isArray(value.waitingFor) ||
        value.waitingFor.length > MAX_DYNAMIC_WAITING_SERVICES ||
        !value.waitingFor.every((service) => boundedString(service)) ||
        !optionalString(value.error)
    ) return undefined;
    return {
        status: value.status,
        waitingFor: [...value.waitingFor],
        ...(value.error === undefined ? {} : { error: value.error }),
    };
}

function dynamicDiagnostic(value: unknown): DshDynamicPluginDiagnostic | undefined {
    if (
        !isRecord(value) ||
        !oneOf(value.phase, DIAGNOSTIC_PHASES) ||
        !boundedString(value.message) ||
        !optionalString(value.stack, MAX_DYNAMIC_STACK) ||
        !boundedString(value.pluginId) ||
        !boundedString(value.packageId) ||
        !boundedString(value.pluginRunId)
    ) return undefined;
    return {
        phase: value.phase,
        message: value.message,
        ...(value.stack === undefined ? {} : { stack: value.stack }),
        pluginId: value.pluginId,
        packageId: value.packageId,
        pluginRunId: value.pluginRunId,
    };
}

function dynamicAttempt(value: unknown): DshDynamicPluginRunAttempt | undefined {
    if (
        !isRecord(value) ||
        !boundedString(value.pluginRunId) ||
        !boundedString(value.packageId) ||
        !oneOf(value.mode, RUN_MODES) ||
        !oneOf(value.status, RUN_STATUSES) ||
        !dynamicHalf(value.host) ||
        !dynamicHalf(value.client) ||
        !optionalString(value.approvalRequestId) ||
        (value.requiresApproval !== undefined && typeof value.requiresApproval !== "boolean") ||
        (value.error !== undefined && !dynamicDiagnostic(value.error))
    ) return undefined;
    const host = dynamicHalf(value.host);
    const client = dynamicHalf(value.client);
    if (host === undefined || client === undefined) return undefined;
    const error = value.error === undefined ? undefined : dynamicDiagnostic(value.error);
    return {
        pluginRunId: value.pluginRunId,
        packageId: value.packageId,
        mode: value.mode,
        status: value.status,
        ...(value.approvalRequestId === undefined ? {} : { approvalRequestId: value.approvalRequestId }),
        ...(value.requiresApproval === undefined ? {} : { requiresApproval: value.requiresApproval }),
        host,
        client,
        ...(error === undefined ? {} : { error }),
    };
}

function dynamicActiveRun(value: unknown): DshDynamicPluginActiveRun | undefined {
    if (!isRecord(value) || !boundedString(value.pluginRunId) || !boundedString(value.packageId)) return undefined;
    return { pluginRunId: value.pluginRunId, packageId: value.packageId };
}

function dynamicRow(value: unknown): DshDynamicPluginRow | undefined {
    if (
        !isRecord(value) ||
        !boundedString(value.pluginId) ||
        !boundedString(value.agentId) ||
        !Array.isArray(value.packages) ||
        value.packages.length === 0 ||
        value.packages.length > MAX_DYNAMIC_PACKAGES ||
        !optionalString(value.currentPackageId) ||
        !optionalString(value.nextPackageId) ||
        (value.activeRun !== undefined && !dynamicActiveRun(value.activeRun)) ||
        (value.latestRun !== undefined && !dynamicAttempt(value.latestRun))
    ) return undefined;
    const packages = value.packages.map(dynamicPackage);
    if (packages.some((pkg) => pkg === undefined)) return undefined;
    const packageIds = new Set<string>();
    for (const pkg of packages as DshDynamicPluginPackage[]) {
        if (packageIds.has(pkg.packageId)) return undefined;
        packageIds.add(pkg.packageId);
    }
    const activeRun = value.activeRun === undefined ? undefined : dynamicActiveRun(value.activeRun);
    const latestRun = value.latestRun === undefined ? undefined : dynamicAttempt(value.latestRun);
    return {
        pluginId: value.pluginId,
        agentId: value.agentId,
        packages: packages as DshDynamicPluginPackage[],
        ...(value.currentPackageId === undefined ? {} : { currentPackageId: value.currentPackageId }),
        ...(value.nextPackageId === undefined ? {} : { nextPackageId: value.nextPackageId }),
        ...(activeRun === undefined ? {} : { activeRun }),
        ...(latestRun === undefined ? {} : { latestRun }),
    };
}

/** Validate and detach the frame-wide dynamic Cordis inventory. */
export function normalizeDynamicPluginInventory(value: unknown): DshDynamicPluginRow[] | undefined {
    if (!Array.isArray(value) || value.length > MAX_DYNAMIC_PLUGINS) return undefined;
    const rows = value.map(dynamicRow);
    if (rows.some((row) => row === undefined)) return undefined;
    const pluginIds = new Set<string>();
    for (const row of rows as DshDynamicPluginRow[]) {
        if (pluginIds.has(row.pluginId)) return undefined;
        pluginIds.add(row.pluginId);
    }
    return rows as DshDynamicPluginRow[];
}

/** Normalize the read-only stop receipt while preserving only its public fields. */
export function normalizeDynamicPluginStopResult(value: unknown): DshDynamicPluginStopResult | undefined {
    if (!isRecord(value)) return undefined;
    if (value.ok === true) return { ok: true };
    if (
        value.ok === false &&
        (value.reason === "plugin-missing" || value.reason === "not-running") &&
        typeof value.message === "string"
    ) {
        return { ok: false, reason: value.reason, message: value.message };
    }
    return undefined;
}

/** Normalize the remove receipt while preserving only its public fields. */
export function normalizeDynamicPluginRemoveResult(value: unknown): DshDynamicPluginRemoveResult | undefined {
    if (!isRecord(value)) return undefined;
    if (value.ok === true && typeof value.wasRunning === "boolean") {
        return { ok: true, wasRunning: value.wasRunning };
    }
    if (value.ok === false && value.reason === "plugin-missing" && typeof value.message === "string") {
        return { ok: false, reason: "plugin-missing", message: value.message };
    }
    return undefined;
}

/** Normalize the acknowledgement for a pending Client activation decision. */
export function normalizeDynamicPluginResolveResult(value: unknown): DshDynamicPluginResolveResult | undefined {
    if (!isRecord(value) || typeof value.accepted !== "boolean") return undefined;
    return { accepted: value.accepted };
}
