import React, { useEffect, useRef, useState } from "react";
import { t } from "../../i18n";
import { canSwitchPermissions, type ActivityDockState } from "../../state";
import { ChangesPanel } from "./ChangesPanel";
import { GoalPanel } from "./GoalPanel";
import { JobsPanel } from "./JobsPanel";
import { PermissionsPanel } from "./PermissionsPanel";
import { QueuePanel } from "./QueuePanel";
import { SchedulePanel } from "./SchedulePanel";
import { SubagentsPanel } from "./SubagentsPanel";
import { TodosPanel } from "./TodosPanel";

type DockTab = "todos" | "goal" | "queue" | "changes" | "subagents" | "jobs" | "schedule" | "permissions";

interface TabDef {
    id: DockTab;
    label: string;
    count?: number;
}

interface ActivityDockProps {
    goal: ActivityDockState["goal"];
    queue: ActivityDockState["queue"];
    changeReviews: ActivityDockState["changeReviews"];
    subagents: ActivityDockState["subagents"];
    subagentPreview: ActivityDockState["subagentPreview"];
    jobs: ActivityDockState["jobs"];
    todos: ActivityDockState["todos"];
    schedule: ActivityDockState["schedule"];
    permissions: ActivityDockState["permissions"];
    commands: ActivityDockState["commands"];
    sessionId: ActivityDockState["sessionId"];
    sessionRunning: boolean;
    agentPresetLabel: ActivityDockState["agentPresetLabel"];
}

export const ActivityDock = React.memo(function ActivityDock({
    goal,
    queue,
    changeReviews,
    subagents,
    subagentPreview,
    jobs,
    todos,
    schedule,
    permissions,
    commands,
    sessionId,
    sessionRunning,
    agentPresetLabel,
}: ActivityDockProps): React.JSX.Element | null {
    const [active, setActive] = useState<DockTab | null>(null);
    const [collapsed, setCollapsed] = useState(true);
    const tabRefs = useRef(new Map<DockTab, HTMLButtonElement>());
    const trimmedAgentPresetLabel = agentPresetLabel?.trim();
    const shortAgentPreset = trimmedAgentPresetLabel ? Array.from(trimmedAgentPresetLabel).slice(0, 4).join("") : undefined;

    const tabs: TabDef[] = [];
    if (todos?.length) {
        const pending = todos.filter((item) => item.status !== "completed").length;
        tabs.push({ id: "todos", label: t("Todo list"), count: pending || undefined });
    }
    if (goal) tabs.push({ id: "goal", label: "Goal" });
    if (queue.length) tabs.push({ id: "queue", label: t("Queue"), count: queue.length });
    if (changeReviews.length) {
        const count = changeReviews.reduce((total, review) => total + review.files.length, 0);
        tabs.push({ id: "changes", label: t("Changes"), count: count || undefined });
    }
    if (subagents && sessionId) {
        tabs.push({ id: "subagents", label: t("Subagents"), count: subagents.nodes.length || undefined });
    }
    if (jobs.length) tabs.push({ id: "jobs", label: "Jobs", count: jobs.length });
    if (schedule?.length) tabs.push({ id: "schedule", label: t("Schedule"), count: schedule.length });
    if (permissions) tabs.push({ id: "permissions", label: t("Permissions") });

    const available = tabs.map((tab) => tab.id).join(",");
    useEffect(() => {
        if (active && !available.split(",").includes(active)) {
            setActive(null);
            setCollapsed(true);
        }
    }, [available, active]);

    if (!tabs.length) return null;
    // Keep one tab selected for the ARIA tab pattern even while the dock body
    // is collapsed. The selected panel remains in the DOM and is hidden until
    // the user opens a tab, so every aria-controls reference stays resolvable.
    const selectedTab = active && tabs.some((tab) => tab.id === active) ? active : tabs[0].id;

    const onTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number): void => {
        let nextIndex: number | undefined;
        if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
        else if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
        else if (event.key === "Home") nextIndex = 0;
        else if (event.key === "End") nextIndex = tabs.length - 1;
        if (nextIndex === undefined) return;
        event.preventDefault();
        const next = tabs[nextIndex];
        setActive(next.id);
        tabRefs.current.get(next.id)?.focus();
    };

    const preview = subagentPreview?.rootSessionId === sessionId ? subagentPreview : undefined;

    return (
        <div className="dsh-dock">
            <div
                className="dsh-dock-tabs"
                role="tablist"
                aria-label={t("Activity tabs")}
                aria-orientation="horizontal"
            >
                {tabs.map((tab, index) => (
                    <button
                        key={tab.id}
                        id={`dsh-dock-tab-${tab.id}`}
                        ref={(element) => {
                            if (element) tabRefs.current.set(tab.id, element);
                            else tabRefs.current.delete(tab.id);
                        }}
                        type="button"
                        role="tab"
                        aria-selected={selectedTab === tab.id}
                        aria-expanded={selectedTab === tab.id && !collapsed}
                        aria-controls={`dsh-dock-panel-${tab.id}`}
                        tabIndex={selectedTab === tab.id ? 0 : -1}
                        className={`dsh-dock-tab${selectedTab === tab.id && !collapsed ? " active" : ""}`}
                        onClick={() => {
                            if (selectedTab === tab.id && !collapsed) {
                                setCollapsed(true);
                            } else {
                                setActive(tab.id);
                                setCollapsed(false);
                            }
                        }}
                        onKeyDown={(event) => onTabKeyDown(event, index)}
                    >
                        {tab.label}
                        {tab.count !== undefined ? <span className="dsh-badge">{tab.count}</span> : null}
                    </button>
                ))}
                {shortAgentPreset ? (
                    <span
                        className="dsh-dock-preset"
                        title={trimmedAgentPresetLabel}
                        aria-label={t("Current preset: {preset}", { preset: trimmedAgentPresetLabel ?? "" })}
                    >
                        {shortAgentPreset}
                    </span>
                ) : null}
            </div>
            {tabs.map((tab) => (
                <div
                    key={tab.id}
                    className="dsh-dock-panel"
                    role="tabpanel"
                    id={`dsh-dock-panel-${tab.id}`}
                    aria-labelledby={`dsh-dock-tab-${tab.id}`}
                    hidden={collapsed || selectedTab !== tab.id}
                >
                    {!collapsed && selectedTab === "todos" && tab.id === "todos" && todos ? <TodosPanel todos={todos} /> : null}
                    {!collapsed && selectedTab === "goal" && tab.id === "goal" && goal ? <GoalPanel goal={goal} /> : null}
                    {!collapsed && selectedTab === "queue" && tab.id === "queue" ? <QueuePanel queue={queue} running={sessionRunning} /> : null}
                    {!collapsed && selectedTab === "changes" && tab.id === "changes" ? <ChangesPanel reviews={changeReviews} running={sessionRunning} /> : null}
                    {!collapsed && selectedTab === "subagents" && tab.id === "subagents" && subagents ? <SubagentsPanel tree={subagents} preview={preview} /> : null}
                    {!collapsed && selectedTab === "jobs" && tab.id === "jobs" ? <JobsPanel jobs={jobs} /> : null}
                    {!collapsed && selectedTab === "schedule" && tab.id === "schedule" && schedule ? <SchedulePanel schedule={schedule} /> : null}
                    {!collapsed && selectedTab === "permissions" && tab.id === "permissions" && permissions ? <PermissionsPanel permissions={permissions} switchable={canSwitchPermissions(commands)} /> : null}
                </div>
            ))}
        </div>
    );
});
