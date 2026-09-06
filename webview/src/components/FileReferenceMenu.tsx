import React from "react";
import type { DshReferenceCandidate } from "../../../src/types";
import { t } from "../i18n";

export const FILE_REFERENCE_MENU_ID = "dsh-file-reference-completion";

export function FileReferenceMenu({
    candidates,
    activeIndex,
    onSelect,
}: {
    candidates: DshReferenceCandidate[];
    activeIndex: number;
    onSelect: (candidate: DshReferenceCandidate) => void;
}): React.JSX.Element {
    return (
        <div
            className="dsh-file-reference-menu"
            id={FILE_REFERENCE_MENU_ID}
            role="listbox"
            aria-label={t("References")}
        >
            {candidates.map((candidate, index) => (
                <button
                    type="button"
                    role="option"
                    id={`${FILE_REFERENCE_MENU_ID}-option-${index}`}
                    aria-selected={index === activeIndex}
                    className={index === activeIndex ? "active" : ""}
                    key={`${candidate.kind}:${candidate.insertText}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => onSelect(candidate)}
                >
                    <span className="dsh-reference-label">@{candidate.label}</span>
                    {candidate.description ? <small>{candidate.description}</small> : null}
                </button>
            ))}
        </div>
    );
}
