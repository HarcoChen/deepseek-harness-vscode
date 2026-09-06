import React, { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../../../src/types";
import { postAction } from "../bridge";
import { t } from "../i18n";
import { ROLE_LABELS } from "../state";
import { MessageContent } from "./MessageContent";
import { MoreIcon } from "./icons";

export { MessageContent } from "./MessageContent";

interface MessageItemProps {
    message: ChatMessage;
    submitting: boolean;
    agentStatusLabel?: string;
}

type CheckpointAction =
    | "forkFromMessage"
    | "restoreCodeToMessage"
    | "forkAndRestoreCodeToMessage";

function MessageCheckpointMenu({ seq }: { seq: number }): React.JSX.Element {
    const [open, setOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const onPointerDown = (event: MouseEvent): void => {
            if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
                setOpen(false);
            }
        };
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === "Escape") setOpen(false);
        };
        document.addEventListener("mousedown", onPointerDown);
        document.addEventListener("keydown", onKeyDown);
        return () => {
            document.removeEventListener("mousedown", onPointerDown);
            document.removeEventListener("keydown", onKeyDown);
        };
    }, [open]);

    const run = (type: CheckpointAction): void => {
        postAction({ type, seq });
        setOpen(false);
    };

    return (
        <div className={`dsh-message-actions${open ? " open" : ""}`} ref={menuRef}>
            <button
                type="button"
                className="dsh-message-action-trigger dsh-icon-button"
                aria-label={t("Message actions")}
                aria-expanded={open}
                title={t("Message actions")}
                onClick={(event) => {
                    event.stopPropagation();
                    setOpen((current) => !current);
                }}
            >
                <MoreIcon />
            </button>
            {open ? (
                <div className="dsh-message-action-menu">
                    <button type="button" onClick={(event) => { event.stopPropagation(); run("forkFromMessage"); }}>
                        {t("Fork from here")}
                    </button>
                    <button type="button" onClick={(event) => { event.stopPropagation(); run("restoreCodeToMessage"); }}>
                        {t("Restore code to here")}
                    </button>
                    <button type="button" onClick={(event) => { event.stopPropagation(); run("forkAndRestoreCodeToMessage"); }}>
                        {t("Fork + restore code")}
                    </button>
                </div>
            ) : null}
        </div>
    );
}

export const MessageItem = React.memo(function MessageItem({
    message,
    submitting,
    agentStatusLabel,
}: MessageItemProps): React.JSX.Element {
    const stateClass =
        message.state === "streaming"
            ? " dsh-streaming"
            : message.state === "pending"
              ? " dsh-pending"
              : "";
    const stateLabel =
        message.state === "pending"
            ? t(" · waiting for response")
            : message.state === "streaming" && message.role === "assistant"
              ? ` · ${agentStatusLabel ?? t("Thinking...")}`
              : message.state === "streaming"
                ? t(" · streaming")
              : "";
    const hasTrace = Number.isSafeInteger(message.seq) && (message.seq ?? -1) >= 0;
    const checkpointSeq =
        (message.role === "user" || message.role === "assistant") &&
        message.state !== "streaming" &&
        message.state !== "pending" &&
        typeof message.seq === "number" &&
        Number.isSafeInteger(message.seq) &&
        message.seq >= 0
            ? message.seq
            : undefined;
    return (
        <div
            className={`dsh-message dsh-role-${message.role}${stateClass}`}
            {...(typeof message.renderId === "string"
                ? { "data-render-id": message.renderId }
                : {})}
            {...(Number.isSafeInteger(message.seq) ? { "data-message-seq": message.seq } : {})}
        >
            <div className="dsh-message-label">
                {ROLE_LABELS[message.role]}
                {stateLabel}
                {hasTrace ? (
                    <button
                        type="button"
                        className="dsh-message-trace"
                        data-trace-seq={message.seq}
                        title={t("Locate in Trace")}
                    >
                        trace
                    </button>
                ) : null}
                {checkpointSeq === undefined ? null : <MessageCheckpointMenu seq={checkpointSeq} />}
            </div>
            <MessageContent message={message} agentStatusLabel={agentStatusLabel} />
            {message.state === "failed" ? (
                <button
                    type="button"
                    className="dsh-message-retry dsh-button-secondary"
                    data-retry-id={message.id}
                    disabled={submitting}
                >
                    {t("Retry")}
                </button>
            ) : null}
        </div>
    );
});
