import React, { useCallback, useEffect, useRef, useState } from "react";
import type { DshReferenceCandidate } from "../../../src/types";
import { postAction, subscribeAddImageDraft, subscribeInsertText, subscribeSetText } from "../bridge";
import { t } from "../i18n";
import { canSwitchPermissions, canTogglePlan, type ComposerState } from "../state";
import { AppShotIcon, ImageIcon, PlusIcon, SendIcon, StopIcon, TerminalIcon } from "./icons";
import { ImageDraftRail, useImageDrafts } from "./ImageDrafts";
import { ContextChips } from "./ContextChips";
import { FILE_REFERENCE_MENU_ID, FileReferenceMenu } from "./FileReferenceMenu";
import { PermissionModeChip } from "./PermissionModeChip";
import { ReasoningEffortControl } from "./ReasoningEffortControl";
import { SessionStats } from "./SessionStats";
import { TokenUsageBar } from "./TokenUsageBar";
import { SKILL_MENU_ID, SLASH_MENU_ID, useSlashCompletion } from "./useSlashCompletion";
import { SlashCompletionMenu, SkillCompletionMenu } from "./CompletionMenu";

const MIN_HEIGHT = 56;
const MAX_HEIGHT = 180;

interface ComposerProps {
    context: ComposerState["context"];
    selection: ComposerState["selection"];
    selectionEnabled: ComposerState["selectionEnabled"];
    fileReferenceCandidates: ComposerState["fileReferenceCandidates"];
    skills: ComposerState["skills"];
    commands: ComposerState["commands"];
    permissions: ComposerState["permissions"];
    tokenUsage: ComposerState["tokenUsage"];
    sessionStats: ComposerState["sessionStats"];
    reasoningEffort: ComposerState["reasoningEffort"];
    imageLimits: ComposerState["imageLimits"];
    plan: ComposerState["plan"];
    busy: ComposerState["busy"];
    submitting: ComposerState["submitting"];
    cancelling: ComposerState["cancelling"];
    sessionId: ComposerState["sessionId"];
}

