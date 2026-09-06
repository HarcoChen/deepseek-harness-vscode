import * as vscode from "vscode";
import { DshRuntime } from "./dshRuntime";
import { ChatViewProvider } from "./chatView";
import { StoredSessionEvent } from "./sessionStore";
import { isRecord } from "./guards";

export interface ConversationNavigationEntry {
    seq: number;
    label: string;
    detail?: string;
}

export interface ConversationNavigationApi {
    registerConversationNavigation(
        entries: readonly ConversationNavigationEntry[],
    ): vscode.Disposable;
}

export class ConversationNavigationRegistry implements vscode.Disposable {
    private readonly entries = new Map<number, readonly ConversationNavigationEntry[]>();
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    private nextId = 0;
    public readonly onDidChange = this.changeEmitter.event;

    public registerConversationNavigation(entries: readonly ConversationNavigationEntry[]): vscode.Disposable {
        if (!Array.isArray(entries) || entries.length === 0) {
            throw new Error("Conversation navigation registration must contain at least one entry.");
        }
        const id = this.nextId++;
        for (const entry of entries) {
            if (!Number.isSafeInteger(entry.seq) || entry.seq < 0 || !entry.label.trim()) {
                throw new Error("Conversation navigation entries require a non-empty label and valid seq.");
            }
        }
        this.entries.set(id, entries.map((entry) => ({ ...entry, label: entry.label.trim() })) as ConversationNavigationEntry[]);
        this.changeEmitter.fire();
        return new vscode.Disposable(() => {
            if (this.entries.delete(id)) this.changeEmitter.fire();
        });
    }

    public current(): ConversationNavigationEntry[] {
        return [...this.entries.values()].flatMap((entries) => entries);
    }

    public dispose(): void {
        this.entries.clear();
        this.changeEmitter.dispose();
    }
}

function contentText(value: unknown): string {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join(" ");
    if (!isRecord(value)) return "";
    if (typeof value.text === "string") return value.text;
    return contentText(value.content ?? value.message);
}

function userText(entry: StoredSessionEvent): string | undefined {
    if (entry.event.type !== "user/message" || !isRecord(entry.event.data)) return undefined;
    const message = isRecord(entry.event.data.message) ? entry.event.data.message : entry.event.data;
    if (isRecord(message.source) && message.source.kind !== "user") return undefined;
    const text = contentText(message.content ?? message.text).replace(/\s+/gu, " ").trim();
    return text || undefined;
}

interface TurnOutlineEntry {
    turn: number;
    seq: number;
    prompt: string;
    response: string;
}

/**
 * Decode the wire view of the RC `turnOutline` projection.  The projection is
 * optional (it depends on the Runtime composition), so malformed or absent
 * data returns undefined and leaves the existing loaded-surface fallback in
 * place.
 */
function turnOutlineEntries(value: unknown): TurnOutlineEntry[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const byTurn = new Map<number, TurnOutlineEntry>();
    for (const candidate of value) {
        if (!isRecord(candidate) ||
            typeof candidate.turn !== "number" ||
            !Number.isSafeInteger(candidate.turn) ||
            candidate.turn < 0 ||
            typeof candidate.seq !== "number" ||
            !Number.isSafeInteger(candidate.seq) ||
            candidate.seq < 0 ||
            Object.is(candidate.seq, -0)) {
            continue;
        }
        byTurn.set(candidate.turn, {
            turn: candidate.turn,
            seq: candidate.seq,
            prompt: typeof candidate.prompt === "string" ? candidate.prompt : "",
            response: typeof candidate.response === "string" ? candidate.response : "",
        });
    }
    return [...byTurn.values()].sort((left, right) => left.turn - right.turn);
}

function navigationPreview(value: string, limit = 96): string {
    const normalized = value.replace(/\s+/gu, " ").trim();
    return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

function turnOutlineNavigationEntries(value: unknown): ConversationNavigationEntry[] | undefined {
    const outline = turnOutlineEntries(value);
    if (outline === undefined) return undefined;
    return outline.map((entry) => {
        const prompt = navigationPreview(entry.prompt);
        const response = navigationPreview(entry.response);
        return {
            seq: entry.seq,
            label: prompt || response || `Turn ${entry.turn}`,
            detail: response && prompt
                ? `Turn ${entry.turn} · ${response}`
                : `Turn ${entry.turn} · #${entry.seq}`,
        };
    });
}

class ConversationNavigationItem extends vscode.TreeItem {
    public constructor(public readonly entry: ConversationNavigationEntry) {
        super(entry.label, vscode.TreeItemCollapsibleState.None);
        this.description = entry.detail;
        this.contextValue = "dshConversationMilestone";
        this.iconPath = new vscode.ThemeIcon("symbol-event");
        this.command = {
            command: "dsh.revealConversationMilestone",
            title: "Reveal conversation milestone",
            arguments: [entry.seq],
        };
    }
}

export class ConversationNavigationProvider
    implements vscode.TreeDataProvider<ConversationNavigationItem>, vscode.Disposable {
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    private readonly disposables: vscode.Disposable[];

    public readonly onDidChangeTreeData = this.changeEmitter.event;

    public constructor(
        private readonly runtime: DshRuntime,
        private readonly chatView: ChatViewProvider,
        private readonly registry?: ConversationNavigationRegistry,
    ) {
        const unsubscribe = runtime.getSessionStore().onDidChange((sessionId) => {
            if (sessionId === chatView.getCurrentSessionId()) this.changeEmitter.fire();
        });
        const catalogUnsubscribe = runtime.getSessionCatalog().onDidChange(() => this.changeEmitter.fire());
        this.disposables = [
            new vscode.Disposable(unsubscribe),
            new vscode.Disposable(catalogUnsubscribe),
            ...(registry ? [registry.onDidChange(() => this.changeEmitter.fire())] : []),
        ];
    }

    public getTreeItem(item: ConversationNavigationItem): vscode.TreeItem {
        return item;
    }

    public getChildren(): ConversationNavigationItem[] {
        const sessionId = this.chatView.getCurrentSessionId();
        if (!sessionId) return [];
        const snapshot = this.runtime.getSessionStore().get(sessionId);
        if (!snapshot) return [];
        const outline = turnOutlineNavigationEntries(
            snapshot.projections.find((cell) => cell.key === "turnOutline")?.value,
        );
        const builtIn = (outline ?? snapshot.surface.nodes.flatMap((node) => {
            const text = userText(node);
            if (!text) return [];
            const firstLine = text.split(/\r?\n/u, 1)[0].trim();
            return [{
                seq: node.seq,
                label: firstLine.length > 96 ? `${firstLine.slice(0, 95)}…` : firstLine,
                detail: `#${node.seq}`,
            } satisfies ConversationNavigationEntry];
        })).map((entry) => new ConversationNavigationItem(entry));
        return [
            ...builtIn,
            ...(this.registry?.current() ?? []).map((entry) => new ConversationNavigationItem(entry)),
        ];
    }

    public refresh(): void {
        this.changeEmitter.fire();
    }

    public dispose(): void {
        this.changeEmitter.dispose();
        for (const disposable of this.disposables) disposable.dispose();
    }
}
