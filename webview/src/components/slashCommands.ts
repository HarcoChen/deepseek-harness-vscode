import type { ChatViewAction } from "../../../src/chatViewProtocol";
import type { DshCommandDescriptor } from "../../../src/types";
import { postAction } from "../bridge";
import { t } from "../i18n";

export interface SlashCommand {
    name: string;
    description: string;
    hint?: string;
    /**
     * Absent for a host-registered command: the composer submits its line and
     * the Runtime's own registry dispatches it.
     */
    action?: ChatViewAction;
    /** Where the entry came from, which decides how choosing it behaves. */
    origin: "ide" | "host";
}

/**
 * Commands the extension itself owns. These drive VS Code surfaces rather than
 * the session's agent, so they are never in the Runtime's registry and must be
 * listed here. Everything the Runtime registers arrives through `commands/list`
 * instead — see {@link mergeSlashCommands}.
 */
export const IDE_SLASH_COMMANDS: ReadonlyArray<SlashCommand> = [
    { name: "/ide", description: t("Add one-shot IDE context"), action: { type: "openIdeContextPicker" }, origin: "ide" },
    { name: "/template", description: t("Pre-fill the composer from a .dsh/prompts template"), action: { type: "openPromptTemplatePicker" }, origin: "ide" },
    { name: "/new", description: t("New session"), action: { type: "newSession" }, origin: "ide" },
    { name: "/search", description: t("Search sessions"), action: { type: "searchSession" }, origin: "ide" },
    { name: "/model", description: t("Select the current session model"), action: { type: "selectModel" }, origin: "ide" },
    { name: "/effort", description: t("Select reasoning effort"), origin: "ide" },
    { name: "/mode", description: t("Select agent mode"), action: { type: "selectAgentPreset" }, origin: "ide" },
    { name: "/preset", description: t("Select agent mode"), action: { type: "selectAgentPreset" }, origin: "ide" },
    { name: "/focus", description: t("Toggle focus mode"), action: { type: "toggleFocus" }, origin: "ide" },
    { name: "/trace", description: t("Open the current session trace"), action: { type: "openTrace" }, origin: "ide" },
    { name: "/stop", description: t("Stop the dsh runtime"), action: { type: "stop" }, origin: "ide" },
];

/**
 * The composer's command list: everything the session's Runtime registers,
 * plus the IDE's own entries. A host command wins a name collision, because
 * the registry is authoritative about what that line will actually do.
 */
export function mergeSlashCommands(
    hostCommands: readonly DshCommandDescriptor[],
): SlashCommand[] {
    const fromHost = hostCommands.map((command): SlashCommand => ({
        name: `/${command.name}`,
        description: command.description,
        ...(command.input === undefined ? {} : { hint: command.input.hint }),
        origin: "host",
    }));
    const claimed = new Set(fromHost.map((command) => command.name));
    return [
        ...fromHost,
        ...IDE_SLASH_COMMANDS.filter((command) => !claimed.has(command.name)),
    ].sort((left, right) => left.name.localeCompare(right.name));
}

export interface SlashCommandContext {
    /** Whether reasoning effort options are already loaded; if not, /effort asks the host. */
    reasoningEffortAvailable: boolean;
    /** Called when the /effort panel should become visible. */
    onShowEffort: () => void;
    /** The merged list the composer is currently offering. */
    commands: readonly SlashCommand[];
}

/**
 * Executes a slash command by name. Returns true when the input was consumed
 * (the caller should clear the draft), false when nothing matched — including
 * for a host command that takes input, which the composer keeps in the draft
 * so the user can finish the line before submitting it.
 */
export function runSlashCommand(name: string, context: SlashCommandContext): boolean {
    const mode = name.match(/^\/(?:mode|preset)(?:\s+(.+))?$/iu);
    if (mode && !context.commands.some((entry) => entry.origin === "host" && /^\/(?:mode|preset)$/iu.test(entry.name))) {
        const agentPreset = mode[1]?.trim();
        postAction({
            type: "selectAgentPreset",
            ...(agentPreset ? { agentPreset } : {}),
        });
        return true;
    }
    const command = context.commands.find((candidate) => candidate.name === name.toLowerCase());
    if (!command) return false;
    if (command.origin === "host") {
        // Bare host commands submit as an ordinary prompt line; the host side
        // recognizes the registered name and dispatches it through the registry.
        postAction({ type: "sendPrompt", text: command.name, mode: "queue" });
        return true;
    }
    if (command.name === "/effort") {
        context.onShowEffort();
        if (!context.reasoningEffortAvailable) {
            postAction({ type: "openReasoningEffort" });
        }
    } else if (command.action) {
        postAction(command.action);
    }
    return true;
}
