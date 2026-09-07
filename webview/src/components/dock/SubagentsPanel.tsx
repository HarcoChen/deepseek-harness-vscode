import React, { useEffect, useState } from "react";
import type { SubagentHistoryPreview, SubagentTimingView, SubagentTreeView } from "../../../../src/types";
import { postAction } from "../../bridge";
import { t } from "../../i18n";
import { handleMarkdownClick, handleMarkdownKeydown } from "../markdownEvents";
import { MessageContent } from "../MessageContent";

/** Project the durable timing cut into the duration visible to the user. */
function activityDuration(
    timing: SubagentTimingView | undefined,
    activity: "running" | "inactive",
    now: number,
): number | undefined {
    if (timing === undefined) return undefined;
    if (timing.active === undefined) return timing.settledMs;
    const end = activity === "running" ? now : timing.active.through;
    return timing.settledMs + Math.max(0, end - timing.active.since);
}

interface DurationParts {
    seconds: number;
    minutes: number;
    hours: number;
    days: number;
    totalHours: number;
}

function splitDuration(milliseconds: number): DurationParts {
    const totalSeconds = Math.floor(Math.max(0, milliseconds) / 1_000);
    const totalMinutes = Math.floor(totalSeconds / 60);
    const totalHours = Math.floor(totalMinutes / 60);
    return {
        seconds: totalSeconds % 60,
        minutes: totalMinutes % 60,
        hours: totalHours % 24,
        days: Math.floor(totalHours / 24),
        totalHours,
    };
}

/** Keep short durations precise while making long-running children scannable. */
function formatDuration(milliseconds: number): string {
    const { seconds, minutes, hours, days, totalHours } = splitDuration(milliseconds);
    if (days >= 365) {
        const years = Math.floor(days / 365);
        const months = Math.floor((days % 365) / 30);
        return months === 0
            ? t("~{years}y", { years })
            : t("~{years}y {months}mo", { years, months });
    }
    if (days >= 30) {
        const months = Math.floor(days / 30);
        const remainingDays = days % 30;
        return remainingDays === 0
            ? t("~{months}mo", { months })
            : t("~{months}mo {days}d", { months, days: remainingDays });
    }
    if (days > 0) {
        return hours === 0
            ? t("{days}d", { days })
            : t("{days}d {hours}h", { days, hours });
    }
    if (totalHours > 0) {
        return t("{hours}h {minutes}m {seconds}s", {
            hours: totalHours,
            minutes: String(minutes).padStart(2, "0"),
            seconds: String(seconds).padStart(2, "0"),
        });
    }
    if (minutes > 0) {
        return t("{minutes}m {seconds}s", {
            minutes,
            seconds: String(seconds).padStart(2, "0"),
        });
    }
    return t("{seconds}s", { seconds });
}

/** Preserve an exact day/hour/minute/second value for hover text. */
function formatExactDuration(milliseconds: number): string {
    const { seconds, minutes, hours, days } = splitDuration(milliseconds);
    if (days === 0) return formatDuration(milliseconds);
    return t("{days}d {hours}h {minutes}m {seconds}s", {
        days,
        hours: String(hours).padStart(2, "0"),
        minutes: String(minutes).padStart(2, "0"),
        seconds: String(seconds).padStart(2, "0"),
    });
}

