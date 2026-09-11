import React, { useEffect, useState } from "react";
import { postAction } from "../bridge";
import { t } from "../i18n";
import type { StatusBannerState } from "../state";
import { CloseIcon } from "./icons";

export function StatusBanner({ status, sessionStatus }: StatusBannerState): React.JSX.Element | null {
    const recovery = status.recovery;
    const recovering = status.state === "recovering";
    const recovered = recovery?.phase === "recovered" && status.state === "running";
    const runtimeError = status.state === "error" ? status.message : undefined;
    const sessionError = sessionStatus?.error;
    const message = sessionError || runtimeError;
    const messageKey = message
        ? `${sessionError ? "session" : "runtime"}:${message}:${recovery?.phase ?? ""}`
        : undefined;
    const [dismissedKey, setDismissedKey] = useState<string>();

    useEffect(() => {
        setDismissedKey(undefined);
    }, [messageKey]);

    if (!recovering && !recovered && (!message || messageKey === dismissedKey)) return null;

    const terminalRecovery = recovery?.phase === "unrecoverable" || recovery?.phase === "cancelled";
    const isSessionError = Boolean(sessionError);
    const bannerMessage = recovering
        ? `${status.message || t("Automatic recovery is in progress")} (${recovery?.usedBoots ?? 0}/${recovery?.maxBoots ?? 8})`
        : recovered
            ? status.message || t("Automatic recovery completed")
            : message;

    return (
        <div className={`dsh-error-banner${recovering || recovered ? " dsh-recovery-banner" : ""}`}
            role={recovering || recovered ? "status" : "alert"}
            aria-live={recovering || recovered ? "polite" : "assertive"}>
            <div className="dsh-error-banner-content">
                <span className="dsh-error-banner-message">{bannerMessage}</span>
                <div className="dsh-error-banner-actions">
                    {recovering ? (
                        <>
                            <button type="button" className="dsh-button dsh-button-secondary"
                                onClick={() => postAction({ type: "cancelRecovery" })}>
                                {t("Cancel recovery")}
                            </button>
                            <button type="button" className="dsh-button dsh-button-secondary"
                                onClick={() => postAction({ type: "openLogs" })}>
                                {t("View details")}
                            </button>
                        </>
                    ) : recovered ? (
                        <>
                            <button type="button" className="dsh-button dsh-button-secondary"
                                onClick={() => postAction({ type: "restoreRecovery" })}>
                                {t("Restore")}
                            </button>
                            <button type="button" className="dsh-button dsh-button-secondary"
                                onClick={() => postAction({ type: "exportRecoveryDiagnostics" })}>
                                {t("Export diagnostics")}
                            </button>
                        </>
                    ) : (
                        <>
                            <button type="button" className="dsh-button dsh-button-secondary"
                                onClick={() => postAction({
                                    type: isSessionError ? "openLogs" : terminalRecovery
                                        ? "exportRecoveryDiagnostics" : "start",
                                })}>
                                {isSessionError
                                    ? t("View details")
                                    : terminalRecovery ? t("Export diagnostics") : t("Retry")}
                            </button>
                            {recovery?.canRestore ? (
                                <button type="button" className="dsh-button dsh-button-secondary"
                                    onClick={() => postAction({ type: "restoreRecovery" })}>
                                    {t("Restore")}
                                </button>
                            ) : null}
                            <button type="button" className="dsh-icon-button"
                                aria-label={t("Dismiss")} title={t("Dismiss")}
                                onClick={() => setDismissedKey(messageKey)}>
                                <CloseIcon />
                            </button>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
