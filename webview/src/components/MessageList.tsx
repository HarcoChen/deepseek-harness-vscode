import React, { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { ChatMessage, DshMessageFeedbackStateView } from "../../../src/types";
import { postAction, subscribeRevealMessage } from "../bridge";
import { t } from "../i18n";
import { closestElement, handleMarkdownClick, handleMarkdownKeydown } from "./markdownEvents";
import { MessageItem } from "./MessageItem";

interface MessageListProps {
    messages: ChatMessage[];
    submitting: boolean;
    agentStatusLabel?: string;
    messageFeedback?: DshMessageFeedbackStateView;
}

/** Structural equality for plain host-projected data (no functions, no cycles). */
function deepEqual(left: unknown, right: unknown): boolean {
    if (left === right) return true;
    if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
        return false;
    }
    if (Array.isArray(left) || Array.isArray(right)) {
        return (
            Array.isArray(left) &&
            Array.isArray(right) &&
            left.length === right.length &&
            left.every((item, index) => deepEqual(item, right[index]))
        );
    }
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord);
    return (
        leftKeys.length === Object.keys(rightRecord).length &&
        leftKeys.every((key) => deepEqual(leftRecord[key], rightRecord[key]))
    );
}

/**
 * The host rebuilds every ChatMessage object on each full-state push, so
 * reference equality never holds. Reconcile incoming messages against the
 * previous push and reuse unchanged object (and array) references, which lets
 * the memoized MessageItem rows skip re-rendering during streaming and on
 * unrelated updates such as token usage refreshes.
 */
function useStableMessages(messages: ChatMessage[]): ChatMessage[] {
    const previousRef = useRef<ChatMessage[]>([]);
    return useMemo(() => {
        const previous = previousRef.current;
        const byId = new Map(previous.map((message) => [message.id, message]));
        const reconciled = messages.map((message) => {
            const prior = byId.get(message.id);
            return prior && deepEqual(prior, message) ? prior : message;
        });
        const stable =
            reconciled.length === previous.length &&
            reconciled.every((message, index) => message === previous[index])
                ? previous
                : reconciled;
        previousRef.current = stable;
        return stable;
    }, [messages]);
}

export const MessageList = React.memo(function MessageList({
    messages,
    submitting,
    agentStatusLabel,
    messageFeedback,
}: MessageListProps): React.JSX.Element {
    const listRef = useRef<HTMLDivElement>(null);
    const stickToBottomRef = useRef(true);
    const pendingRevealRef = useRef<number[]>([]);
    const stableMessages = useStableMessages(messages);

    useEffect(() => subscribeRevealMessage((seq) => {
        const target = listRef.current?.querySelector<HTMLElement>(`[data-message-seq="${seq}"]`);
        if (target) {
            target.scrollIntoView({ behavior: "smooth", block: "center" });
        } else {
            pendingRevealRef.current.push(seq);
        }
    }), []);

    useLayoutEffect(() => {
        const list = listRef.current;
        if (list && stickToBottomRef.current) {
            list.scrollTop = list.scrollHeight;
        }
        const pending = pendingRevealRef.current.splice(0);
        for (const seq of pending) {
            listRef.current
                ?.querySelector<HTMLElement>(`[data-message-seq="${seq}"]`)
                ?.scrollIntoView({ behavior: "smooth", block: "center" });
        }
    }, [stableMessages]);

    const onScroll = (): void => {
        const list = listRef.current;
        if (!list) return;
        stickToBottomRef.current =
            list.scrollHeight - list.scrollTop - list.clientHeight < 60;
    };

    const onClick = (event: React.MouseEvent): void => {
        const retry = closestElement(event.target, "[data-retry-id]");
        if (retry instanceof HTMLButtonElement && retry.dataset.retryId && !retry.disabled) {
            retry.disabled = true;
            postAction({ type: "retryPrompt", id: retry.dataset.retryId });
            return;
        }
        const trace = closestElement(event.target, "[data-trace-seq]");
        if (trace?.dataset.traceSeq !== undefined) {
            postAction({ type: "openTrace", seq: Number(trace.dataset.traceSeq) });
            return;
        }
        handleMarkdownClick(event.target);
    };

    return (
        <div
            className="dsh-messages"
            ref={listRef}
            onScroll={onScroll}
            onClick={onClick}
            onKeyDown={handleMarkdownKeydown}
        >
            {messageFeedback?.status === "error" && messageFeedback.error ? (
                <div className="dsh-feedback-status" role="status">
                    {messageFeedback.error}
                </div>
            ) : null}
            {stableMessages.length === 0 ? (
                <div className="dsh-empty">
                    <div className="dsh-empty-title">{t("Describe a task.")}</div>
                    <div className="dsh-empty-detail">
                        {t("The current selection is attached automatically. You can also use @ to reference files.")}
                        <br />
                        {t("Ctrl/Cmd + Enter to send.")}
                    </div>
                </div>
            ) : (
                stableMessages.map((message) => (
                    <MessageItem
                        key={message.id}
                        message={message}
                        submitting={submitting}
                        agentStatusLabel={agentStatusLabel}
                    />
                ))
            )}
        </div>
    );
});
