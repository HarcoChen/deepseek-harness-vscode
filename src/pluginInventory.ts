import { isRecord } from "./guards";
import type {
    DshPluginFiberPhase,
    DshPluginInventoryEntry,
    DshPluginInventoryPreset,
    DshPluginInventoryRow,
    DshPluginInventorySnapshot,
    DshPluginPresetEnablement,
} from "./types";

const MAX_PLUGIN_ENTRIES = 1_000;
const MAX_PLUGIN_PRESETS = 256;
const MAX_PLUGIN_ROWS = 1_000;

function nonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

function fiberPhase(value: unknown): value is DshPluginFiberPhase {
    return value === null || value === "pending" || value === "loading" || value === "active" ||
        value === "failed" || value === "unloading";
}

function inventoryEntry(value: unknown): DshPluginInventoryEntry | undefined {
    if (
        !isRecord(value) ||
        !nonEmptyString(value.entryId) ||
        !nonEmptyString(value.moduleName) ||
        typeof value.enabled !== "boolean" ||
        !fiberPhase(value.fiberPhase)
    ) return undefined;
    return {
        entryId: value.entryId,
        moduleName: value.moduleName,
        enabled: value.enabled,
        fiberPhase: value.fiberPhase,
    };
}

function presetEnablement(value: unknown): value is DshPluginPresetEnablement {
    return typeof value === "boolean" || value === "conditional";
}

function inventoryRow(value: unknown): DshPluginInventoryRow | undefined {
    if (
        !isRecord(value) ||
        (value.entryId !== null && !nonEmptyString(value.entryId)) ||
        !nonEmptyString(value.moduleName) ||
        !presetEnablement(value.enabled) ||
        !fiberPhase(value.fiberPhase) ||
        (value.condition !== undefined && typeof value.condition !== "string")
    ) return undefined;
    return {
        entryId: value.entryId,
        moduleName: value.moduleName,
        enabled: value.enabled,
        fiberPhase: value.fiberPhase,
        ...(value.condition === undefined ? {} : { condition: value.condition }),
    };
}

function inventoryPreset(value: unknown): DshPluginInventoryPreset | undefined {
    if (
        !isRecord(value) ||
        !nonEmptyString(value.id) ||
        (value.trust !== "system" && value.trust !== "user") ||
        typeof value.isDefault !== "boolean" ||
        !Array.isArray(value.rows) ||
        value.rows.length > MAX_PLUGIN_ROWS ||
        (value.name !== undefined && typeof value.name !== "string") ||
        (value.broken !== undefined && typeof value.broken !== "string")
    ) return undefined;
    const rows = value.rows.map(inventoryRow);
    if (rows.some((row) => row === undefined)) return undefined;
    return {
        id: value.id,
        trust: value.trust,
        isDefault: value.isDefault,
        ...(value.name === undefined ? {} : { name: value.name }),
        ...(value.broken === undefined ? {} : { broken: value.broken }),
        rows: rows as DshPluginInventoryRow[],
    };
}

/** Validate and detach the point-in-time `pluginInventory/list` response. */
export function normalizePluginInventory(value: unknown): DshPluginInventorySnapshot | undefined {
    if (
        !isRecord(value) ||
        !Array.isArray(value.entries) ||
        value.entries.length > MAX_PLUGIN_ENTRIES ||
        (value.agentPresets !== undefined &&
            (!Array.isArray(value.agentPresets) || value.agentPresets.length > MAX_PLUGIN_PRESETS))
    ) return undefined;

    const entries = value.entries.map(inventoryEntry);
    if (entries.some((entry) => entry === undefined)) return undefined;
    const entryIds = new Set<string>();
    for (const entry of entries as DshPluginInventoryEntry[]) {
        if (entryIds.has(entry.entryId)) return undefined;
        entryIds.add(entry.entryId);
    }

    if (value.agentPresets === undefined) {
        return { entries: entries as DshPluginInventoryEntry[] };
    }
    const agentPresets = value.agentPresets.map(inventoryPreset);
    if (agentPresets.some((preset) => preset === undefined)) return undefined;
    const presetIds = new Set<string>();
    for (const preset of agentPresets as DshPluginInventoryPreset[]) {
        if (presetIds.has(preset.id)) return undefined;
        presetIds.add(preset.id);
    }
    return {
        entries: entries as DshPluginInventoryEntry[],
        agentPresets: agentPresets as DshPluginInventoryPreset[],
    };
}
