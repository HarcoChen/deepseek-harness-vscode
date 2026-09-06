import React, { useEffect, useMemo, useState } from "react";
import type {
    DshPluginFiberPhase,
    DshPluginInventoryEntry,
    DshPluginInventoryPanelView,
    DshPluginInventoryPreset,
    DshPluginInventoryRow,
} from "../../../src/types";
import { postAction } from "../bridge";
import { t } from "../i18n";

const PHASE_LABELS: Readonly<Record<Exclude<DshPluginFiberPhase, null>, string>> = {
    pending: "Waiting for dependencies",
    loading: "Loading",
    active: "Running",
    failed: "Failed to start",
    unloading: "Unloading",
};

function phaseLabel(phase: DshPluginFiberPhase): string {
    return phase === null ? t("Not running") : t(PHASE_LABELS[phase]);
}

function moduleShortName(moduleName: string): string {
    const unscoped = moduleName.startsWith("@") && moduleName.includes("/")
        ? moduleName.slice(moduleName.indexOf("/") + 1)
        : moduleName;
    return unscoped
        .replace(/^cordis:/u, "")
        .replace(/^cordis-plugin-/u, "")
        .replace(/^dsh-(?:host-|client-)?/u, "");
}

function presetName(preset: DshPluginInventoryPreset): string {
    return preset.name?.trim() || preset.id;
}

function presetLabel(preset: DshPluginInventoryPreset): string {
    const name = presetName(preset);
    if (preset.broken !== undefined) return t("{name} (failed to load)", { name });
    return preset.isDefault ? t("{name} (default)", { name }) : name;
}

function matches(moduleName: string, entryId: string | null | undefined, query: string): boolean {
    if (!query) return true;
    return [moduleName, ...(entryId === null || entryId === undefined ? [] : [entryId])]
        .some((value) => value.toLocaleLowerCase().includes(query));
}

function statusLabel(
    enabled: boolean | "conditional",
    failed: boolean,
): string {
    if (failed) return t("Failed to start");
    if (enabled === "conditional") return t("Conditional");
    return enabled ? t("Enabled") : t("Disabled");
}

function InventoryCard({
    moduleName,
    entryId,
    status,
    phase,
    facts,
}: {
    moduleName: string;
    entryId: string | null;
    status: string;
    phase?: DshPluginFiberPhase;
    facts: ReadonlyArray<readonly [string, React.ReactNode]>;
}): React.JSX.Element {
    const failed = phase === "failed";
    return (
        <details className={`dsh-plugin-card${failed ? " failed" : ""}`}>
            <summary className="dsh-plugin-card-summary">
                <strong title={moduleName}>{moduleShortName(moduleName)}</strong>
                <span>
                    {status}
                    {phase !== undefined && phase !== null ? ` · ${phaseLabel(phase)}` : ""}
                </span>
            </summary>
            <div className="dsh-plugin-card-details">
                {entryId !== null ? <code>{entryId}</code> : null}
                <dl>
                    {facts.map(([label, value]) => (
                        <div key={label}>
                            <dt>{label}</dt>
                            <dd>{value}</dd>
                        </div>
                    ))}
                </dl>
            </div>
        </details>
    );
}

function presetRowCard(preset: DshPluginInventoryPreset, row: DshPluginInventoryRow, index: number): React.JSX.Element {
    const failed = row.fiberPhase === "failed";
    const status = statusLabel(row.enabled, failed);
    return (
        <li key={`${preset.id}:${String(index)}`}>
            <InventoryCard
                moduleName={row.moduleName}
                entryId={row.entryId}
                status={status}
                phase={row.fiberPhase}
                facts={[
                    [t("Module"), row.moduleName],
                    [t("From"), presetName(preset)],
                    [t("Configuration"), status],
                    ...(row.fiberPhase === null ? [] : [[t("Status"), phaseLabel(row.fiberPhase)] as const]),
                    ...(row.condition === undefined ? [] : [[t("Disabled when"), <code key="condition">{row.condition}</code>] as const]),
                ]}
            />
        </li>
    );
}

function globalEntryCard(
    entry: DshPluginInventoryEntry,
    enabledIn: readonly string[] | undefined,
): React.JSX.Element {
    const failed = entry.fiberPhase === "failed";
    const presetProvided = !entry.enabled && enabledIn !== undefined && enabledIn.length > 0;
    const status = failed
        ? t("Failed to start")
        : presetProvided
          ? t("Enabled via presets")
          : entry.enabled
            ? t("Enabled")
            : t("Disabled");
    const phase = entry.enabled || failed ? entry.fiberPhase : undefined;
    const facts: Array<readonly [string, React.ReactNode]> = [
        [t("Module"), entry.moduleName],
        [t("Configuration"), presetProvided ? t("Preset provides this plugin") : status],
    ];
    if (presetProvided) {
        facts.push([t("Enabled in"), enabledIn?.join(" · ") ?? ""]);
    } else if (phase !== undefined) {
        facts.push([t("Status"), phaseLabel(phase)]);
    }
    return (
        <li key={entry.entryId}>
            <InventoryCard
                moduleName={entry.moduleName}
                entryId={entry.entryId}
                status={status}
                phase={phase}
                facts={facts}
            />
        </li>
    );
}