export const Composer = React.memo(function Composer({
    context,
    selection,
    selectionEnabled,
    fileReferenceCandidates,
    skills,
    commands,
    permissions,
    tokenUsage,
    sessionStats,
    reasoningEffort,
    imageLimits,
    plan,
    busy,
    submitting,
    cancelling,
    sessionId,
}: ComposerProps): React.JSX.Element {
    const [text, setText] = useState("");
    const [promptMode, setPromptMode] = useState<"queue" | "steer">("queue");
    const [effortVisible, setEffortVisible] = useState(false);
    const [attachmentMenuVisible, setAttachmentMenuVisible] = useState(false);
    const [referenceIndex, setReferenceIndex] = useState(0);
    const [dismissedReferenceKey, setDismissedReferenceKey] = useState<string>();
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const attachmentMenuRef = useRef<HTMLDivElement>(null);
    const imageInputRef = useRef<HTMLInputElement>(null);
    const planToggleTargetRef = useRef<boolean>();
    const imageDrafts = useImageDrafts(imageLimits);
    // The projection exposes the requested state while a /plan transition is
    // pending. Fold it the same way as Harness UI: entering plan mode is
    // effective while pending, leaving it is effective immediately.
    const planActive = plan !== undefined && (plan.pending ? !plan.active : plan.active);
    const planCommandAvailable = canTogglePlan(commands);

    const togglePlan = useCallback((): void => {
        if (!planCommandAvailable) return;
        const next = !(planToggleTargetRef.current ?? planActive);
        planToggleTargetRef.current = next;
        postAction({
            type: "setPlanMode",
            active: next,
        });
    }, [planActive, planCommandAvailable]);

    // Once the projection is no longer pending it is authoritative again; a
    // new session also must not inherit a queued target from the old one.
    useEffect(() => {
        if (plan === undefined || !plan.pending) planToggleTargetRef.current = undefined;
    }, [plan?.active, plan?.pending]);
    useEffect(() => {
        planToggleTargetRef.current = undefined;
    }, [sessionId]);

    useEffect(() => {
        return subscribeAddImageDraft((image) => imageDrafts.addUploads([image]));
    }, [imageDrafts.addUploads]);

    const focusTextarea = useCallback((): void => {
        textareaRef.current?.focus();
    }, []);
    const onShowEffort = useCallback((): void => setEffortVisible(true), []);
    const completion = useSlashCompletion({
        text,
        setText,
        skills,
        commands,
        reasoningEffort,
        onShowEffort,
        focusTextarea,
    });

    // Legacy behavior: the queue/steer choice resets to queue once the session is idle.
    useEffect(() => {
        if (!busy) setPromptMode("queue");
    }, [busy]);
    useEffect(() => setEffortVisible(false), [sessionId]);
    useEffect(() => {
        if (!attachmentMenuVisible) return;
        const onPointerDown = (event: PointerEvent): void => {
            if (event.target instanceof Node && !attachmentMenuRef.current?.contains(event.target)) {
                setAttachmentMenuVisible(false);
            }
        };
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === "Escape") setAttachmentMenuVisible(false);
        };
        document.addEventListener("pointerdown", onPointerDown);
        document.addEventListener("keydown", onKeyDown);
        return () => {
            document.removeEventListener("pointerdown", onPointerDown);
            document.removeEventListener("keydown", onKeyDown);
        };
    }, [attachmentMenuVisible]);

    const autoGrow = useCallback((): void => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        textarea.style.height = "auto";
        textarea.style.height = `${Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, textarea.scrollHeight))}px`;
    }, [reasoningEffort]);

    useEffect(() => {
        autoGrow();
    }, [text, autoGrow]);

    // Host-initiated insertion (dsh.insertEditorReference): insert at the caret,
    // separated by a space when the preceding char is not whitespace, then focus.
    useEffect(() => {
        return subscribeInsertText((insertion) => {
            const textarea = textareaRef.current;
            if (!textarea) return;
            const start = textarea.selectionStart;
            const end = textarea.selectionEnd;
            const before = textarea.value.slice(0, start);
            const separator = before && !/\s$/.test(before) ? " " : "";
            const next = before + separator + insertion + textarea.value.slice(end);
            setText(next);
            const cursor = start + separator.length + insertion.length;
            window.requestAnimationFrame(() => {
                textarea.setSelectionRange(cursor, cursor);
                textarea.focus();
            });
        });
    }, []);

    useEffect(() => {
        return subscribeSetText((draft) => {
            setText(draft);
            completion.resetSlashIndex();
            window.requestAnimationFrame(() => {
                const textarea = textareaRef.current;
                if (!textarea) return;
                textarea.setSelectionRange(draft.length, draft.length);
                textarea.focus();
            });
        });
    }, [completion.resetSlashIndex]);

    const send = useCallback((): void => {
        if (submitting) return;
        const value = textareaRef.current?.value ?? text;
        if (!value.trim() && imageDrafts.images.length === 0) return;
        if (imageDrafts.images.length === 0 && completion.executeSlashCommand(value.trim())) return;
        postAction({
            type: "sendPrompt",
            text: value,
            mode: busy ? promptMode : "queue",
            images: imageDrafts.images.map((image) => image.upload),
        });
        setText("");
        imageDrafts.clear();
    }, [completion.executeSlashCommand, imageDrafts, busy, submitting, promptMode, text]);

    const sendLabel = t("Send");
    const quotedReferenceMatch = text.match(/(?:^|\s)@"([^"]*)$/u);
    const plainReferenceMatch = text.match(/(?:^|\s)@([^\s@]*)$/u);
    const referenceMatch = quotedReferenceMatch ?? plainReferenceMatch;
    const referenceQuoted = quotedReferenceMatch !== null;
    const referenceQuery = referenceMatch?.[1] ?? "";
    const referenceCandidates = referenceMatch && fileReferenceCandidates?.length
        ? fileReferenceCandidates
        : [];
    const referenceCandidateKey = referenceCandidates
        .map((candidate) => `${candidate.kind}:${candidate.insertText}`)
        .join("\u0000");
    const referenceContextKey = (referenceQuoted ? "quoted" : "plain") + "\u0000" +
        referenceQuery + "\u0000" + referenceCandidateKey;
    const referenceMenuVisible = referenceCandidates.length > 0 && dismissedReferenceKey !== referenceContextKey;
    useEffect(() => {
        postAction({
            type: "fileReferenceQuery",
            query: referenceQuery,
            ...(referenceQuoted ? { quoted: true } : {}),
        });
    }, [referenceQuery, referenceQuoted, sessionId]);
    useEffect(() => {
        setReferenceIndex(0);
        setDismissedReferenceKey(undefined);
    }, [referenceContextKey]);

    const chooseFileReference = (candidate: DshReferenceCandidate): void => {
        const referenceStart = text.length - referenceQuery.length - (referenceQuoted ? 2 : 1);
        const prefix = text.slice(0, Math.max(0, referenceStart));
        const suffix = candidate.kind === "directory" ? "" : " ";
        setText(prefix + candidate.insertText + suffix);
        setReferenceIndex(0);
        window.requestAnimationFrame(focusTextarea);
    };

    const handleReferenceKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
        if (!referenceMenuVisible) return false;
        if (event.key === "ArrowDown") {
            event.preventDefault();
            setReferenceIndex((current) => (current + 1) % referenceCandidates.length);
            return true;
        }
        if (event.key === "ArrowUp") {
            event.preventDefault();
            setReferenceIndex((current) => (current - 1 + referenceCandidates.length) % referenceCandidates.length);
            return true;
        }
        if (event.key === "Enter" || event.key === "Tab") {
            event.preventDefault();
            chooseFileReference(referenceCandidates[referenceIndex] ?? referenceCandidates[0]);
            return true;
        }
        if (event.key === "Escape") {
            event.preventDefault();
            setDismissedReferenceKey(referenceContextKey);
            return true;
        }
        return false;
    };

    const activeMenuId = referenceMenuVisible
        ? FILE_REFERENCE_MENU_ID
        : completion.skillMatches.length
            ? SKILL_MENU_ID
            : completion.slashCandidateCount
                ? SLASH_MENU_ID
                : undefined;
    const activeDescendant = activeMenuId === FILE_REFERENCE_MENU_ID
        ? `${FILE_REFERENCE_MENU_ID}-option-${referenceIndex}`
        : activeMenuId
            ? `${activeMenuId}-option-${completion.slashIndex}`
            : undefined;

    return (
        <div className="dsh-composer">
            <ContextChips
                context={context}
                selection={selection}
                selectionEnabled={selectionEnabled}
                tokenUsage={tokenUsage}
            />
            {referenceMenuVisible ? (
                <FileReferenceMenu
                    candidates={referenceCandidates}
                    activeIndex={referenceIndex}
                    onSelect={chooseFileReference}
                />
            ) : null}
            {effortVisible ? (
                <ReasoningEffortControl
                    control={reasoningEffort}
                    submitting={submitting}
                    busy={busy}
                    onDismiss={() => setEffortVisible(false)}
                />
            ) : null}
            {busy ? (
                <div className="dsh-send-mode" aria-label={t("Runtime message mode")}>
                    <button
                        type="button"
                        className={promptMode === "queue" ? "active" : ""}
                        disabled={submitting}
                        onClick={() => setPromptMode("queue")}
                    >
                        {t("Queue")}
                    </button>
                    <button
                        type="button"
                        className={promptMode === "steer" ? "active" : ""}
                        disabled={submitting}
                        onClick={() => setPromptMode("steer")}
                    >
                        {t("Steer")}
                    </button>
                </div>
            ) : null}
            <ImageDraftRail
                images={imageDrafts.images}
                error={imageDrafts.error}
                onRemove={imageDrafts.remove}
            />
            <div
                className="dsh-composer-row"
                onDragOver={(event) => {
                    if (Array.from(event.dataTransfer.items).some((item) => item.kind === "file")) {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "copy";
                    }
                }}
                onDrop={(event) => {
                    const files = Array.from(event.dataTransfer.files).filter((file) => file.type.startsWith("image/"));
                    if (files.length === 0) return;
                    event.preventDefault();
                    void imageDrafts.addFiles(files);
                }}
            >
                <div className="dsh-menu-anchor dsh-attachment-anchor" ref={attachmentMenuRef}>
                    <button
                        type="button"
                        className="dsh-icon-button dsh-add-context"
                        title={t("Add attachment")}
                        aria-expanded={attachmentMenuVisible}
                        disabled={submitting}
                        onClick={() => setAttachmentMenuVisible((visible) => !visible)}
                    >
                        <PlusIcon />
                    </button>
                    {attachmentMenuVisible ? (
                        // Disclosure, not the ARIA menu pattern — see the note in Header.tsx.
                        <div className="dsh-menu dsh-attachment-menu">
                            <button
                                type="button"
                                className="dsh-menu-item"
                                onClick={() => {
                                    setAttachmentMenuVisible(false);
                                    postAction({ type: "openIdeContextPicker" });
                                }}
                            >
                                <PlusIcon />
                                {t("Add one-shot IDE context")}
                            </button>
                            <button
                                type="button"
                                className="dsh-menu-item"
                                onClick={() => {
                                    setAttachmentMenuVisible(false);
                                    postAction({ type: "openTerminalCommandPicker" });
                                }}
                            >
                                <TerminalIcon />
                                {t("Recent terminal command")}
                            </button>
                            <button
                                type="button"
                                className="dsh-menu-item"
                                onClick={() => {
                                    setAttachmentMenuVisible(false);
                                    imageInputRef.current?.click();
                                }}
                            >
                                <ImageIcon />
                                {t("Add images")}
                            </button>
                            <button
                                type="button"
                                className="dsh-menu-item"
                                onClick={() => {
                                    setAttachmentMenuVisible(false);
                                    postAction({ type: "captureAppShot" });
                                }}
                            >
                                <AppShotIcon />
                                {t("Capture AppShot")}
                            </button>
                        </div>
                    ) : null}
                    <input
                        ref={imageInputRef}
                        className="dsh-image-input"
                        type="file"
                        accept={imageDrafts.accept}
                        multiple
                        tabIndex={-1}
                        onChange={(event) => {
                            const files = Array.from(event.target.files ?? []);
                            event.target.value = "";
                            void imageDrafts.addFiles(files);
                        }}
                    />
                </div>
                <textarea
                    ref={textareaRef}
                    className="dsh-prompt"
                    placeholder={t(planActive
                        ? "Describe your task to generate a plan"
                        : "Describe a task; use @ for files, $ for skills...")}
                    value={text}
                    disabled={submitting}
                    rows={2}
                    aria-expanded={activeMenuId !== undefined}
                    aria-controls={activeMenuId}
                    aria-activedescendant={activeDescendant}
                    onChange={(event) => {
                        setText(event.target.value);
                        completion.resetSlashIndex();
                    }}
                    onPaste={(event) => {
                        const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
                        if (files.length === 0) return;
                        event.preventDefault();
                        void imageDrafts.addFiles(files);
                    }}
                    onKeyDown={(event) => {
                        // Shift+Tab toggles the public plan command when no
                        // completion popup owns Tab. Keep modified variants
                        // and native focus traversal untouched.
                        if (
                            event.key === "Tab" &&
                            event.shiftKey &&
                            !event.altKey &&
                            !event.ctrlKey &&
                            !event.metaKey &&
                            !event.repeat &&
                            !referenceMenuVisible &&
                            completion.skillMatches.length === 0 &&
                            completion.slashCandidateCount === 0
                        ) {
                            if (planCommandAvailable) {
                                event.preventDefault();
                                togglePlan();
                                return;
                            }
                        }
                        if (handleReferenceKeyDown(event)) return;
                        if (completion.handleCompletionKeyDown(event)) return;
                        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                            event.preventDefault();
                            send();
                        }
                    }}
                />
                <SlashCompletionMenu
                    commands={completion.slashMatches}
                    skills={completion.slashSkillMatches}
                    activeIndex={completion.slashIndex}
                    onChooseCommand={completion.chooseSlashCommand}
                    onChooseSkill={completion.chooseSkill}
                />
                <SkillCompletionMenu
                    skills={completion.skillMatches}
                    activeIndex={completion.slashIndex}
                    onChooseSkill={completion.chooseSkill}
                />
                <button
                    type="button"
                    className={`dsh-send-button${busy ? " dsh-button-secondary" : ""}`}
                    title={busy ? t("Stop") : sendLabel}
                    disabled={busy
                        ? cancelling
                        : submitting || (!text.trim() && imageDrafts.images.length === 0)}
                    onClick={() => {
                        if (busy) {
                            postAction({ type: "cancel" });
                        } else {
                            send();
                        }
                    }}
                >
                    {busy ? <StopIcon /> : <SendIcon />}
                    {busy
                        ? cancelling ? t("Stopping...") : t("Stop")
                        : sendLabel}
                </button>
            </div>
            <div className="dsh-composer-footer">
                {/* Rendered in both states so the toggle stays reachable by
                    pointer and screen reader, not only through Shift+Tab. A
                    Runtime without the command still shows a latched-on chip. */}
                {planActive || planCommandAvailable ? (
                    <button
                        type="button"
                        className={`dsh-plan-chip${planActive ? "" : " dsh-plan-chip-off"}`}
                        title={planActive
                            ? t("Plan mode on — click to turn off (/plan off)")
                            : t("Plan mode off — click to turn on (/plan on)")}
                        aria-label={planActive
                            ? t("Plan mode on, click to turn off")
                            : t("Plan mode off, click to turn on")}
                        aria-pressed={planActive}
                        disabled={!planCommandAvailable}
                        onClick={togglePlan}
                    >
                        <span>Plan</span>
                        {planActive ? <span aria-hidden="true">×</span> : null}
                    </button>
                ) : null}
                <PermissionModeChip
                    permissions={permissions}
                    switchable={canSwitchPermissions(commands)}
                />
                <TokenUsageBar usage={tokenUsage} />
                <SessionStats stats={sessionStats} />
            </div>
        </div>
    );
});
