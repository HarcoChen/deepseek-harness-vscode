import React, { useEffect, useState } from "react";
import type { TokenUsageView } from "../../../src/types";
import { numberFormatter, t } from "../i18n";
import { postAction } from "../bridge";

interface TokenUsageBarProps {
    usage: TokenUsageView | undefined;
}

interface RingProps {
    percent: number | undefined;
    size: "small" | "large";
    severity: "normal" | "warning" | "critical";
}

interface ChartRowProps {
    label: string;
    tokens: number | undefined;
    maximum: number;
    kind:
        | "input"
        | "output"
        | "reasoning"
        | "cache-read"
        | "cache-write"
        | "system"
        | "tools"
        | "messages";
    suffix?: string;
    title: string;
}

function compactTokens(tokens: number): string {
    if (tokens < 1_000) return numberFormatter.format(tokens);
    if (tokens < 1_000_000) return `${numberFormatter.format(tokens / 1_000)}K`;
    return `${numberFormatter.format(tokens / 1_000_000)}M`;
}

function UsageRing({ percent, size, severity }: RingProps): React.JSX.Element {
    const progress = Math.min(100, Math.max(0, percent ?? 0));
    return (
        <span className={`dsh-usage-ring ${size} ${severity}`} aria-hidden="true">
            <svg viewBox="0 0 36 36">
                <circle className="track" cx="18" cy="18" r="14.5" pathLength="100" />
                <circle
                    className="progress"
                    cx="18"
                    cy="18"
                    r="14.5"
                    pathLength="100"
                    strokeDasharray={`${progress} 100`}
                />
            </svg>
            <span>{percent === undefined ? "--" : `${Math.round(percent)}%`}</span>
        </span>
    );
}

function ChartRow({
    label,
    tokens,
    maximum,
    kind,
    suffix,
    title,
}: ChartRowProps): React.JSX.Element {
    const width = tokens === undefined
        ? 0
        : Math.min(100, Math.max(2, (tokens / maximum) * 100));
    return (
        <div className="dsh-token-chart-row" title={title}>
            <span className="dsh-token-chart-label">{label}</span>
            <span className="dsh-token-chart-track">
                <span className={`dsh-token-chart-fill ${kind}`} style={{ width: `${width}%` }} />
            </span>
            <span className="dsh-token-chart-value">
                {tokens === undefined ? "--" : compactTokens(tokens)}
                {suffix ? <small>{suffix}</small> : null}
            </span>
        </div>
    );
}

