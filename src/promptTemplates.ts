import * as vscode from "vscode";
import { t } from "./localize";

/**
 * Read-only discovery of workspace prompt templates under `.dsh/prompts`.
 * Templates are user-selected and inserted as visible composer prefill —
 * nothing here injects context into a prompt without the user seeing and
 * sending it.
 */

const PROMPTS_DIRNAME = ".dsh/prompts";
const MAX_TEMPLATE_FILES = 100;
const MAX_SCAN_DEPTH = 4;
/** Insertion cap; a template becomes the whole composer draft. */
const MAX_TEMPLATE_BYTES = 32 * 1024;
/** Listing decodes only the file head to resolve a title and preview. */
const TITLE_SAMPLE_BYTES = 8 * 1024;
const MAX_PREVIEW_CHARACTERS = 120;

export interface PromptTemplateEntry {
    /** Workspace-relative POSIX path, used as the pick key. */
    readonly path: string;
    readonly label: string;
    readonly preview: string;
}

/** Reject anything that could escape the prompts directory. */
function safeRelativePath(value: string): string | undefined {
    if (value.length === 0 || value.length > 512) return undefined;
    if (!/\.md$/iu.test(value)) return undefined;
    const segments = value.split("/");
    if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
        return undefined;
    }
    return segments.join("/");
}

function decodeHead(bytes: Uint8Array): string {
    const text = new TextDecoder("utf-8").decode(bytes.subarray(0, TITLE_SAMPLE_BYTES));
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Frontmatter `title:` wins, then the first `#` heading, then the file stem. */
function templateTitle(head: string, stem: string): { title: string; preview: string } {
    const lines = head.split(/\r?\n/u);
    let title: string | undefined;
    let preview: string | undefined;
    if (lines[0]?.trim() === "---") {
        for (let index = 1; index < lines.length && index <= 20; index += 1) {
            const line = lines[index];
            if (line.trim() === "---") break;
            const match = line.match(/^title:\s*(.+)$/u);
            if (match && title === undefined) {
                title = match[1].trim().replace(/^["']|["']$/gu, "");
            }
        }
    }
    for (const line of lines) {
        const text = line.trim();
        if (text.length === 0 || text === "---") continue;
        if (title === undefined && /^#\s+/u.test(text)) {
            title = text.replace(/^#\s+/u, "").trim();
            continue;
        }
        if (preview === undefined && !text.startsWith("#") && text !== "---") {
            preview = text;
        }
        if (title !== undefined && preview !== undefined) break;
    }
    return {
        title: title?.slice(0, MAX_PREVIEW_CHARACTERS) || stem,
        preview: (preview ?? "").slice(0, MAX_PREVIEW_CHARACTERS),
    };
}

async function collectMarkdownFiles(
    directory: vscode.Uri,
    depth: number,
    files: vscode.Uri[],
): Promise<void> {
    if (depth > MAX_SCAN_DEPTH || files.length >= MAX_TEMPLATE_FILES) return;
    let entries: [string, vscode.FileType][] = [];
    try {
        entries = await vscode.workspace.fs.readDirectory(directory);
    } catch {
        return;
    }
    for (const [name, type] of entries) {
        if (files.length >= MAX_TEMPLATE_FILES) return;
        const child = vscode.Uri.joinPath(directory, name);
        if (type === vscode.FileType.Directory) {
            if (name.startsWith(".")) continue;
            await collectMarkdownFiles(child, depth + 1, files);
        } else if (type === vscode.FileType.File && /\.md$/iu.test(name)) {
            files.push(child);
        }
    }
}

/**
 * Lists `.md` files under {@param promptsRoot}, sorted by relative path and
 * bounded in count and depth so a large tree cannot stall the picker.
 */
export async function listPromptTemplates(promptsRoot: vscode.Uri): Promise<PromptTemplateEntry[]> {
    const files: vscode.Uri[] = [];
    await collectMarkdownFiles(promptsRoot, 0, files);
    files.sort((left, right) => left.fsPath.localeCompare(right.fsPath));
    const entries: PromptTemplateEntry[] = [];
    for (const file of files) {
        const relative = safeRelativePath(
            file.path.slice(promptsRoot.path.length + 1).replace(/\\/gu, "/"),
        );
        if (relative === undefined) continue;
        let head: string;
        try {
            head = decodeHead(await vscode.workspace.fs.readFile(file));
        } catch {
            continue;
        }
        const { title, preview } = templateTitle(head, relative.replace(/\.md$/iu, ""));
        entries.push({ path: relative, label: title, preview });
    }
    return entries;
}

/**
 * Reads one template for composer prefill. The path must come from
 * {@link listPromptTemplates}; it is re-validated here regardless.
 */
export async function readPromptTemplate(
    promptsRoot: vscode.Uri,
    relativePath: string,
): Promise<string> {
    const relative = safeRelativePath(relativePath);
    if (relative === undefined) {
        throw new Error(t("Not a usable prompt template path: {path}.", { path: relativePath }));
    }
    const bytes = await vscode.workspace.fs.readFile(
        vscode.Uri.joinPath(promptsRoot, ...relative.split("/")),
    );
    if (bytes.byteLength > MAX_TEMPLATE_BYTES) {
        throw new Error(t(
            "This prompt template is too large to insert ({limit} KiB limit).",
            { limit: MAX_TEMPLATE_BYTES / 1024 },
        ));
    }
    const text = new TextDecoder("utf-8").decode(bytes);
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
