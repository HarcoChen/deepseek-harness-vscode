import React, { useEffect, useRef, useState } from "react";
import type { ChatViewAction } from "../../../src/chatViewProtocol";
import { postAction } from "../bridge";
import { t } from "../i18n";
import type { HeaderState } from "../state";
import { statusLabel, TURN_LABELS } from "../state";
import { CheckIcon, MoreIcon, SearchIcon } from "./icons";

interface HeaderProps {
    status: HeaderState["status"];
    sessionStatus: HeaderState["sessionStatus"];
    sessions: HeaderState["sessions"];
    sessionId: HeaderState["sessionId"];
    currentWorkspace: HeaderState["currentWorkspace"];
    draftWorkspaceId: HeaderState["draftWorkspaceId"];
    draftWorkspaceTitle: HeaderState["draftWorkspaceTitle"];
    focusMode: HeaderState["focusMode"];
    pendingRequestCount: number;
}

interface MenuItem {
    key: string;
    label: string;
    action: ChatViewAction;
    disabled?: boolean;
    active?: boolean;
    separatorBefore?: boolean;
}

const NEW_CURRENT_WORKSPACE = "__dsh_new_current_workspace__";

export const Header = React.memo(function Header({
    status,
    sessionStatus,
    sessions,
    sessionId,
    currentWorkspace,
    draftWorkspaceId,
    draftWorkspaceTitle,
    focusMode,
    pendingRequestCount,
}: HeaderProps): React.JSX.Element {
    const [menuOpen, setMenuOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!menuOpen) return;
        const onPointerDown = (event: MouseEvent): void => {
            if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
                setMenuOpen(false);
            }
        };
        const onEscape = (event: KeyboardEvent): void => {
            if (event.key === "Escape") setMenuOpen(false);
        };
        document.addEventListener("mousedown", onPointerDown);
        document.addEventListener("keydown", onEscape);
        return () => {
            document.removeEventListener("mousedown", onPointerDown);
            document.removeEventListener("keydown", onEscape);
        };
    }, [menuOpen]);

    const turn = sessionStatus?.turn;
    const runtimeReady = status.state === "running";
    const dotClass = !runtimeReady
        ? status.state
        : sessionStatus?.error
          ? "error"
          : sessionStatus?.attention
            ? "starting"
            : status.state;
    const canStartRuntime = status.state === "stopped" || status.state === "error";
    const label = !runtimeReady
        ? statusLabel(status)
        : (turn && TURN_LABELS[turn.phase]) ||
          (sessionStatus?.error ? t("Session error") : statusLabel(status));
    const turnTitle =
        (turn && Number.isSafeInteger(turn.turn) ? `Turn ${turn.turn}` : "") +
        (turn?.detail ? ` · ${turn.detail}` : "");
    const statusTitle = status.message || turnTitle;
    const groupedSessions = new Map<string, typeof sessions>();
    const ungroupedSessions: typeof sessions = [];
    for (const session of sessions) {
        if (!session.workspaceId || !session.workspaceTitle) {
            ungroupedSessions.push(session);
            continue;
        }
        const group = groupedSessions.get(session.workspaceId) ?? [];
        group.push(session);
        groupedSessions.set(session.workspaceId, group);
    }
    const hasSession = Boolean(sessionId);
    const runtimeRunning = status.state === "running" || status.state === "starting";
    const recoveryRunning = status.state === "recovering";

    const menuItems: MenuItem[] = [
        { key: "rename", label: t("Rename session"), action: { type: "renameSession" }, disabled: !hasSession },
        { key: "fork", label: t("Fork session"), action: { type: "forkSession" }, disabled: !hasSession },
        { key: "archive", label: t("Archive session"), action: { type: "archiveSession" }, disabled: !hasSession },
        { key: "trace", label: t("Open session trace"), action: { type: "openTrace" }, disabled: !hasSession },
        {
            key: "runtime",
            label: recoveryRunning ? t("Cancel automatic recovery") : runtimeRunning ? t("Stop runtime") : t("Start runtime"),
            action: { type: recoveryRunning ? "cancelRecovery" : runtimeRunning ? "stop" : "start" },
            disabled: status.state === "starting",
            separatorBefore: true,
        },
        { key: "logs", label: t("Open runtime logs"), action: { type: "openLogs" } },
        { key: "browser", label: t("Open in browser"), action: { type: "openBrowser" } },
        { key: "workspaces", label: t("Manage workspaces"), action: { type: "manageWorkspaces" }, separatorBefore: true },
        { key: "presets", label: t("Manage agent presets"), action: { type: "manageAgentPresets" } },
        { key: "providers", label: t("Manage providers"), action: { type: "manageProviders" } },
        { key: "settings", label: t("Manage plugin settings"), action: { type: "manageSettings" } },
        { key: "key", label: t("Configure API key"), action: { type: "configureApiKey" } },
        {
            key: "focus",
            label: focusMode ? t("Focus mode: on") : t("Focus mode: off"),
            action: { type: "toggleFocus" },
            active: focusMode,
        },
    ];

    return (
        <header className="dsh-header">
            <div className="dsh-status" title={statusTitle || undefined}>
                <span className={`dsh-dot ${dotClass}`} />
                {canStartRuntime ? (
                    <button
                        type="button"
                        className="dsh-status-label dsh-status-action"
                        title={status.state === "error"
                            ? `${status.message || t("Startup failed")}\n${t("Click to retry")}`
                            : t("Click to start DSH Runtime")}
                        onClick={() => postAction({ type: "start" })}
                    >
                        {label}
                    </button>
                ) : (
                    <span className={`dsh-status-label${turn ? ` dsh-turn-${turn.phase}` : ""}`}>
                        {label}
                    </span>
                )}
            </div>
            <select
                className="dsh-session-select"
                title={t("Switch session")}
                value={sessionId ?? ""}
                disabled={sessions.length === 0 && !currentWorkspace}
                onChange={(event) => {
                    if (event.target.value === NEW_CURRENT_WORKSPACE) {
                        postAction({ type: "newSessionInCurrentWorkspace" });
                    } else if (event.target.value) {
                        postAction({ type: "switchSession", sessionId: event.target.value });
                    }
                }}
            >
                {sessions.length === 0 ? (
                    currentWorkspace ? (
                        <optgroup label={currentWorkspace.title}>
                            <option value={NEW_CURRENT_WORKSPACE}>{t("New conversation")}</option>
                        </optgroup>
                    ) : (
                        <option value="">{t("No sessions")}</option>
                    )
                ) : (
                    <>
                        {!sessionId && !draftWorkspaceId ? <option value="">{t("New conversation")}</option> : null}
                        {[...groupedSessions.entries()].map(([workspaceId, group]) => (
                            <optgroup key={workspaceId} label={group[0]?.workspaceTitle ?? workspaceId}>
                                {!sessionId && draftWorkspaceId === workspaceId ? (
                                    <option value="">{t("New conversation")}</option>
                                ) : currentWorkspace?.workspaceId === workspaceId ? (
                                    <option value={NEW_CURRENT_WORKSPACE}>{t("New conversation")}</option>
                                ) : null}
                                {group.map((session) => (
                                    <option key={session.sessionId} value={session.sessionId}>
                                        {session.attention ? "● " : session.running ? "▶ " : ""}
                                        {session.title}
                                    </option>
                                ))}
                            </optgroup>
                        ))}
                        {!sessionId && draftWorkspaceId && !groupedSessions.has(draftWorkspaceId) ? (
                            <optgroup label={draftWorkspaceTitle || draftWorkspaceId}>
                                <option value="">{t("New conversation")}</option>
                            </optgroup>
                        ) : null}
                        {currentWorkspace &&
                        (!currentWorkspace.workspaceId || !groupedSessions.has(currentWorkspace.workspaceId)) ? (
                            <optgroup label={currentWorkspace.title}>
                                <option value={NEW_CURRENT_WORKSPACE}>{t("New conversation")}</option>
                            </optgroup>
                        ) : null}
                        {ungroupedSessions.length > 0 ? (
                            <optgroup label={t("Ungrouped sessions")}>
                                {ungroupedSessions.map((session) => (
                                    <option key={session.sessionId} value={session.sessionId}>
                                        {session.attention ? "● " : session.running ? "▶ " : ""}
                                        {session.title}
                                    </option>
                                ))}
                            </optgroup>
                        ) : null}
                    </>
                )}
            </select>
            {focusMode && pendingRequestCount > 0 ? (
                <span
                    className="dsh-focus-badge"
                    role="status"
                    aria-label={t("{count} pending request(s)", { count: pendingRequestCount })}
                    title={t("{count} pending request(s)", { count: pendingRequestCount })}
                >
                    {pendingRequestCount}
                </span>
            ) : null}
            <button
                type="button"
                className="dsh-icon-button"
                title={t("Search sessions")}
                onClick={() => postAction({ type: "searchSession" })}
            >
                <SearchIcon size={16} />
            </button>
            <div className="dsh-menu-anchor" ref={menuRef}>
                <button
                    type="button"
                    className={`dsh-icon-button${menuOpen ? " active" : ""}`}
                    title={t("More actions")}
                    aria-expanded={menuOpen}
                    onClick={() => setMenuOpen((open) => !open)}
                >
                    <MoreIcon size={16} />
                </button>
                {menuOpen ? (
                    // Disclosure, not the ARIA menu pattern: these are plain buttons
                    // traversed with Tab and dismissed with Escape. Declaring
                    // role="menu"/"menuitem" (or aria-haspopup, which ARIA treats as
                    // synonymous with "menu") would promise arrow-key navigation this
                    // does not implement. See dock/ActivityDock.tsx for the
                    // roving-tabindex pattern to follow if that promise is ever made.
                    <div className="dsh-menu">
                        {menuItems.map((item) => (
                            <React.Fragment key={item.key}>
                                {item.separatorBefore ? <div className="dsh-menu-separator" /> : null}
                                <button
                                    type="button"
                                    className={`dsh-menu-item${item.active ? " active" : ""}`}
                                    disabled={item.disabled}
                                    onClick={() => {
                                        setMenuOpen(false);
                                        postAction(item.action);
                                    }}
                                >
                                    <span className="dsh-menu-check">
                                        {item.active ? <CheckIcon /> : null}
                                    </span>
                                    {item.label}
                                </button>
                            </React.Fragment>
                        ))}
                    </div>
                ) : null}
            </div>
        </header>
    );
});
