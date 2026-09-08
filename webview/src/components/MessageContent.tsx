import React, { useEffect, useRef } from "react";
import type { ChatMessage } from "../../../src/types";
import { t } from "../i18n";
import { CompactionCard, ToolCard } from "./Cards";
import { MessageImages } from "./MessageImages";

/**
 * The reasoning fold auto-expands while reasoning streams in and auto-collapses
 * when streaming completes. The effect only writes `open` when `streaming`
 * flips, so manual toggling between the two transitions is never overridden.
 */
function ReasoningFold({
    message,
    agentStatusLabel,
    autoOpen,
}: {
    message: ChatMessage;
    agentStatusLabel?: string;
    autoOpen: boolean;
}): React.JSX.Element {
    const detailsRef = useRef<HTMLDetailsElement>(null);
    const streaming = message.reasoningState === "streaming";
    useEffect(() => {
        if (!autoOpen || !detailsRef.current) return;
        detailsRef.current.open = streaming;
    }, [autoOpen, streaming]);
    const reasoningBody = (
        <div
            className="dsh-message-body"
            {...(typeof message.renderedReasoningHtml === "string"
                ? { dangerouslySetInnerHTML: { __html: message.renderedReasoningHtml } }
                : { children: <p>{message.reasoning}</p> })}
        />
    );
    return (
        <details
            ref={detailsRef}
            className="dsh-message-reasoning"
            {...(typeof message.reasoningRenderId === "string"
                ? { "data-render-id": message.reasoningRenderId }
                : {})}
        >
            <summary>
                {streaming
                    ? agentStatusLabel ?? t("Thinking...")
                    : t("Reasoning · complete")}
            </summary>
            {reasoningBody}
        </details>
    );
}

/**
 * Body + optional reasoning fold. `renderedHtml` is fixed-vocabulary HTML produced
 * by the extension-host safe Markdown renderer, so it is injected verbatim.
 */
export function MessageContent({
    message,
    agentStatusLabel,
    autoOpenReasoning,
}: {
    message: ChatMessage;
    agentStatusLabel?: string;
    autoOpenReasoning?: boolean;
}): React.JSX.Element {
    if (message.role === "tool" && message.tool) {
        return <ToolCard tool={message.tool} />;
    }
    if (message.compaction) {
        return <CompactionCard message={message} />;
    }
    const body = message.text ? (
        <div
            className="dsh-message-body"
            {...(typeof message.renderedHtml === "string"
                ? { dangerouslySetInnerHTML: { __html: message.renderedHtml } }
                : { children: <p>{message.text}</p> })}
        />
    ) : null;
    const images = message.images?.length ? <MessageImages images={message.images} /> : null;
    // A direct skill invocation reads as an action, not as something the user
    // said, so the token is shown as itself rather than as literal prompt text.
    const skill = message.skillInvocation ? (
        <span className="dsh-skill-invocation" title={t("Invoked skill {name}", { name: message.skillInvocation })}>
            {`/${message.skillInvocation}`}
        </span>
    ) : null;
    if (message.role !== "assistant" || !message.reasoning) {
        return <>{images}{skill}{body}</>;
    }
    return (
        <>
            {images}
            {body}
            <ReasoningFold
                message={message}
                agentStatusLabel={agentStatusLabel}
                autoOpen={autoOpenReasoning !== false}
            />
        </>
    );
}
