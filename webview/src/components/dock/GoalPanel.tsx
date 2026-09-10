import React from "react";
import type { GoalHudView } from "../../../../src/types";
import { t } from "../../i18n";
import { postAction } from "../../bridge";
import { goalActionAllowed } from "../../../../src/goalActions";

const GOAL_PHASE_LABELS: Readonly<Record<NonNullable<GoalHudView["goal"]>["phase"], string>> = {
    active: "In progress",
    paused: "Paused",
    blocked: "Blocked",
    complete: "Completed",
};

function GoalError({ error }: { error: string }): React.JSX.Element {
    const [summary, ...detailLines] = error.split("\n");
    const detail = detailLines.join("\n").trim();
    return (
        <div className="dsh-goal-error">
            <div className="dsh-card-error" title={detail || undefined}>{summary || error}</div>
            {detail ? (
                <details className="dsh-goal-error-detail">
                    <summary>{t("Technical details")}</summary>
                    <pre tabIndex={0}>{detail}</pre>
                </details>
            ) : null}
        </div>
    );
}

function GoalPending({ goal }: { goal: GoalHudView }): React.JSX.Element | null {
    if (!goal.pending) return null;
    return (
        <div className="dsh-card-detail">
            {t("Running {operation}; waiting for the projection to converge...", {
                operation: goal.pendingOperation || t("mutation"),
            })}
        </div>
    );
}

function GoalHint({ empty }: { empty?: boolean }): React.JSX.Element {
    return (
        <div className="dsh-card-detail dsh-goal-hint">
            {t(empty ? "Use /goal <objective> to create a Goal." : "Use /goal to manage the Goal.")}
        </div>
    );
}

export function GoalPanel({ goal }: { goal: GoalHudView }): React.JSX.Element {
    if (goal.state === "invalid") {
        return (
            <div className="dsh-card">
                <GoalPending goal={goal} />
                <GoalError error={goal.error || t("Invalid Goal projection")} />
            </div>
        );
    }

    if (goal.state === "empty") {
        return (
            <div className="dsh-card">
                <div className="dsh-card-detail">{t("This session has no Goal yet.")}</div>
                <GoalHint empty />
                <GoalPending goal={goal} />
                {goal.error ? <GoalError error={goal.error} /> : null}
            </div>
        );
    }

    const current = goal.goal;
    if (!current) {
        return <div className="dsh-card"><div className="dsh-card-error">{t("Goal data is missing.")}</div></div>;
    }

    const roundsStarted = Number(goal.roundsStarted || 0);
    return (
        <div className="dsh-card">
            <div
                className="dsh-goal-objective"
                title={t("Goal revision {revision}", { revision: current.revision })}
            >
                {current.objective}
            </div>
            <div className="dsh-card-detail">
                {t("{phase} · round {started}/{maximum}", {
                    phase: t(current.phase === "active" && goal.activation === "disarmed"
                        ? "Waiting for resume" : GOAL_PHASE_LABELS[current.phase]),
                    started: roundsStarted,
                    maximum: current.maxGoalRounds,
                })}
            </div>
            <GoalHint />
            {current.phase === "active" && goal.activation === "disarmed" ? (
                <div className="dsh-card-actions">
                    <button
                        type="button"
                        className="dsh-button"
                        disabled={goal.pending || !goalActionAllowed(
                            current.phase, "resume", roundsStarted, current.maxGoalRounds, goal.activation,
                        )}
                        onClick={() => postAction({ type: "goalResume" })}
                    >{t("Resume")}</button>
                </div>
            ) : null}
            {current.blockedReason ? (
                <div className="dsh-goal-blocked" role="status">
                    <strong>{t("Blocked")}</strong>
                    <span>{current.blockedReason.code} · {current.blockedReason.message}</span>
                </div>
            ) : null}
            <GoalPending goal={goal} />
            {goal.error ? <GoalError error={goal.error} /> : null}
        </div>
    );
}
