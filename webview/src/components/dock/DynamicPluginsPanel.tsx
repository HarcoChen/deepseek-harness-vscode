import React, { useMemo, useState } from "react";
import type {
    ChatViewState,
    DshDynamicPluginHalf,
    DshDynamicPluginPanelView,
    DshDynamicPluginRow,
} from "../../../../src/types";
import { postAction } from "../../bridge";
import { t } from "../../i18n";

type DynamicPluginStatus =
    | "awaiting-approval"
    | "starting"
    | "waiting"
    | "running"
    | "failed"
    | "stopped"
    | "idle";

function packageFor(row: DshDynamicPluginRow) {
    const packageId = row.nextPackageId ?? row.currentPackageId ?? row.activeRun?.packageId ?? row.packages.at(-1)?.packageId;
    return packageId === undefined ? undefined : row.packages.find((pkg) => pkg.packageId === packageId);
}

function statusOf(row: DshDynamicPluginRow): DynamicPluginStatus {
    const latest = row.latestRun;
    if (latest?.status === "awaiting-approval") return "awaiting-approval";
    if (latest?.status === "failed") return "failed";
    if (latest?.status === "starting-host" || latest?.status === "client-pending") return "starting";
    if (latest?.status === "waiting") return "waiting";
    if (row.activeRun !== undefined || latest?.status === "running") return "running";
    if (latest?.status === "stopped" || latest?.status === "rejected" || latest?.status === "cancelled") return "stopped";
    return "idle";
}

function statusLabel(status: DynamicPluginStatus): string {
    if (status === "awaiting-approval") return t("Awaiting approval");
    if (status === "starting") return t("Starting");
    if (status === "waiting") return t("Waiting for services");
    if (status === "running") return t("Running");
    if (status === "failed") return t("Failed");
    if (status === "stopped") return t("Stopped");
    return t("Idle");
}

function halfStatus(half: DshDynamicPluginHalf): string {
    if (half.status === "absent") return t("Absent");
    if (half.status === "pending") return t("Pending");
    if (half.status === "stopped") return t("Stopped");
    if (half.status === "running") return t("Running");
    if (half.status === "waiting") return t("Waiting");
    return t("Failed");
}

function DynamicPluginRow({ row }: { row: DshDynamicPluginRow }): React.JSX.Element {
    const status = statusOf(row);
    const packageValue = packageFor(row);
    const latest = row.latestRun;
    const approvalRequestId = latest?.approvalRequestId;
    const waitingFor = [
        ...(latest?.host.waitingFor ?? []).map((service) => `Host: ${service}`),
        ...(latest?.client.waitingFor ?? []).map((service) => `Client: ${service}`),
    ];
    const [expanded, setExpanded] = useState(false);
    const [confirmingRemoval, setConfirmingRemoval] = useState(false);
    return (
        <li className={`dsh-dynamic-plugin-row ${status}`}>
            <div className="dsh-dynamic-plugin-row-head">
                <strong title={row.pluginId}>{row.pluginId}</strong>
                <span className="dsh-dynamic-plugin-status">{statusLabel(status)}</span>
            </div>
            <div className="dsh-dynamic-plugin-meta">
                {packageValue?.name ?? t("No package selected")}
                <span aria-hidden="true"> · </span>
                {t("owner {owner}", { owner: row.agentId })}
            </div>
            {packageValue?.purpose ? <div className="dsh-dynamic-plugin-purpose">{packageValue.purpose}</div> : null}
            <div className="dsh-dynamic-plugin-facts">
                <span>{t("Host half")}: {latest ? halfStatus(latest.host) : packageValue?.hasHostHalf ? t("Declared") : t("Absent")}</span>
                <span>{t("Client half")}: {latest ? halfStatus(latest.client) : packageValue?.hasClientHalf ? t("Declared") : t("Absent")}</span>
                {row.packages.length > 1 ? <span>{t("{count} packages", { count: row.packages.length })}</span> : null}
            </div>
            {waitingFor.length > 0 ? <div className="dsh-dynamic-plugin-waiting">{t("Waiting for")}: {waitingFor.join(" · ")}</div> : null}
            {latest?.error ? (
                <div className="dsh-dynamic-plugin-error" role="alert">
                    {latest.error.message} <small>({latest.error.phase})</small>
                </div>
            ) : null}
            {latest?.host.error ? <div className="dsh-dynamic-plugin-error" role="alert">{latest.host.error}</div> : null}
            {latest?.client.error ? <div className="dsh-dynamic-plugin-error" role="alert">{latest.client.error}</div> : null}
            <div className="dsh-dynamic-plugin-actions">
                {status === "awaiting-approval" ? (
                    <>
                        <button type="button" onClick={() => postAction({ type: "openBrowser" })}>
                            {t("Review in dsh Web UI")}
                        </button>
                        {approvalRequestId ? (
                            <button
                                type="button"
                                className="danger"
                                onClick={() => postAction({
                                    type: "declineDynamicPlugin",
                                    requestId: approvalRequestId,
                                    pluginId: row.pluginId,
                                })}
                            >
                                {t("Decline")}
                            </button>
                        ) : null}
                    </>
                ) : null}
                {row.activeRun !== undefined ? (
                    <button
                        type="button"
                        onClick={() => postAction({ type: "stopDynamicPlugin", sessionId: row.agentId, pluginId: row.pluginId })}
                    >
                        {t("Stop plugin")}
                    </button>
                ) : null}
                {/* Webview iframes run without `allow-modals`, so `window.confirm`
                    resolves to false and would silently swallow the removal.
                    The confirmation is rendered inline instead. */}
                {confirmingRemoval ? (
                    <>
                        <span className="dsh-dynamic-plugin-confirm" role="status">
                            {t("Remove dynamic plugin {pluginId}?", { pluginId: row.pluginId })}
                        </span>
                        <button
                            type="button"
                            className="danger"
                            onClick={() => {
                                setConfirmingRemoval(false);
                                postAction({ type: "removeDynamicPlugin", sessionId: row.agentId, pluginId: row.pluginId });
                            }}
                        >
                            {t("Confirm")}
                        </button>
                        <button type="button" onClick={() => setConfirmingRemoval(false)}>
                            {t("Cancel")}
                        </button>
                    </>
                ) : (
                    <button type="button" className="danger" onClick={() => setConfirmingRemoval(true)}>
                        {t("Remove plugin")}
                    </button>
                )}
                <button type="button" className="dsh-dynamic-plugin-toggle" onClick={() => setExpanded((value) => !value)}>
                    {expanded ? t("Hide details") : t("View details")}
                </button>
            </div>
            {expanded ? (
                <div className="dsh-dynamic-plugin-details">
                    <div><span>{t("Agent")}</span><code>{row.agentId}</code></div>
                    {row.currentPackageId ? <div><span>{t("Current package")}</span><code>{row.currentPackageId}</code></div> : null}
                    {row.nextPackageId ? <div><span>{t("Next package")}</span><code>{row.nextPackageId}</code></div> : null}
                    {latest ? <div><span>{t("Run")}</span><code>{latest.pluginRunId} · {latest.status}</code></div> : null}
                    {latest?.approvalRequestId ? <div><span>{t("Approval request")}</span><code>{latest.approvalRequestId}</code></div> : null}
                    <details>
                        <summary>{t("Packages")}</summary>
                        <ul>
                            {row.packages.map((pkg) => (
                                <li key={pkg.packageId}>
                                    <strong>{pkg.name}</strong> <code>{pkg.packageId}</code>
                                    <small>{pkg.purpose}</small>
                                </li>
                            ))}
                        </ul>
                    </details>
                </div>
            ) : null}
        </li>
    );
}

