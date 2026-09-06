import React from "react";
import { useHostState } from "./bridge";
import { Header } from "./components/Header";
import { MessageList } from "./components/MessageList";
import { Interactions } from "./components/Interactions";
import { ActivityDock } from "./components/dock/ActivityDock";
import { Composer } from "./components/Composer";
import { SettingsPanel } from "./components/SettingsPanel";
import { StatusBanner } from "./components/StatusBanner";

export function App(): React.JSX.Element {
    const state = useHostState();
    return (
        <div className={`dsh-shell${state.focusMode ? " dsh-focus-mode" : ""}`}>
            <Header
                status={state.status}
                sessionStatus={state.sessionStatus}
                sessions={state.sessions}
                sessionId={state.sessionId}
                currentWorkspace={state.currentWorkspace}
                draftWorkspaceId={state.draftWorkspaceId}
                draftWorkspaceTitle={state.draftWorkspaceTitle}
                focusMode={state.focusMode}
                pendingRequestCount={state.interactions.filter((interaction) => interaction.status === "pending").length}
            />
            <StatusBanner status={state.status} sessionStatus={state.sessionStatus} />
            {!state.focusMode && state.settings ? <SettingsPanel settings={state.settings} /> : null}
            <MessageList
                messages={state.messages}
                submitting={state.submitting}
                agentStatusLabel={state.agentStatusLabel}
            />
            {!state.focusMode ? <Interactions interactions={state.interactions} /> : null}
            {!state.focusMode ? (
                <ActivityDock
                    goal={state.goal}
                    queue={state.queue}
                    changeReviews={state.changeReviews}
                    subagents={state.subagents}
                    subagentPreview={state.subagentPreview}
                    jobs={state.jobs}
                    todos={state.todos}
                    schedule={state.schedule}
                    permissions={state.permissions}
                    commands={state.commands}
                    sessionId={state.sessionId}
                    sessionRunning={state.sessionStatus?.running === true}
                    agentPresetLabel={state.agentPresetLabel}
                />
            ) : null}
            <Composer
                context={state.context}
                selection={state.selection}
                selectionEnabled={state.selectionEnabled}
                fileReferenceCandidates={state.fileReferenceCandidates}
                skills={state.skills}
                commands={state.commands}
                permissions={state.permissions}
                tokenUsage={state.tokenUsage}
                sessionStats={state.sessionStats}
                reasoningEffort={state.reasoningEffort}
                imageLimits={state.imageLimits}
                plan={state.plan}
                busy={state.busy}
                submitting={state.submitting}
                cancelling={state.cancelling}
                sessionId={state.sessionId}
            />
        </div>
    );
}