export function TokenUsageBar({ usage }: TokenUsageBarProps): React.JSX.Element | null {
    const [hovered, setHovered] = useState(false);
    const [focused, setFocused] = useState(false);

    const open = hovered || focused;

    useEffect(() => {
        if (!open) return;
        const onEscape = (event: KeyboardEvent): void => {
            if (event.key === "Escape") {
                setHovered(false);
                setFocused(false);
            }
        };
        document.addEventListener("keydown", onEscape);
        return () => {
            document.removeEventListener("keydown", onEscape);
        };
    }, [open]);

    if (!usage) return null;
    const { route, billing, context, breakdown } = usage;
    const routeLabel = route.model || t("Unknown model");
    const occupied = context?.projectedTokens;
    const capacity = context?.contextWindow;
    const occupancy = occupied !== undefined && capacity !== undefined
        ? (occupied / capacity) * 100
        : undefined;
    const severity = occupancy !== undefined && occupancy >= 95
        ? "critical"
        : occupancy !== undefined && occupancy >= 80
          ? "warning"
          : "normal";
    const promptTraffic = billing
        ? billing.uncachedInputTokens + billing.cacheReadTokens + billing.cacheWriteTokens
        : 0;
    const cacheHitRate = billing && promptTraffic > 0
        ? (billing.cacheReadTokens / promptTraffic) * 100
        : undefined;
    const chartMaximum = billing
        ? Math.max(
              1,
              billing.uncachedInputTokens,
              billing.outputTokens,
              billing.cacheReadTokens,
              billing.cacheWriteTokens,
          )
        : 1;
    // Scale the breakdown rows against their own total so the three parts read as
    // shares of the window, not against the billing chart's unrelated maximum.
    const breakdownTotal = breakdown
        ? breakdown.systemTokens + breakdown.toolsTokens + breakdown.messageTokens
        : 0;
    const breakdownMaximum = Math.max(1, breakdownTotal);

    return (
        <section className="dsh-usage" aria-label={t("Token and context usage")}>
            <div
                className="dsh-usage-context"
                onMouseEnter={() => setHovered(true)}
                onMouseLeave={() => setHovered(false)}
                onFocus={() => setFocused(true)}
                onBlur={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                        setFocused(false);
                    }
                }}
            >
                <button
                    type="button"
                    className="dsh-usage-context-trigger"
                    aria-expanded={open}
                    aria-controls="dsh-context-breakdown"
                    title={t("Show context breakdown")}
                    onClick={() => setFocused(true)}
                >
                    <UsageRing percent={occupancy} size="small" severity={severity} />
                    <span className="dsh-usage-summary-context">
                        {occupied === undefined ? "--" : compactTokens(occupied)} / {capacity === undefined ? "--" : compactTokens(capacity)}
                    </span>
                </button>
                {open ? (
                    <div
                        id="dsh-context-breakdown"
                        className="dsh-usage-panel"
                        role="dialog"
                        aria-label={t("Token statistics")}
                    >
                        <div className="dsh-usage-panel-head">
                            <div>
                                <strong>{t("Token statistics")}</strong>
                                <span>{routeLabel} · effort {route.reasoningEffort || t("Default")}</span>
                            </div>
                        </div>
                        <div
                            className="dsh-usage-context-stat"
                            title={t("Estimate based on the latest provider usage and current Surface changes")}
                        >
                            <UsageRing percent={occupancy} size="large" severity={severity} />
                            <div>
                                <span>{t("Context usage · estimated")}</span>
                                <strong>
                                    {occupied === undefined ? "--" : compactTokens(occupied)}
                                    <small> / {capacity === undefined ? "--" : compactTokens(capacity)}</small>
                                </strong>
                            </div>
                        </div>
                        {breakdown ? (
                            <div className="dsh-token-chart" aria-label={t("Context composition")}>
                                <div className="dsh-token-chart-head">
                                    <span>{t("What fills the context")}</span>
                                    <span>{t("Harness estimate")}</span>
                                </div>
                                <ChartRow
                                    label={t("System prompt")}
                                    tokens={breakdown.systemTokens}
                                    maximum={breakdownMaximum}
                                    kind="system"
                                    title={t("System prompt sections")}
                                />
                                <ChartRow
                                    label={t("Tools")}
                                    tokens={breakdown.toolsTokens}
                                    maximum={breakdownMaximum}
                                    kind="tools"
                                    title={t("Tool schemas offered to the model")}
                                />
                                <ChartRow
                                    label={t("Messages")}
                                    tokens={breakdown.messageTokens}
                                    maximum={breakdownMaximum}
                                    kind="messages"
                                    title={t("Conversation history after compaction")}
                                />
                            </div>
                        ) : null}
                        {billing ? (
                            <div className="dsh-token-chart" aria-label={t("Billed session token distribution")}>
                                <div className="dsh-token-chart-head">
                                    <span>{t("Billed session tokens")}</span>
                                    <span>{t("Provider usage")}</span>
                                </div>
                                <ChartRow
                                    label={t("Input")}
                                    tokens={billing.uncachedInputTokens}
                                    maximum={chartMaximum}
                                    kind="input"
                                    title={t("Uncached input tokens")}
                                />
                                <ChartRow
                                    label={t("Output")}
                                    tokens={billing.outputTokens}
                                    maximum={chartMaximum}
                                    kind="output"
                                    title={t("Output tokens")}
                                />
                                <ChartRow
                                    label={t("Reasoning")}
                                    tokens={billing.reasoningTokens}
                                    maximum={Math.max(1, billing.outputTokens)}
                                    kind="reasoning"
                                    suffix={t("Output subset")}
                                    title={t("Reasoning tokens are included in output")}
                                />
                                <ChartRow
                                    label={t("Cache read")}
                                    tokens={billing.cacheReadTokens}
                                    maximum={chartMaximum}
                                    kind="cache-read"
                                    suffix={cacheHitRate === undefined ? undefined : t("{rate}% hit", { rate: numberFormatter.format(cacheHitRate) })}
                                    title={t("Cache-read tokens and hit rate")}
                                />
                                <ChartRow
                                    label={t("Cache write")}
                                    tokens={billing.cacheWriteTokens}
                                    maximum={chartMaximum}
                                    kind="cache-write"
                                    title={t("Cache-write tokens")}
                                />
                            </div>
                        ) : (
                            <div className="dsh-usage-empty">{t("No provider billing data")}</div>
                        )}
                    </div>
                ) : null}
            </div>
            <button
                type="button"
                className="dsh-usage-model"
                title={t("Select the current session model")}
                onClick={() => postAction({ type: "selectModel" })}
            >
                <strong>{routeLabel}</strong>
            </button>
        </section>
    );
}