function groupRows(rows: readonly DshDynamicPluginRow[], currentSessionId: string | undefined): {
    current: DshDynamicPluginRow[];
    other: DshDynamicPluginRow[];
} {
    if (currentSessionId === undefined) return { current: [], other: [...rows] };
    return {
        current: rows.filter((row) => row.agentId === currentSessionId),
        other: rows.filter((row) => row.agentId !== currentSessionId),
    };
}

export function DynamicPluginsPanel({
    plugins,
    currentSessionId,
}: {
    plugins: DshDynamicPluginPanelView;
    currentSessionId: ChatViewState["sessionId"];
}): React.JSX.Element {
    const [showAll, setShowAll] = useState(false);
    const groups = useMemo(() => groupRows(plugins.rows, currentSessionId), [plugins.rows, currentSessionId]);
    const rows = showAll || currentSessionId === undefined ? plugins.rows : groups.current;
    const hiddenCount = currentSessionId === undefined || showAll ? 0 : groups.other.length;
    const awaiting = plugins.rows.filter((row) => statusOf(row) === "awaiting-approval").length;

    return (
        <div className="dsh-dynamic-plugins" aria-label={t("Dynamic plugins")}>
            <div className="dsh-dynamic-plugins-head">
                <div>
                    <strong>{t("Dynamic plugins")}</strong>
                    <small>{t("Read-only state; removal stops future package use")}</small>
                </div>
                <button
                    type="button"
                    disabled={plugins.loading}
                    title={t("Refresh dynamic plugins")}
                    onClick={() => postAction({ type: "refreshDynamicPlugins" })}
                >
                    {t("Refresh")}
                </button>
            </div>
            {plugins.loading && plugins.rows.length === 0 ? <div className="dsh-settings-loading">{t("Reading dynamic plugins...")}</div> : null}
            {plugins.error ? <div className="dsh-dynamic-plugin-error" role="alert">{plugins.error}</div> : null}
            {!plugins.loading && !plugins.error && plugins.rows.length === 0 ? <div className="dsh-settings-empty">{t("No dynamic plugins.")}</div> : null}
            {awaiting > 0 ? <div className="dsh-dynamic-plugin-approval" role="status">{t("{count} plugin approval(s) waiting in the dsh Web UI", { count: awaiting })}</div> : null}
            {hiddenCount > 0 ? (
                <button type="button" className="dsh-dynamic-plugin-show-all" onClick={() => setShowAll(true)}>
                    {t("Show {count} plugins from other sessions", { count: hiddenCount })}
                </button>
            ) : null}
            {rows.length > 0 ? (
                <ul className="dsh-dynamic-plugin-rows">
                    {rows.map((row) => <DynamicPluginRow key={row.pluginId} row={row} />)}
                </ul>
            ) : null}
        </div>
    );
}