export function PluginInventoryPanel({ inventory }: { inventory: DshPluginInventoryPanelView }): React.JSX.Element {
    const [query, setQuery] = useState("");
    const [selectedPresetId, setSelectedPresetId] = useState<string | undefined>();
    const presets = inventory.agentPresets ?? [];
    const fallbackPreset = presets.find((preset) => preset.isDefault) ?? presets[0];
    const selectedPreset = presets.find((preset) => preset.id === selectedPresetId) ?? fallbackPreset;
    const normalizedQuery = query.trim().toLocaleLowerCase();

    useEffect(() => {
        if (selectedPreset?.id !== selectedPresetId) setSelectedPresetId(selectedPreset?.id);
    }, [selectedPreset?.id, selectedPresetId]);

    const enabledIn = useMemo(() => {
        const found = new Map<string, string[]>();
        for (const preset of presets) {
            for (const row of preset.rows) {
                if (row.enabled !== true) continue;
                const names = found.get(row.moduleName) ?? [];
                if (!names.includes(presetName(preset))) names.push(presetName(preset));
                found.set(row.moduleName, names);
            }
        }
        return found;
    }, [presets]);

    const failedEntries = inventory.entries.filter((entry) => entry.fiberPhase === "failed" && matches(entry.moduleName, entry.entryId, normalizedQuery));
    const regularEntries = inventory.entries.filter((entry) => entry.fiberPhase !== "failed" && matches(entry.moduleName, entry.entryId, normalizedQuery));
    const selectedRows = selectedPreset?.rows.filter((row) => matches(row.moduleName, row.entryId, normalizedQuery)) ?? [];
    const otherPresetMatches = normalizedQuery
        ? presets.filter((preset) => preset !== selectedPreset && preset.rows.some((row) => matches(row.moduleName, row.entryId, normalizedQuery)))
        : [];
    const otherMatchCount = otherPresetMatches.reduce(
        (total, preset) => total + preset.rows.filter((row) => matches(row.moduleName, row.entryId, normalizedQuery)).length,
        0,
    );
    const hasMatches = failedEntries.length > 0 || regularEntries.length > 0 || selectedRows.length > 0 || otherMatchCount > 0;

    if (inventory.loading) {
        return <section className="dsh-plugin-inventory"><div className="dsh-settings-loading">{t("Reading plugins...")}</div></section>;
    }
    if (inventory.error) {
        return (
            <section className="dsh-plugin-inventory">
                <div className="dsh-settings-error">{inventory.error}</div>
                <button type="button" onClick={() => postAction({ type: "refreshPluginInventory" })}>{t("Retry")}</button>
            </section>
        );
    }

    return (
        <section className="dsh-plugin-inventory" aria-label={t("Plugin inventory")}>
            <div className="dsh-plugin-inventory-head">
                <div>
                    <strong>{t("Plugin inventory")}</strong>
                    <small>{t("Read-only plugin inventory")}</small>
                </div>
                <button
                    type="button"
                    disabled={inventory.loading}
                    title={t("Refresh plugin inventory")}
                    onClick={() => postAction({ type: "refreshPluginInventory" })}
                >
                    {t("Refresh")}
                </button>
            </div>
            <label className="dsh-plugin-inventory-search">
                <span>{t("Search plugins")}</span>
                <input
                    type="search"
                    value={query}
                    placeholder={t("Search plugins")}
                    onChange={(event) => setQuery(event.target.value)}
                />
            </label>
            {inventory.entries.length === 0 && presets.length === 0 ? <div className="dsh-settings-empty">{t("No plugins are available.")}</div> : null}
            {normalizedQuery && !hasMatches ? <div className="dsh-settings-empty">{t("No matching plugins.")}</div> : null}

            {selectedPreset ? (
                <details className="dsh-plugin-group" open>
                    <summary>
                        <strong>{t("Session plugins")}</strong>
                        <span>{t("{count} plugins", { count: selectedRows.length })}</span>
                    </summary>
                    <div className="dsh-plugin-group-head">
                        <small>{t("Composed per session by agent presets")}</small>
                        <select
                            aria-label={t("Choose agent preset")}
                            value={selectedPreset.id}
                            onChange={(event) => setSelectedPresetId(event.target.value)}
                        >
                            {presets.map((preset) => <option key={preset.id} value={preset.id}>{presetLabel(preset)}</option>)}
                        </select>
                    </div>
                    {selectedPreset.broken !== undefined ? <div className="dsh-plugin-broken" role="alert">{selectedPreset.broken}</div> : null}
                    {selectedRows.length > 0 ? (
                        <ul className="dsh-plugin-cards">
                            {selectedRows.map((row, index) => presetRowCard(selectedPreset, row, index))}
                        </ul>
                    ) : null}
                    {otherMatchCount > 0 ? (
                        <div className="dsh-plugin-hint">
                            {t("{count} more matches in other presets", { count: otherMatchCount })}
                            {otherPresetMatches.map((preset) => (
                                <button type="button" key={preset.id} onClick={() => setSelectedPresetId(preset.id)}>
                                    {presetName(preset)}
                                </button>
                            ))}
                        </div>
                    ) : null}
                </details>
            ) : null}

            {inventory.entries.length > 0 ? (
                <details className="dsh-plugin-group" open={!selectedPreset}>
                    <summary>
                        <strong>{t("Global plugins")}</strong>
                        <span>{t("{count} plugins", { count: failedEntries.length + regularEntries.length })}</span>
                    </summary>
                    <small>{t("Shared by the system and every session")}</small>
                    {failedEntries.length + regularEntries.length > 0 ? (
                        <ul className="dsh-plugin-cards">
                            {failedEntries.map((entry) => globalEntryCard(entry, enabledIn.get(entry.moduleName)))}
                            {regularEntries.map((entry) => globalEntryCard(entry, enabledIn.get(entry.moduleName)))}
                        </ul>
                    ) : null}
                </details>
            ) : null}
        </section>
    );
}
