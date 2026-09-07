import React from "react";
import type { DshTodoItemView } from "../../../../src/types";
import { t } from "../../i18n";

function progressLabel(todos: readonly DshTodoItemView[]): string {
    const done = todos.filter((item) => item.status === "completed").length;
    const active = todos.filter((item) => item.status === "in_progress").length;
    const pending = todos.length - done - active;
    return [
        done > 0 ? t("{count} completed", { count: done }) : "",
        active > 0 ? t("{count} in progress", { count: active }) : "",
        pending > 0 ? t("{count} pending", { count: pending }) : "",
    ].filter(Boolean).join(" · ");
}

/**
 * Todo list projection for the activity dock. The dock tab is the collapse
 * affordance now, so — unlike the retired standalone panel — this renders only
 * the progress summary and the item rows, no header of its own.
 */
export function TodosPanel({ todos }: { todos: readonly DshTodoItemView[] }): React.JSX.Element | null {
    if (todos.length === 0) return null;
    return (
        <div className="dsh-todos" aria-label={t("Todo list")}>
            <div className="dsh-todos-progress">{progressLabel(todos)}</div>
            <ul className="dsh-todo-items" tabIndex={0}>
                {/* DshTodoItemView carries no id, and the host does not guarantee
                    distinct content, so position is the only stable identity here.
                    The list is a wholesale-replaced projection with no per-row state,
                    which is what makes an index key safe. */}
                {todos.map((item, position) => (
                    <li key={position} className={`dsh-todo-item ${item.status}`}>
                        <span className="dsh-todo-status" aria-hidden="true" />
                        <span className="dsh-todo-content">{item.content}</span>
                    </li>
                ))}
            </ul>
        </div>
    );
}