function SubagentPreviewCard({ preview, now }: { preview: SubagentHistoryPreview; now: number }): React.JSX.Element {
    const [followUp, setFollowUp] = useState("");
    const busy = Boolean(preview.pendingAction);
    const canFollowUp = preview.parentAvailable && !busy;
    const durationMs = activityDuration(preview.timing, preview.activity, now);
    const duration = durationMs === undefined ? undefined : formatDuration(durationMs);
    const durationTitle = durationMs === undefined ? undefined : formatExactDuration(durationMs);
    const sendFollowUp = (): void => {
        const text = followUp.trim();
        if (!text || !canFollowUp) return;
        setFollowUp("");
        postAction({ type: "followUpSubagent", childSessionId: preview.childSessionId, text });
    };
    return (
        <div className="dsh-card">
            <div className="dsh-feature-head">
                <div className="dsh-card-title">{preview.label}</div>
                <button type="button" className="dsh-button dsh-button-secondary" onClick={() => postAction({ type: "closeSubagent" })}>{t("Close")}</button>
            </div>
            <div className="dsh-card-detail" title={durationTitle === undefined ? undefined : t("Total active duration: {duration}", { duration: durationTitle })}>
                {preview.mode} · {preview.activity}
                {duration === undefined ? "" : ` · ${t("duration: {duration}", { duration })}`}
                {" · "}{preview.parentAvailable ? t("parent available") : t("parent unavailable")}
            </div>
            {preview.state === "loading" ? <div className="dsh-card-detail">{t("Loading history...")}</div> : null}
            {preview.error ? <div className="dsh-card-error">{preview.error}</div> : null}
            {preview.pendingAction ? <div className="dsh-card-detail">{t("Running {operation}...", { operation: preview.pendingAction })}</div> : null}
            {preview.messages.length ? (
                <div className="dsh-subagent-transcript" tabIndex={0} onClick={(event) => handleMarkdownClick(event.target)} onKeyDown={handleMarkdownKeydown}>
                    {preview.messages.map((message) => (
                        <div
                            className={`dsh-message dsh-role-${message.role}`}
                            key={message.id}
                            {...(typeof message.renderId === "string" ? { "data-render-id": message.renderId } : {})}
                        >
                            <div className="dsh-message-label">
                                {message.role === "assistant" ? "subagent" : message.role === "user" ? t("You") : t("System")}
                            </div>
                            <MessageContent message={message} />
                        </div>
                    ))}
                </div>
            ) : null}
            {preview.mode === "continuable" ? (
                <div className="dsh-follow-up">
                    <input
                        placeholder={t("Add a task for the continuable subagent")}
                        value={followUp}
                        disabled={!canFollowUp}
                        onChange={(event) => setFollowUp(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") {
                                event.preventDefault();
                                sendFollowUp();
                            }
                        }}
                    />
                    <button type="button" className="dsh-button" disabled={!canFollowUp || !followUp.trim()} onClick={sendFollowUp}>{t("Send")}</button>
                </div>
            ) : null}
            {preview.mode === "continuable" && preview.activity === "running" ? (
                <div className="dsh-card-actions">
                    <button
                        type="button"
                        className="dsh-button dsh-button-secondary"
                        disabled={busy}
                        onClick={() => postAction({ type: "interruptSubagent", childSessionId: preview.childSessionId })}
                    >
                        {t("Interrupt")}
                    </button>
                </div>
            ) : null}
        </div>
    );
}

export function SubagentsPanel({ tree, preview }: { tree: SubagentTreeView; preview?: SubagentHistoryPreview }): React.JSX.Element {
    const [now, setNow] = useState(() => Date.now());
    const hasRunningTiming = tree.nodes.some(
        (node) => node.kind === "child" && node.activity === "running" && node.timing?.active !== undefined,
    ) || (preview?.activity === "running" && preview.timing?.active !== undefined);
    useEffect(() => {
        if (!hasRunningTiming) return;
        const timer = window.setInterval(() => setNow(Date.now()), 1_000);
        return () => window.clearInterval(timer);
    }, [hasRunningTiming]);
    const statusText = tree.state === "loading"
        ? t("Loading...")
        : tree.state === "error"
          ? tree.error || t("Loading failed")
          : tree.nodes.length
            ? ""
            : t("No subagents");
    return (
        <div>
            <div className="dsh-feature-head">
                <div className="dsh-dock-title">{t("Subagent Tree")}</div>
                <button type="button" className="dsh-button dsh-button-secondary" disabled={tree.state === "loading"} onClick={() => postAction({ type: "refreshSubagents" })}>{t("Refresh")}</button>
            </div>
            {statusText ? <div className="dsh-card-detail">{statusText}</div> : null}
            {tree.nodes.map((node) => {
                const depthClass = `dsh-tree-depth-${Math.min(8, Math.max(0, Number(node.depth || 1) - 1))}`;
                if (node.kind === "diagnostic") {
                    return (
                        <div className={`dsh-tree-row ${depthClass}`} key={node.id}>
                            <div>
                                <div className="dsh-tree-label">{node.id}</div>
                                <div className="dsh-tree-meta">{t("diagnostic · {reason} · parent {parent}", { reason: node.reason || "", parent: node.parentSessionId })}</div>
                            </div>
                        </div>
                    );
                }
                const durationMs = node.activity === undefined
                    ? undefined
                    : activityDuration(node.timing, node.activity, now);
                const duration = durationMs === undefined ? undefined : formatDuration(durationMs);
                const durationTitle = durationMs === undefined ? undefined : formatExactDuration(durationMs);
                const meta = [
                    node.mode,
                    node.activity,
                    duration === undefined ? undefined : t("duration: {duration}", { duration }),
                    node.hasChildren ? t("has children") : t("leaf"),
                    node.parentAvailable ? t("parent available") : t("parent unavailable"),
                ].filter(Boolean).join(" · ");
                return (
                    <div className={`dsh-tree-row ${depthClass}`} key={node.id}>
                        <div>
                            <div className="dsh-tree-label">{node.label || node.id}</div>
                            <div className="dsh-tree-meta" title={durationTitle === undefined ? undefined : t("Total active duration: {duration}", { duration: durationTitle })}>{meta}<br />{t("parent {parent}", { parent: node.parentSessionId })}</div>
                        </div>
                        <button type="button" className="dsh-button dsh-button-secondary" onClick={() => postAction({ type: "openSubagent", childSessionId: node.id })}>{t("History")}</button>
                    </div>
                );
            })}
            {preview ? <SubagentPreviewCard preview={preview} now={now} /> : null}
        </div>
    );
}
