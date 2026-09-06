import React, { useEffect, useMemo, useState } from "react";
import type { DshSettingFieldView, DshSettingsCardView, DshSettingsPanelView } from "../../../src/types";
import { postAction } from "../bridge";
import { PluginInventoryPanel } from "./PluginInventoryPanel";
import { t } from "../i18n";

function fieldKey(field: DshSettingFieldView): string {
    return field.path.join("\u0000");
}

function SettingsCard({ card, writable }: { card: DshSettingsCardView; writable: boolean }): React.JSX.Element {
    const [open, setOpen] = useState(false);
    const [drafts, setDrafts] = useState<Record<string, string>>({});
    const signature = `${card.revision}:${card.fields.map((field) => `${fieldKey(field)}=${field.value}`).join("|")}`;
    useEffect(() => {
        setDrafts(Object.fromEntries(card.fields.map((field) => [fieldKey(field), field.value])));
    }, [signature]);
    const changes = useMemo(
        () => card.fields
            .filter((field) => !field.secret && drafts[fieldKey(field)] !== field.value)
            .map((field) => {
                const value = drafts[fieldKey(field)] ?? "";
                return {
                    path: field.path,
                    value,
                    clear: value.length === 0,
                };
            }),
        [card.fields, drafts],
    );
    return (
        <section className={`dsh-settings-card${open ? " open" : ""}`}>
            <button
                type="button"
                className="dsh-settings-card-head"
                aria-expanded={open}
                onClick={() => setOpen((value) => !value)}
            >
                <span>
                    <strong>{card.title}</strong>
                    <small>{card.ns} · {card.applies === "restart" ? t("Applies after restart") : t("Applies immediately")}</small>
                </span>
                {changes.length ? <em>{t("Unsaved")}</em> : null}
                <span aria-hidden="true">{open ? "⌃" : "⌄"}</span>
            </button>
            {open ? (
                <div className="dsh-settings-card-body">
                    {!writable || !card.writable ? <div className="dsh-settings-readonly">{t("Settings are read-only")}</div> : null}
                    {card.fields.length === 0 ? <div className="dsh-settings-empty">{t("No editable settings exposed")}</div> : null}
                    {card.fields.map((field) => {
                        const key = fieldKey(field);
                        if (field.secret) {
                            return (
                                <div className="dsh-settings-field" key={key}>
                                    <div className="dsh-settings-field-head">
                                        <strong>{field.label}</strong>
                                        <span>{field.secretSet ? t("Configured") : t("Not configured")}</span>
                                    </div>
                                    <small>{t("Secret values are managed by the credential provider and never shown here.")}</small>
                                </div>
                            );
                        }
                        const value = drafts[key] ?? field.value;
                        return (
                            <label className="dsh-settings-field" key={key}>
                                <span className="dsh-settings-field-head">
                                    <strong>{field.label}</strong>
                                    {field.overridden ? <em>{t("Overridden")}</em> : null}
                                </span>
                                {field.type === "boolean" ? (
                                    <select
                                        value={value}
                                        disabled={!writable || !card.writable}
                                        onChange={(event) => setDrafts((current) => ({ ...current, [key]: event.target.value }))}
                                    >
                                        <option value="true">true</option>
                                        <option value="false">false</option>
                                    </select>
                                ) : field.type === "json" ? (
                                    <textarea
                                        value={value}
                                        disabled={!writable || !card.writable}
                                        onChange={(event) => setDrafts((current) => ({ ...current, [key]: event.target.value }))}
                                    />
                                ) : (
                                    <input
                                        type={field.type === "number" ? "number" : "text"}
                                        value={value}
                                        disabled={!writable || !card.writable}
                                        onChange={(event) => setDrafts((current) => ({ ...current, [key]: event.target.value }))}
                                    />
                                )}
                                <small>{field.description || field.path.join(".")}</small>
                                {field.overridden ? (
                                    <button
                                        type="button"
                                        className="dsh-settings-reset"
                                        disabled={!writable || !card.writable}
                                        onClick={() => setDrafts((current) => ({ ...current, [key]: "" }))}
                                    >
                                        {t("Reset")}
                                    </button>
                                ) : null}
                            </label>
                        );
                    })}
                    <div className="dsh-settings-card-actions">
                        <button
                            type="button"
                            disabled={!changes.length || !writable || !card.writable}
                            onClick={() => postAction({
                                type: "mutateSettings",
                                ns: card.ns,
                                revision: card.revision,
                                changes,
                            })}
                        >
                            {t("Save")}
                        </button>
                        <button
                            type="button"
                            disabled={!changes.length}
                            onClick={() => setDrafts(Object.fromEntries(card.fields.map((field) => [fieldKey(field), field.value])))}
                        >
                            {t("Discard")}
                        </button>
                    </div>
                </div>
            ) : null}
        </section>
    );
}

export function SettingsPanel({ settings }: { settings: DshSettingsPanelView }): React.JSX.Element {
    return (
        <section className="dsh-settings-panel" aria-label={t("Plugin settings")}>
            <div className="dsh-settings-panel-head">
                <div>
                    <strong>{t("Plugin settings")}</strong>
                    <small>{t("Public Harness settings namespaces")}</small>
                </div>
                <button type="button" onClick={() => postAction({ type: "manageSettings" })}>{t("Close")}</button>
            </div>
            {settings.loading ? <div className="dsh-settings-loading">{t("Loading...")}</div> : null}
            {settings.error ? <div className="dsh-settings-error">{settings.error}</div> : null}
            {settings.pluginInventory ? <PluginInventoryPanel inventory={settings.pluginInventory} /> : null}
            {!settings.loading && !settings.error && settings.cards.length === 0 ? (
                <div className="dsh-settings-empty">{t("No plugin settings exposed")}</div>
            ) : null}
            <div className="dsh-settings-cards">
                {settings.cards.map((card) => <SettingsCard key={card.ns} card={card} writable={settings.writable} />)}
            </div>
            <button type="button" className="dsh-settings-document" onClick={() => postAction({ type: "openBrowser" })}>
                {t("Open advanced configuration in the dsh Web UI")}
            </button>
        </section>
    );
}
