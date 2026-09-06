import { ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, open, readFile, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, extname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { RemoteConnectionController } from "./remote/connection";
import { parseRemoteServerResponse, remoteEndpointUrl } from "./remote/contracts";
import { RemoteHttpError, RemoteProtocolError } from "./remote/errors";
import { RemoteStateCoordinator } from "./remote/stateCoordinator";
import { RemoteUnaryClient } from "./remote/unaryClient";
import { historyEntries as remoteHistoryEntries, projectionBlock as remoteProjectionBlock } from "./remote/sessionState";
import { t } from "./localize";
import {
    RUNTIME_DEFAULT_VERSION,
    acquireManagedRuntime,
    checkInstalled,
    resolveTarget,
} from "./managedRuntime";
import type { ManagedRuntime, RuntimeInstallPhase } from "./managedRuntime";
import {
    DshCommandDescriptor,
    DshCommandExecution,
    DshGoalRef,
    DshGoalRefResult,
    DshHistoryResult,
    DshSessionCreateResult,
    DshSessionForkResult,
    DshSessionPromptResult,
    DshImageAttachmentResult,
    DshImageUpload,
    DshSessionModelsResult,
    DshSessionSelectModelResult,
    DshAgentPresetListResult,
    DshAgentPresetOpenResult,
    DshAgentPresetReadResult,
    DshAgentPresetSelectResult,
    DshSessionRenameResult,
    DshSessionSearchResult,
    DshFileReferenceCandidate,
    DshSessionReferenceCandidate,
    DshSkillEntry,
    DshSkillListResult,
    DshProviderListResult,
    DshLlmModelsResult,
    DshLlmDiscoverModelsResult,
    DshCredentialDescribeResult,
    DshDirectoryListing,
    DshSettingsDescribeResult,
    DshSettingsNamespaceView,
    DshSettingsPathOperation,
    DshSubagentAddress,
    DshSubagentCatalog,
    DshSubagentHistoryResult,
    DshSubagentPromptResult,
    DshMessageFeedbackDeleteRequest,
    DshMessageFeedbackDeleteResult,
    DshMessageFeedbackListRequest,
    DshMessageFeedbackListResult,
    DshMessageFeedbackPutRequest,
    DshMessageFeedbackPutResult,
    DshWorkspaceCreateResult,
    DshWorkspaceView,
    HarnessGoalEditChanges,
    HarnessHostDescription,
    HarnessQueueAction,
    RuntimeStatus,
} from "./types";
import {
    normalizeFileReferenceCandidates,
    normalizeSessionReferenceCandidates,
} from "./referenceCandidates";
import { normalizeModelSelectionProjection } from "./modelSelection";

type RuntimeListener = (status: RuntimeStatus) => void;
type HarnessConnectedListener = () => void;
/** One allowlisted host cordis event forwarded verbatim by the Runtime. */
type RemoteEventListener = (event: string) => void;
const execFileAsync = promisify(execFile);
const DEFAULT_NPX_TIMEOUT_MS = 120_000;
const DEFAULT_PACKAGE_MANAGER_FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_NPM_REGISTRY = "https://registry.npmmirror.com";
const OFFICIAL_NPM_REGISTRY = "https://registry.npmjs.org";
const NPM_REGISTRY_QUERY_TIMEOUT_MS = 5_000;
type PackageManager = "npx" | "pnpm";
/**
 * The start lock every dsh editor integration shares, so one Runtime serves the
 * machine instead of one per editor. The name is deliberately editor-neutral:
 * the JetBrains plugin takes the same file.
 */
const RUNTIME_LOCK_FILE = "dsh-runtime.lock";
/**
 * The name this extension used before the lock was shared. A peer that has not
 * updated yet still owns that file, so it is read for an advertised URL and
 * deferred to while its owner lives — otherwise the rename would reintroduce
 * exactly the double-spawn the lock exists to prevent.
 */
const LEGACY_RUNTIME_LOCK_FILE = "dsh-vscode-runtime.lock";

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Assign the conventional title for a forked Session. The Host deliberately
 * returns only the child id and preserves the source title; title disambiguation
 * is a client-side Session action.
 */
function increasedForkTitle(title: string): string {
    const ascii = /^(.*?)\((\d+)\)$/u.exec(title);
    if (ascii?.[1] !== undefined && ascii[2] !== undefined) {
        return `${ascii[1]}(${BigInt(ascii[2]) + 1n})`;
    }
    const fullWidth = /^(.*?)（(\d+)）$/u.exec(title);
    if (fullWidth?.[1] !== undefined && fullWidth[2] !== undefined) {
        return `${fullWidth[1]}（${BigInt(fullWidth[2]) + 1n}）`;
    }
    return `${title} (1)`;
}

function isRemoteRecord(value: unknown): value is Record<string, any> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeRemoteSeq(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= -1 && !Object.is(value, -0);
}

function remoteGoalRef(value: unknown): DshGoalRef | undefined {
    if (!isRemoteRecord(value) || typeof value.id !== "string" || value.id.length === 0) return undefined;
    return typeof value.revision === "number" && Number.isSafeInteger(value.revision) && value.revision >= 0
        ? { id: value.id, revision: value.revision }
        : undefined;
}

/** Keep the editor-facing goal facade stable while RC mutations return GoalView. */
function normalizeGoalRefResult(value: unknown, endpoint: string): DshGoalRefResult {
    const record = isRemoteRecord(value) ? value : undefined;
    const ref = remoteGoalRef(record?.ref) ?? remoteGoalRef(record);
    if (!ref) throw new RemoteProtocolError(`Remote ${endpoint} returned an invalid goal reference`);
    return { ref };
}

interface RuntimeEndpoint {
    /** URL used for HTTP requests; it never contains the launch token. */
    baseUrl: string;
    /** URL printed by dsh web, carrying the one-time launch token. */
    launchUrl?: string;
}

const AUTH_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/u;

function isLoopbackHostname(hostname: string): boolean {
    return hostname === "127.0.0.1" ||
        hostname === "localhost" ||
        hostname === "0.0.0.0" ||
        hostname === "[::1]";
}

function isInsecureRemoteRuntimeUrl(value: string): boolean {
    try {
        const url = new URL(value.trim());
        return url.protocol === "http:" && !isLoopbackHostname(url.hostname);
    } catch {
        return false;
    }
}

/** Parse a Runtime URL while keeping the launch token separate from requests. */
function parseRuntimeEndpoint(value: unknown, loopbackOnly = false): RuntimeEndpoint | undefined {
    if (typeof value !== "string") return undefined;
    try {
        const url = new URL(value.trim());
        if (
            (url.protocol !== "http:" && url.protocol !== "https:") ||
            url.username ||
            url.password ||
            url.hash ||
            (url.pathname !== "/" && url.pathname !== "") ||
            (loopbackOnly && (
                url.protocol !== "http:" ||
                !url.port ||
                !isLoopbackHostname(url.hostname)
            ))
        ) {
            return undefined;
        }

        const tokenValues = url.searchParams.getAll("token");
        if (
            [...url.searchParams.keys()].some((key) => key !== "token") ||
            tokenValues.length > 1 ||
            (tokenValues.length === 1 && !AUTH_TOKEN_PATTERN.test(tokenValues[0] ?? ""))
        ) {
            return undefined;
        }

        const base = new URL(url.href);
        base.search = "";
        base.hash = "";
        base.pathname = "/";
        if (loopbackOnly) {
            base.hostname = base.hostname === "[::1]" ? "[::1]" : "127.0.0.1";
        }
        const baseUrl = base.toString().replace(/\/$/u, "");
        if (tokenValues.length === 0) return { baseUrl };

        const launch = new URL(baseUrl);
        launch.searchParams.set("token", tokenValues[0] as string);
        return { baseUrl, launchUrl: launch.href };
    } catch {
        return undefined;
    }
}

/** One lock file's advertised Runtime endpoint, or undefined when it has none. */
async function readLockRecord(path: string): Promise<RuntimeEndpoint | undefined> {
    try {
        const contents = await readFile(path, "utf8");
        const record = JSON.parse(contents) as { url?: unknown; launchUrl?: unknown };
        const advertised = parseRuntimeEndpoint(record.url, true);
        const launch = parseRuntimeEndpoint(record.launchUrl, true);
        const baseUrl = advertised?.baseUrl ?? launch?.baseUrl;
        if (!baseUrl) return undefined;
        const launchUrl = launch?.baseUrl === baseUrl
            ? launch.launchUrl
            : advertised?.baseUrl === baseUrl
                ? advertised.launchUrl
                : undefined;
        return {
            baseUrl,
            ...(launchUrl === undefined ? {} : { launchUrl }),
        };
    } catch {
        // A missing, half-written, or concurrently updated lock advertises nothing.
        return undefined;
    }
}

function loopbackRuntimeUrl(value: unknown): string | undefined {
    const endpoint = parseRuntimeEndpoint(value, true);
    return endpoint?.launchUrl === undefined ? endpoint?.baseUrl : undefined;
}

function extractRuntimeEndpoint(value: string): RuntimeEndpoint | undefined {
    const match = value.match(
        /https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]):\d+(?:\/\?token=[A-Za-z0-9_-]+)?/i,
    );
    return match ? parseRuntimeEndpoint(match[0], true) : undefined;
}

function portFromArgs(args: string[]): number | undefined {
    const inline = args.find((argument) => argument.startsWith("--port="));
    if (inline) {
        const value = Number(inline.slice("--port=".length));
        return Number.isInteger(value) && value > 0 && value <= 65_535 ? value : undefined;
    }

    const index = args.findIndex((argument) => argument === "--port" || argument === "-p");
    if (index < 0) {
        return undefined;
    }

    const value = Number(args[index + 1]);
    return Number.isInteger(value) && value > 0 && value <= 65_535 ? value : undefined;
}

/** Returns whether a launcher needs a shell on the current platform. */
function launcherNeedsShell(command: string): boolean {
    if (process.platform !== "win32") return false;
    return !/\.exe$/iu.test(command);
}

async function findExecutable(command: string): Promise<string | undefined> {
    const mode = process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK;
    const candidates: string[] = [];

    if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
        candidates.push(command);
    } else {
        const pathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
        const extensions =
            process.platform === "win32"
                ? extname(command)
                    ? [""]
                    : (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
                : [""];
        for (const directory of pathEntries) {
            for (const extension of extensions) {
                candidates.push(join(directory, `${command}${extension}`));
            }
        }
    }

    for (const candidate of candidates) {
        try {
            await access(candidate, mode);
            return candidate;
        } catch {
            // Try the next PATH entry.
        }
    }
    return undefined;
}

async function executableExists(command: string): Promise<boolean> {
    return (await findExecutable(command)) !== undefined;
}

function redactArgument(argument: string, previous?: string): string {
    const sensitive = /(?:api[-_]?key|auth|credential|password|secret|token)/iu;
    if (previous && sensitive.test(previous)) return "<redacted>";
    const inline = argument.match(/^([^=]+)=/u);
    return inline && sensitive.test(inline[1] as string)
        ? `${inline[1]}=<redacted>`
        : argument;
}

function redactArguments(args: string[]): string {
    return args
        .map((argument, index) => redactArgument(argument, args[index - 1]))
        .join(" ");
}

function redactUrl(value: string): string {
    try {
        const url = new URL(value);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.toString().replace(/\/$/u, "");
    } catch {
        return "<invalid URL>";
    }
}

function redactRuntimeOutput(value: string): string {
    return value.replace(/([?&]token=)[A-Za-z0-9_-]+/gu, "$1<redacted>");
}

function normalizeNpmRegistry(value: string | undefined): string | undefined {
    const candidate = value?.trim();
    if (!candidate) return undefined;
    try {
        const url = new URL(candidate);
        if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
        if (url.username || url.password || url.search || url.hash) return undefined;
        return url.toString().replace(/\/$/u, "");
    } catch {
        return undefined;
    }
}

interface RegistryArgument {
    value?: string;
    consumed: number;
}

function registryArgumentAt(
    args: string[],
    index: number,
    packageManager: PackageManager,
): RegistryArgument | undefined {
    const argument = args[index];
    if (argument === undefined) return undefined;

    const prefixes = packageManager === "pnpm"
        ? ["--registry=", "--config.registry="]
        : ["--registry="];
    const inlinePrefix = prefixes.find((prefix) => argument.startsWith(prefix));
    if (inlinePrefix !== undefined) {
        return {
            value: argument.slice(inlinePrefix.length),
            consumed: 1,
        };
    }

    const separated = packageManager === "pnpm"
        ? argument === "--registry" || argument === "--config.registry"
        : argument === "--registry";
    if (!separated) return undefined;

    const next = args[index + 1];
    return {
        ...(next !== undefined && !next.startsWith("-") ? { value: next } : {}),
        consumed: next !== undefined && !next.startsWith("-") ? 2 : 1,
    };
}

/** Returns whether arguments already select a registry for the active package manager. */
function hasNpmRegistryArgument(args: string[], packageManager?: PackageManager): boolean {
    if (packageManager === undefined) {
        return args.some((argument) => argument === "--registry" || argument.startsWith("--registry="));
    }
    return args.some((_, index) => registryArgumentAt(args, index, packageManager) !== undefined);
}

interface NormalizedRegistryArguments {
    args: string[];
    registryArgs: string[];
}

/** Converts registry flags while keeping their values as separate arguments. */
function normalizeRegistryArguments(
    args: string[],
    fromPackageManager: PackageManager,
    toPackageManager: PackageManager,
): NormalizedRegistryArguments {
    const remaining: string[] = [];
    const registryArgs: string[] = [];
    for (let index = 0; index < args.length;) {
        const registry = registryArgumentAt(args, index, fromPackageManager);
        if (registry === undefined) {
            remaining.push(args[index] as string);
            index += 1;
            continue;
        }

        if (toPackageManager === "pnpm") {
            registryArgs.push(
                registry.value === undefined ? "--config.registry" : `--config.registry=${registry.value}`,
            );
        } else if (registry.value === undefined) {
            registryArgs.push("--registry");
        } else {
            registryArgs.push("--registry", registry.value);
        }
        index += registry.consumed;
    }
    return { args: remaining, registryArgs };
}

function hasNpmOptionArgument(args: string[], option: string): boolean {
    return args.some((argument) => argument === option || argument.startsWith(`${option}=`));
}

/** Adds a package-manager-specific registry override when one is not configured. */
function withNpmRegistry(
    args: string[],
    registry: string | undefined,
    packageManager: PackageManager,
): string[] | undefined {
    if (!registry || hasNpmRegistryArgument(args, packageManager)) return undefined;
    // `--registry` is an npm/npx option. pnpm's `dlx` command does not expose
    // it and reports it as an unknown dlx option, even when it is placed before
    // `dlx`. Use pnpm's dotted config override instead so the fallback reaches
    // the registry without changing the configured invocation.
    return packageManager === "pnpm"
        ? [`--config.registry=${registry}`, ...args]
        : ["--registry", registry, ...args];
}

function alternateNpmRegistry(
    configuredRegistry: string | undefined,
    activeRegistry: string | undefined,
): string | undefined {
    if (!configuredRegistry) return undefined;
    if (!activeRegistry || configuredRegistry !== activeRegistry) return configuredRegistry;
    return activeRegistry === DEFAULT_NPM_REGISTRY
        ? OFFICIAL_NPM_REGISTRY
        : DEFAULT_NPM_REGISTRY;
}

async function activeNpmRegistry(cwd?: string, packageManager = "npm"): Promise<string | undefined> {
    const environmentRegistry = normalizeNpmRegistry(
        process.env.npm_config_registry ?? process.env.NPM_CONFIG_REGISTRY,
    );
    if (environmentRegistry) return environmentRegistry;
    const configCommand = packageManager === "pnpm" ? "pnpm" : "npm";
    if (!(await executableExists(configCommand))) return undefined;
    try {
        const result = await execFileAsync(configCommand, ["config", "get", "registry"], {
            cwd,
            timeout: NPM_REGISTRY_QUERY_TIMEOUT_MS,
            windowsHide: true,
            shell: process.platform === "win32",
        });
        return normalizeNpmRegistry(result.stdout);
    } catch {
        return undefined;
    }
}

function isLikelyNpmDownloadFailure(error: unknown, outputTail = ""): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /(?:npm\s+(?:err(?:or)?|warn)|npx\b|pnpm\b|err_pnpm|registry|download|fetch failed|network (?:error|request|timeout)|timed out waiting for dsh web|eai_again|etimedout|econnreset|enotfound|socket hang up)/iu.test(
        `${message}\n${outputTail}`,
    );
}

async function globalNpmPrefix(): Promise<string | undefined> {
    if (!(await executableExists("npm"))) return undefined;
    try {
        const result = await execFileAsync("npm", ["prefix", "-g"], {
            timeout: 10_000,
            windowsHide: true,
            shell: process.platform === "win32",
        });
        const prefix = result.stdout.trim();
        return prefix || undefined;
    } catch {
        return undefined;
    }
}

/**
 * Where the launcher came from. `managed` runtimes are downloaded and cached
 * by this extension; everything else is a local toolchain discovery.
 */
type DshRuntimeSource =
    | { kind: "configured"; command: string; args: string[] }
    | { kind: "path"; command: string; args: string[] }
    | { kind: "npm-prefix"; command: string; args: string[] }
    | { kind: "npx"; command: string; args: string[] }
    | { kind: "pnpm"; command: string; args: string[] }
    | { kind: "managed"; command: string; args: string[]; version: string; target: string };

interface DshLauncher {
    command: string;
    args: string[];
    source: DshRuntimeSource;
    /** False when args already contain the complete fallback invocation. */
    usesConfiguredArgs?: boolean;
}

interface DiscoverDshOptions {
    storagePath: string | undefined;
    installWhenMissing: boolean;
    runtimeVersion: string;
    configuredArgs: string[];
    /** Permit the managed Runtime fallback (may download). Disabled during diagnosis. */
    allowManaged: boolean;
    /** HTTP(S) proxy URL, e.g. from the VS Code http.proxy setting. */
    proxy?: string;
    onLog?: (message: string) => void;
}

function isPackageManagerSource(source: DshRuntimeSource): source is Extract<DshRuntimeSource, { kind: "npx" | "pnpm" }> {
    return source.kind === "npx" || source.kind === "pnpm";
}

function isPackageManagerCommand(command: string): command is "npx" | "pnpm" {
    return command === "npx" || command === "pnpm";
}

/** Convert a package-manager invocation while normalizing registry flags. */
function alternatePackageManagerArgs(
    fromCommand: PackageManager,
    toCommand: PackageManager,
    configuredArgs: string[],
): string[] | undefined {
    if (fromCommand === "pnpm" && toCommand === "npx") {
        const normalized = normalizeRegistryArguments(configuredArgs, fromCommand, toCommand);
        const dlxIndex = normalized.args.findIndex((argument) => argument === "dlx");
        if (dlxIndex < 0) return undefined;
        const pnpmOptions = normalized.args.slice(0, dlxIndex);
        return [
            ...normalized.registryArgs,
            ...pnpmOptions,
            "--yes",
            ...normalized.args.slice(dlxIndex + 1),
        ];
    }
    if (fromCommand === "npx" && toCommand === "pnpm") {
        const normalized = normalizeRegistryArguments(configuredArgs, fromCommand, toCommand);
        const npxArgs = normalized.args.filter((argument) => argument !== "-y" && argument !== "--yes");
        return [...normalized.registryArgs, "dlx", ...npxArgs];
    }
    return undefined;
}

const DSH_PACKAGE = "@deepseek-ai/dsh";

/**
 * Pin every package-manager invocation to the Runtime this build speaks.
 *
 * A bare `@deepseek-ai/dsh` resolves to the dist-tag `latest`, so publishing a
 * Runtime moves existing installations onto it at the next cold start — and a
 * Runtime release may replace the wire protocol wholesale. The pin is a
 * compile-time constant rather than a setting because the manifest default of
 * dsh.commandArgs already spells the package out, so every installation that
 * never touched its settings carries the unpinned spec.
 *
 * An operator who wrote an explicit `@deepseek-ai/dsh@<version>` asked for that
 * version and keeps it; only the unpinned spec is rewritten.
 */
function pinDshPackageArgs(args: string[]): string[] {
    return args.map((argument) =>
        argument === DSH_PACKAGE ? `${DSH_PACKAGE}@${RUNTIME_DEFAULT_VERSION}` : argument,
    );
}

function npxArgsForDsh(configuredArgs: string[]): string[] {
    const normalized = normalizeRegistryArguments(configuredArgs, "pnpm", "npx");
    const dlxIndex = normalized.args.findIndex((argument) => argument === "dlx");
    if (dlxIndex >= 0) {
        return [
            ...normalized.registryArgs,
            "--yes",
            ...normalized.args.slice(dlxIndex + 1),
        ];
    }

    const packageIndex = normalized.args.findIndex((argument) =>
        /^@deepseek-ai\/dsh(?:@|$)/u.test(argument),
    );
    if (packageIndex >= 0) {
        const prefix = normalized.args
            .slice(0, packageIndex)
            .filter((argument) => argument !== "-y" && argument !== "--yes");
        return [...normalized.registryArgs, ...prefix, "--yes", ...normalized.args.slice(packageIndex)];
    }

    return [
        ...normalized.registryArgs,
        "--yes",
        DSH_PACKAGE,
        ...normalized.args.filter(
            (argument) => argument !== "-y" && argument !== "--yes",
        ),
    ];
}

function webProfileIndex(args: string[]): number {
    return args.findIndex((argument, index) =>
        argument === "web" ||
        argument === "--profile=web" ||
        (argument === "--profile" && args[index + 1] === "web"),
    );
}

function isWebProfileArgs(args: string[]): boolean {
    return webProfileIndex(args) >= 0;
}

/**
 * Insert a DSH launcher flag before the first Web-app argument. DSH stops
 * parsing its own flags at the first unknown token, so app flags such as
 * `--no-open` must not precede a later launcher-level `--patch`.
 */
function insertWebLauncherPatch(args: string[], patchPath: string): void {
    const profileIndex = webProfileIndex(args);
    if (profileIndex < 0) {
        args.push("--patch", patchPath);
        return;
    }

    let insertionIndex = profileIndex + 1;
    while (insertionIndex < args.length) {
        const argument = args[insertionIndex];
        if (argument === "--patch") {
            insertionIndex += 2;
            continue;
        }
        if (argument.startsWith("--patch=")) {
            insertionIndex += 1;
            continue;
        }
        if (argument === "--dump-config" || argument === "--dump-default-config") {
            insertionIndex += 1;
            continue;
        }
        break;
    }
    args.splice(insertionIndex, 0, "--patch", patchPath);
}

function ensureNoOpen(args: string[]): string[] {
    if (!isWebProfileArgs(args) || args.some((argument) => argument === "--no-open")) {
        return args;
    }
    return [...args, "--no-open"];
}

function packageManagerLauncher(
    command: "npx" | "pnpm",
    args: string[],
    usesConfiguredArgs = true,
): DshLauncher {
    return {
        command,
        args,
        source: command === "pnpm"
            ? { kind: "pnpm", command, args }
            : { kind: "npx", command, args },
        usesConfiguredArgs,
    };
}

function describeSource(source: DshRuntimeSource): string {
    switch (source.kind) {
        case "configured":
            return source.command;
        case "path":
            return "PATH";
        case "npm-prefix":
            return "npm global prefix";
        case "npx":
            return "npx";
        case "pnpm":
            return "pnpm dlx";
        case "managed":
            return t("managed Runtime {version} ({target})", { version: source.version, target: source.target });
    }
}

class CanceledError extends Error {
    constructor() {
        super(t("Canceled."));
    }
}

class RuntimeLaunchFailure extends Error {
    public constructor(
        public readonly outputTail: string,
        cause: unknown,
    ) {
        super(cause instanceof Error ? cause.message : String(cause));
        this.name = "RuntimeLaunchFailure";
        this.cause = cause;
    }
}

function managedPhaseMessage(phase: RuntimeInstallPhase, version: string): string {
    switch (phase) {
        case "preparing":
            return t("Preparing DSH Runtime {version}…", { version });
        case "downloading":
            return t("Downloading DSH Runtime {version}…", { version });
        case "verifying":
            return t("Verifying the downloaded DSH Runtime…");
        case "installing":
            return t("Installing DSH Runtime {version}…", { version });
    }
}

function managedLauncher(runtime: ManagedRuntime): DshLauncher {
    return {
        command: runtime.launcherPath,
        args: [],
        source: {
            kind: "managed",
            command: runtime.launcherPath,
            args: [],
            version: runtime.version,
            target: runtime.target,
        },
    };
}

/**
 * Fall back to the managed Runtime: reuse the local cache when healthy, or
 * download and install it. Progress is shown in a cancellable notification.
 */
async function discoverManagedRuntime(options: DiscoverDshOptions): Promise<DshLauncher> {
    const storagePath = options.storagePath;
    if (storagePath === undefined) {
        throw new Error(t("The managed DSH Runtime requires a global storage directory."));
    }
    const version = options.runtimeVersion;
    const log = options.onLog ?? (() => undefined);
    const target = resolveTarget();

    // Cached runtimes launch directly without any progress UI.
    const cached = await checkInstalled(storagePath, target, version);
    if (cached) {
        log(`[dsh:runtime] using managed Runtime ${version} (${target})`);
        return managedLauncher(cached);
    }

    log(`[dsh:runtime] managed Runtime ${version} (${target}) not cached; downloading`);
    const controller = new AbortController();
    const managed = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: t("DSH Runtime"),
            cancellable: true,
        },
        async (progress, token) => {
            let reportedPercent = 0;
            if (token.isCancellationRequested) {
                controller.abort();
            } else {
                token.onCancellationRequested(() => controller.abort());
            }
            try {
                return await acquireManagedRuntime(storagePath, {
                    version,
                    target,
                    log,
                    signal: controller.signal,
                    onPhase: (phase) => progress.report({ message: managedPhaseMessage(phase, version) }),
                    onDownloadProgress: (received, total) => {
                        const percent = Math.min(100, Math.floor((received / total) * 100));
                        if (percent <= reportedPercent) return;
                        progress.report({
                            increment: percent - reportedPercent,
                        });
                        reportedPercent = percent;
                    },
                    onWaiting: () =>
                        progress.report({
                            message: t("Waiting for another window to finish installing DSH Runtime {version}…", { version }),
                        }),
                    proxy: options.proxy,
                });
            } catch (error) {
                if (controller.signal.aborted || token.isCancellationRequested) {
                    throw new CanceledError();
                }
                throw error;
            }
        },
    );
    log(`[dsh:runtime] using managed Runtime ${version} (${target})`);
    return managedLauncher(managed);
}

/**
 * Resolve the DSH launcher in order: configured command, PATH dsh, npm global
 * prefix, pnpm dlx/npx, and finally the managed Runtime (cached, then
 * downloaded). Every provider failure is aggregated into the final error so a
 * failed download is never masked as a generic "dsh not available".
 */
async function discoverDsh(command: string, options: DiscoverDshOptions): Promise<DshLauncher> {
    const failures: string[] = [];

    if (await executableExists(command)) {
        return isPackageManagerCommand(command)
            ? packageManagerLauncher(command, [])
            : { command, args: [], source: { kind: "configured", command, args: [] } };
    }
    // pnpm dlx and npx are interchangeable package-manager launchers for the
    // published DSH package. Prefer the other one when the configured default
    // is missing, converting the packaged arguments where possible.
    if (isPackageManagerCommand(command)) {
        failures.push(t("{command}: not found", { command }));
        const alternateCommand = command === "pnpm" ? "npx" : "pnpm";
        if (await executableExists(alternateCommand)) {
            const alternateArgs = alternatePackageManagerArgs(command, alternateCommand, options.configuredArgs);
            if (alternateArgs) {
                return packageManagerLauncher(alternateCommand, alternateArgs, false);
            }
            failures.push(t("{command}: cannot reuse the configured package-manager arguments", {
                command: alternateCommand,
            }));
        } else {
            failures.push(t("{command}: not found", { command: alternateCommand }));
        }
        if (options.allowManaged && options.storagePath && options.installWhenMissing) {
            try {
                return await discoverManagedRuntime(options);
            } catch (error) {
                if (error instanceof CanceledError) throw error;
                const target = (() => {
                    try {
                        return resolveTarget();
                    } catch {
                        return "<unknown>";
                    }
                })();
                failures.push(t("Managed Runtime {version} ({target}): {reason}", {
                    version: options.runtimeVersion,
                    target,
                    reason: error instanceof Error ? error.message : String(error),
                }));
            }
        } else if (options.allowManaged && !options.installWhenMissing) {
            failures.push(t("Managed Runtime download is disabled by the dsh.installWhenMissing setting."));
        }
        throw new Error(t("Unable to start DSH Runtime.\n\n{reasons}", { reasons: failures.join("\n") }));
    }
    if (command !== "dsh") {
        throw new Error(t("Start command “{command}” was not found. Configure an absolute dsh.command path or install the dsh CLI.", { command }));
    }
    failures.push(t("PATH dsh: not found"));

    if (await executableExists("dsh")) {
        return { command: "dsh", args: [], source: { kind: "path", command: "dsh", args: [] } };
    }

    let npmPrefixProbed = false;
    try {
        const result = await execFileAsync("npm", ["prefix", "-g"], {
            timeout: 10_000,
            windowsHide: true,
            shell: process.platform === "win32",
        });
        const prefix = result.stdout.trim();
        if (prefix) {
            npmPrefixProbed = true;
            const binDir = process.platform === "win32" ? prefix : join(prefix, "bin");
            for (const name of process.platform === "win32" ? ["dsh.cmd", "dsh.exe", "dsh.ps1", "dsh"] : ["dsh"]) {
                const candidate = join(binDir, name);
                if (await executableExists(candidate)) {
                    return { command: candidate, args: [], source: { kind: "npm-prefix", command: candidate, args: [] } };
                }
            }
        }
    } catch {
        failures.push(t("npm: unavailable"));
    }
    if (npmPrefixProbed) {
        failures.push(t("No dsh executable was found in the npm global prefix."));
    }

    if (await executableExists("pnpm")) {
        const pnpmArgs = alternatePackageManagerArgs("npx", "pnpm", npxArgsForDsh(options.configuredArgs));
        if (pnpmArgs) return packageManagerLauncher("pnpm", pnpmArgs, false);
    }
    failures.push(t("pnpm: not found"));

    if (await executableExists("npx")) {
        return packageManagerLauncher("npx", npxArgsForDsh(options.configuredArgs), false);
    }
    failures.push(t("npx: not found"));

    if (options.allowManaged && options.storagePath) {
        if (options.installWhenMissing) {
            try {
                return await discoverManagedRuntime(options);
            } catch (error) {
                if (error instanceof CanceledError) {
                    throw error;
                }
                let target = "<unknown>";
                try {
                    target = resolveTarget();
                } catch {
                    // the failure reason below already describes the platform
                }
                const reason = error instanceof Error ? error.message : String(error);
                failures.push(
                    t("Managed Runtime {version} ({target}): {reason}", {
                        version: options.runtimeVersion,
                        target,
                        reason,
                    }),
                );
            }
        } else {
            failures.push(t("Managed Runtime download is disabled by the dsh.installWhenMissing setting."));
        }
    }

    throw new Error(t("Unable to start DSH Runtime.\n\n{reasons}", { reasons: failures.join("\n") }));
}

export class DshRuntime implements vscode.Disposable {
    private readonly listeners = new Set<RuntimeListener>();
    private readonly harnessConnectedListeners = new Set<HarnessConnectedListener>();
    private readonly remoteEventListeners = new Set<RemoteEventListener>();
    private readonly apiClient: RemoteUnaryClient;
    private readonly remoteConnection: RemoteConnectionController;
    private readonly harnessState: RemoteStateCoordinator;
    private readonly subagentHistoryCursors = new Map<string, number>();
    private child: ChildProcess | undefined;
    private baseUrl: string | undefined;
    private launchUrl: string | undefined;
    private authCookie: string | undefined;
    private authPromise: Promise<void> | undefined;
    private startPromise: Promise<string> | undefined;
    private startedByExtension = false;
    private runtimeLock: { handle: FileHandle; path: string; createdAt: number } | undefined;
    private runtimeLockWrite: Promise<void> = Promise.resolve();
    private compactionPatchPath: string | undefined;
    private disposed = false;
    private status: RuntimeStatus = { state: "stopped" };
    private hostDescription: HarnessHostDescription | undefined;

    public constructor(
        private readonly output: vscode.OutputChannel,
        private readonly storagePath: string,
    ) {
        this.apiClient = new RemoteUnaryClient({
            baseUrl: () => this.baseUrl,
            requestHeaders: () => this.requestHeaders(),
            timeoutMs: () =>
                this.configuration().get<number>("requestTimeoutMs", 600_000),
            onDiagnostic: (message, cause) => {
                const suffix = cause === undefined ? "" : `: ${String(cause)}`;
                this.output.appendLine(`[dsh:rpc] ${message}${suffix}`);
            },
        });
        this.remoteConnection = new RemoteConnectionController({
            baseUrl: () => this.baseUrl,
            requestHeaders: () => this.requestHeaders(),
            unary: this.apiClient,
            onDiagnostic: (message, cause) => {
                const suffix = cause === undefined ? "" : `: ${String(cause)}`;
                this.output.appendLine(`[dsh:remote] ${message}${suffix}`);
            },
        });
        this.harnessState = new RemoteStateCoordinator(this.remoteConnection, {
            onConnectionState: (state) => this.output.appendLine(`[dsh:remote] connection ${state}`),
            onHostDescription: (description) => {
                this.hostDescription = {
                    ...description,
                    canOpenPath: description.canOpenPath,
                };
                // A follow/page cut is generation-scoped. Any subagent page
                // request after reconnect must reopen its follow snapshot
                // instead of reusing a cursor from the dead carrier.
                this.subagentHistoryCursors.clear();
                for (const listener of this.harnessConnectedListeners) listener();
            },
            onHostFrame: (frame) => {
                if (frame.type !== "host/remote-event") return;
                const event = (frame as { event?: unknown }).event;
                if (typeof event !== "string") return;
                for (const listener of this.remoteEventListeners) listener(event);
            },
            onDiagnostic: (message, cause) => {
                const suffix = cause === undefined ? "" : `: ${String(cause)}`;
                this.output.appendLine(`[dsh:remote] ${message}${suffix}`);
            },
        }, { runtimeVersion: RUNTIME_DEFAULT_VERSION });
    }

    public onDidChange(listener: RuntimeListener): vscode.Disposable {
        this.listeners.add(listener);
        return new vscode.Disposable(() => this.listeners.delete(listener));
    }

    /** Fires once for every fully connected mux/host stream generation. */
    public onDidHarnessConnect(listener: HarnessConnectedListener): vscode.Disposable {
        this.harnessConnectedListeners.add(listener);
        return new vscode.Disposable(() => this.harnessConnectedListeners.delete(listener));
    }

    /**
     * Fires for each forwarded host event, by its own cordis name. Consumers
     * treat these as invalidation signals and repull, because the forwarding
     * path carries no diff.
     */
    public onDidRemoteEvent(listener: RemoteEventListener): vscode.Disposable {
        this.remoteEventListeners.add(listener);
        return new vscode.Disposable(() => this.remoteEventListeners.delete(listener));
    }

    public getStatus(): RuntimeStatus {
        return { ...this.status };
    }

    public getUrl(): string | undefined {
        return this.baseUrl;
    }

    /** URL suitable for opening in a browser, including the launch token. */
    public getBrowserUrl(): string | undefined {
        return this.launchUrl ?? this.baseUrl;
    }

    public getHostDescription(): HarnessHostDescription | undefined {
        return this.hostDescription ? { ...this.hostDescription } : undefined;
    }

    /** Returns a redacted, read-only environment report without starting dsh. */
    public async diagnoseEnvironment(workspaceRoot?: string): Promise<string> {
        const configuration = this.configuration();
        const command = configuration.get<string>("command", "dsh").trim() || "dsh";
        const configuredArgs = configuration.get<string[]>("commandArgs", ["web", "--no-open"]);
        const args = Array.isArray(configuredArgs)
            ? configuredArgs.filter((argument): argument is string => typeof argument === "string")
            : [];
        const serverUrl = configuration.get<string>("serverUrl", "").trim();
        const configuredPort = configuration.get<number>("serverPort", 0);
        const apiKeyRef = configuration.get<string>("apiKeyEnv", "DEEPSEEK_API_KEY").trim();
        const commandPath = await findExecutable(command);
        const dshPath = await findExecutable("dsh");
        const npxPath = await findExecutable("npx");
        const pnpmPath = await findExecutable("pnpm");
        const npmPath = await findExecutable("npm");
        const prefix = await globalNpmPrefix();

        const installWhenMissing = configuration.get<boolean>("installWhenMissing", true);
        const runtimeVersion = configuration.get<string>("runtimeVersion", RUNTIME_DEFAULT_VERSION) || RUNTIME_DEFAULT_VERSION;
        const npxTimeoutMs = configuration.get<number>("npxTimeoutMs", DEFAULT_NPX_TIMEOUT_MS);
        const npmRegistry = normalizeNpmRegistry(
            configuration.get<string>("npmRegistry", DEFAULT_NPM_REGISTRY),
        );
        const packageManager = isPackageManagerCommand(command) ? command : undefined;
        const hasExplicitRegistry = hasNpmRegistryArgument(args, packageManager);
        const activeRegistry = isPackageManagerCommand(command) && !hasExplicitRegistry
            ? await activeNpmRegistry(workspaceRoot, command)
            : undefined;
        const fallbackRegistry = hasExplicitRegistry
            ? undefined
            : alternateNpmRegistry(npmRegistry, activeRegistry);

        let discovery: string;
        try {
            const launcher = await discoverDsh(command, {
                storagePath: this.storagePath,
                installWhenMissing,
                runtimeVersion,
                configuredArgs: args,
                allowManaged: false,
                proxy: this.httpProxy(),
            });
            discovery = `${launcher.command} (${describeSource(launcher.source)})`;
        } catch (error) {
            discovery = `error: ${error instanceof Error ? error.message : String(error)}`;
        }

        let managedRuntime: string;
        if (installWhenMissing) {
            try {
                const target = resolveTarget();
                const cached = await checkInstalled(this.storagePath, target, runtimeVersion);
                managedRuntime = cached
                    ? `cached (${runtimeVersion}, ${target})`
                    : `available, not cached (${runtimeVersion}, ${target})`;
            } catch (error) {
                managedRuntime = `unsupported: ${error instanceof Error ? error.message : String(error)}`;
            }
        } else {
            managedRuntime = "disabled by dsh.installWhenMissing=false";
        }

        let health = "not running";
        if (this.baseUrl) {
            health = (await this.isHealthy(this.baseUrl)) ? "healthy" : "unreachable";
        }

        let hostDescription = this.hostDescription;
        let rpcHealth = "not checked";
        if (health === "healthy") {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 3_000);
            try {
                await this.apiClient.probe(controller.signal);
                hostDescription = this.hostDescription;
                rpcHealth = "ok";
            } catch {
                rpcHealth = "failed";
            } finally {
                clearTimeout(timeout);
            }
        }

        const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
        const lines = [
            "DSH environment report",
            `Generated: ${new Date().toISOString()}`,
            `VS Code: ${vscode.version}`,
            `Node: ${process.versions.node}`,
            `Platform: ${process.platform} ${process.arch}`,
            `Workspace trusted: ${vscode.workspace.isTrusted ? "yes" : "no"}`,
            `Workspace root argument: ${workspaceRoot ?? "<none>"}`,
            `Workspace folders: ${workspaceFolders.length ? workspaceFolders.map((folder) => folder.uri.fsPath).join(" | ") : "<none>"}`,
            `Configured server URL: ${serverUrl ? redactUrl(serverUrl) : "<none>"}`,
            `Configured server port: ${configuredPort || "automatic"}`,
            `Configured command: ${command} ${redactArguments(args)}`.trim(),
            `package-manager startup timeout: ${npxTimeoutMs} ms`,
            `package-manager active registry: ${activeRegistry ? redactUrl(activeRegistry) : "<npm default>"}`,
            `package-manager fallback registry: ${fallbackRegistry ? redactUrl(fallbackRegistry) : "<disabled>"}`,
            `Resolved command: ${commandPath ?? "<not found>"}`,
            `Resolved dsh: ${dshPath ?? "<not found>"}`,
            `Resolved npx: ${npxPath ?? "<not found>"}`,
            `Resolved pnpm: ${pnpmPath ?? "<not found>"}`,
            `Resolved npm: ${npmPath ?? "<not found>"}`,
            `npm global prefix: ${prefix ?? "<unavailable>"}`,
            `Managed Runtime: ${managedRuntime}`,
            `Discovered launcher: ${discovery}`,
            `Runtime status: ${this.status.state}`,
            `Runtime URL: ${this.baseUrl ? redactUrl(this.baseUrl) : "<none>"}`,
            `Runtime health: ${health}`,
            `Remote RPC probe: ${rpcHealth}`,
            `Remote protocol: RC Remote v1 (generation ${this.remoteConnection.currentGeneration || "<none>"})`,
            `Configured Runtime version: ${runtimeVersion}`,
            `Host version: ${hostDescription?.version ?? "<unknown>"}`,
            `Host cwd: ${hostDescription?.cwd ?? "<unknown>"}`,
            `API key reference: ${apiKeyRef || "<empty>"}`,
            `API key environment variable present: ${apiKeyRef && process.env[apiKeyRef] ? "yes" : "no"}`,
        ];
        return lines.join("\n");
    }

    public getApiClient(): RemoteUnaryClient {
        return this.apiClient;
    }

    public getSessionStore(): RemoteStateCoordinator["sessions"] {
        return this.harnessState.sessions;
    }

    public getSessionCatalog(): RemoteStateCoordinator["catalog"] {
        return this.harnessState.catalog;
    }

    public syncSession(sessionId: string): Promise<void> {
        return this.harnessState.syncHistory(sessionId);
    }

    public async start(workspaceRoot?: string): Promise<string> {
        if (this.disposed) {
            throw new Error(t("The dsh-ide runtime has already been disposed."));
        }

        if (this.startPromise) {
            return this.startPromise;
        }

        this.startPromise = this.startInternal(workspaceRoot);
        try {
            return await this.startPromise;
        } finally {
            this.startPromise = undefined;
        }
    }

    public async restart(workspaceRoot?: string): Promise<string> {
        await this.stop();
        return this.start(workspaceRoot);
    }

    public async stop(): Promise<void> {
        await this.harnessState.stop();
        this.subagentHistoryCursors.clear();
        const child = this.child;
        this.child = undefined;
        this.baseUrl = undefined;
        this.launchUrl = undefined;
        this.authCookie = undefined;
        this.authPromise = undefined;
        this.hostDescription = undefined;

        if (child && this.startedByExtension) {
            await this.terminate(child);
        }

        await this.releaseRuntimeLock();

        this.startedByExtension = false;
        this.setStatus({ state: "stopped" });
    }

    public createWorkspace(path: string): Promise<DshWorkspaceCreateResult> {
        return this.apiClient.call("workspace/create", { request: { path } });
    }

    public async renameWorkspace(workspaceId: string, title: string): Promise<DshWorkspaceView> {
        const result = await this.apiClient.call<{ workspace: DshWorkspaceView }>("workspace/rename", {
            request: { workspaceId, title },
        });
        this.harnessState.catalog.upsertWorkspace(result.workspace);
        return result.workspace;
    }

    public async deleteWorkspace(workspaceId: string): Promise<void> {
        await this.apiClient.call("workspace/delete", { request: { workspaceId } });
        this.harnessState.catalog.removeWorkspace(workspaceId);
    }

    public async moveWorkspace(workspaceId: string, beforeWorkspaceId?: string): Promise<void> {
        const result = await this.apiClient.call<{ workspaceIds: string[] }>("workspace/insertBefore", {
            request: {
                workspaceId,
                ...(beforeWorkspaceId === undefined ? {} : { beforeWorkspaceId }),
            },
        });
        this.harnessState.catalog.replaceWorkspaceOrder(result.workspaceIds);
    }

    public async moveWorkspaceSession(
        workspaceId: string,
        sessionId: string,
        beforeSessionId?: string,
    ): Promise<void> {
        const result = await this.apiClient.call<{ workspace: DshWorkspaceView }>("workspace/insertSessionBefore", {
            request: {
                workspaceId,
                sessionId,
                ...(beforeSessionId === undefined ? {} : { beforeSessionId }),
            },
        });
        this.harnessState.catalog.upsertWorkspace(result.workspace);
    }

    public async createSession(
        cwd: string | undefined,
        agentPreset?: string,
        workspaceId?: string,
    ): Promise<DshSessionCreateResult> {
        const result = await this.apiClient.call<DshSessionCreateResult>("session/create", {
            request: {
                ...(workspaceId === undefined ? {} : { workspaceId }),
                ...(cwd === undefined ? {} : { cwd }),
                ...(agentPreset === undefined ? {} : { agentPreset }),
            },
        });
        this.harnessState.catalog.upsertCreated(result.sessionId, cwd, {
            ...(result.agentPreset === undefined ? {} : { agentPreset: result.agentPreset }),
        });
        this.harnessState.watchSession(result.sessionId);
        return result;
    }

    public searchSessions(query: string, signal?: AbortSignal): Promise<DshSessionSearchResult> {
        return this.apiClient.call("session/search", { request: { query } }, signal);
    }

    /** Resolve Runtime-owned files and directories for the active Composer @ menu. */
    public async listFileReferences(
        sessionId: string,
        query: string,
        signal?: AbortSignal,
    ): Promise<DshFileReferenceCandidate[] | undefined> {
        try {
            const value = await this.apiClient.call("fileReferences/list", {
                agentId: sessionId,
                query,
            }, signal);
            const candidates = normalizeFileReferenceCandidates(value);
            if (!candidates) {
                throw new RemoteProtocolError(
                    "Remote fileReferences/list returned an invalid candidate list",
                );
            }
            return candidates;
        } catch (error) {
            // RC1 clients can connect to an older Runtime that has no file
            // reference provider. The Composer will use its local index then.
            if (error instanceof RemoteHttpError && error.status === 404) return undefined;
            throw error;
        }
    }

    /** Resolve canonical cross-session mentions for the active Composer @ menu. */
    public async listSessionReferenceCandidates(
        sessionId: string,
        query: string,
        signal?: AbortSignal,
    ): Promise<DshSessionReferenceCandidate[] | undefined> {
        try {
            const value = await this.apiClient.call("sessionReferenceResolver/candidates", {
                agentId: sessionId,
                query,
            }, signal);
            const candidates = normalizeSessionReferenceCandidates(value);
            if (!candidates) {
                throw new RemoteProtocolError(
                    "Remote sessionReferenceResolver/candidates returned an invalid candidate list",
                );
            }
            return candidates;
        } catch (error) {
            // Keep older Runtime versions useful by retaining the local catalog
            // and session/search fallback when the optional Remote is absent.
            if (error instanceof RemoteHttpError && error.status === 404) return undefined;
            throw error;
        }
    }

    public async renameSession(
        sessionId: string,
        title: string,
    ): Promise<DshSessionRenameResult> {
        const result = await this.apiClient.call<DshSessionRenameResult>("session/rename", {
            request: { sessionId, title },
        });
        this.harnessState.catalog.applyRename(sessionId, result.title, result.seq);
        return result;
    }

    public async forkSession(sessionId: string, atSeq?: number): Promise<DshSessionForkResult> {
        const source = this.harnessState.catalog
            .snapshot()
            .sessions.find((session) => session.sessionId === sessionId);
        const sourceCwd = source?.cwd;
        const sourceProjectionTitle = this.harnessState.sessions
            .get(sessionId)
            ?.projections.find((projection) => projection.key === "title")?.value;
        const sourceTitle = source?.title?.trim() ||
            (typeof sourceProjectionTitle === "string" && sourceProjectionTitle.trim()
                ? sourceProjectionTitle.trim()
                : undefined);
        const result = await this.apiClient.call<DshSessionForkResult>("session/fork", {
            request: {
                sessionId,
                ...(atSeq === undefined ? {} : { atSeq }),
            },
        });
        // The fork response intentionally contains only the child id. Seed the
        // local catalog with the source metadata so switching immediately after
        // the RPC does not lose the workspace lineage or mark a non-empty child
        // as a blank session. The upsert merges with a host/session-added frame
        // if that frame won the race against the RPC response.
        this.harnessState.catalog.upsertCreated(result.sessionId, sourceCwd, {
            blank: false,
            parentSessionId: sessionId,
        });
        if (sourceTitle !== undefined) {
            // Host fork preserves the inherited title. Rename the child after
            // creation to match the client contract (e.g. Helo -> Helo (1)).
            // Disambiguation is cosmetic and the fork itself already succeeded,
            // so a rename failure must not reject the child id away.
            try {
                await this.renameSession(result.sessionId, increasedForkTitle(sourceTitle));
            } catch (error) {
                this.output.appendLine(
                    `[dsh] fork title update failed: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }
        return result;
    }

    public async archiveSession(sessionId: string): Promise<void> {
        const result = await this.apiClient.call<{ archivedSessionIds: string[] }>("workspace/archiveSession", {
            request: { sessionId },
        });
        this.harnessState.catalog.replaceArchived(result.archivedSessionIds);
    }

    /** Report whether the composed Runtime can open a Session workspace path. */
    public canOpenWorkspacePath(signal?: AbortSignal): Promise<boolean> {
        return this.apiClient.call("session/canOpenWorkspacePath", {}, signal);
    }

    /** Open a Session-aware path through the Runtime's native opener. */
    public openWorkspacePath(path: string, signal?: AbortSignal): Promise<{ opened: true }> {
        return this.apiClient.call("session/openWorkspacePath", { request: { path } }, signal);
    }

    /** Pick a directory when the Runtime composes a native picker capability. */
    public pickDirectory(signal?: AbortSignal): Promise<string | null> {
        return this.apiClient.call("directoryPicker/pick", {}, signal);
    }

    /** List one directory level through the Runtime's browse capability. */
    public listDirectory(path?: string, signal?: AbortSignal): Promise<DshDirectoryListing> {
        return this.apiClient.call("directoryPicker/list", path === undefined ? {} : { path }, signal);
    }

    /** Create one child directory through the Runtime's browse capability. */
    public createDirectory(path: string, name: string, signal?: AbortSignal): Promise<string> {
        return this.apiClient.call("directoryPicker/createDirectory", { path, name }, signal);
    }

    public async refreshSessions(): Promise<void> {
        await this.harnessState.refreshCatalog();
    }

    public async history(sessionId: string, maxMessages = 100): Promise<DshHistoryResult> {
        await this.harnessState.syncHistory(sessionId);
        const snapshot = this.harnessState.sessions.get(sessionId);
        const events = snapshot?.events.slice(-Math.max(1, maxMessages)).map((entry) => ({
            event: entry.event,
            ...(entry.view === undefined ? {} : { view: entry.view }),
        })) ?? [];
        const projections = snapshot
            ? snapshot.projections.length > 0
                ? {
                      asOfSeq: Math.max(...snapshot.projections.map((cell) => cell.seq), -1),
                      values: Object.fromEntries(snapshot.projections.map((cell) => [cell.key, cell.value])),
                  }
                : undefined
            : undefined;
        return { events, hasMore: false, ...(projections === undefined ? {} : { projections }) };
    }

    public async prompt(
        sessionId: string,
        text: string,
        mode: "queue" | "steer" = "queue",
        images: readonly DshImageUpload[] = [],
        requestId: string = randomUUID(),
    ): Promise<DshSessionPromptResult> {
        return this.apiClient.call("session/prompt", {
            request: {
                requestId,
                sessionId,
                mode,
                content: [
                    ...(text ? [{ type: "text" as const, text }] : []),
                    ...images.map((image) => ({
                        type: "image" as const,
                        mediaType: image.mediaType,
                        data: image.data,
                        ...(image.name === undefined ? {} : { name: image.name }),
                    })),
                ],
                ...(Intl.DateTimeFormat().resolvedOptions().timeZone
                    ? { clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }
                    : {}),
            },
        });
    }

    public attachment(sessionId: string, attachmentId: string): Promise<DshImageAttachmentResult> {
        return this.apiClient.call("session/attachment", { request: { sessionId, attachmentId } });
    }

    public async models(sessionId: string): Promise<DshSessionModelsResult> {
        const catalog = await this.apiClient.call<{
            default: { provider: string; model: string; reasoningEffort?: string };
            routableProviders: string[];
            groups: DshSessionModelsResult["groups"];
            failures: DshSessionModelsResult["failures"];
        }>("session/modelCatalog", {});
        const selection = normalizeModelSelectionProjection(
            this.harnessState.sessions.get(sessionId)?.projections
                .find((cell) => cell.key === "modelSelection")?.value,
        );
        const current = selection ?? catalog.default;
        return {
            current,
            routable: catalog.routableProviders.includes(current.provider),
            groups: catalog.groups,
            failures: catalog.failures,
        };
    }

    public selectModel(selection: {
        sessionId: string;
        provider: string;
        model: string;
        reasoningEffort?: string;
    }): Promise<DshSessionSelectModelResult> {
        return this.apiClient.call("session/selectModel", { request: selection });
    }

    public async agentPresets(): Promise<DshAgentPresetListResult> {
        const result = await this.apiClient.call<Partial<DshAgentPresetListResult>>("agentPresets/list", {});
        return {
            presets: result.presets ?? [],
            authorable: result.authorable === true,
            hasDocument: result.hasDocument ?? result.authorable === true,
        };
    }

    public async selectAgentPreset(sessionId: string, agentPreset: string): Promise<DshAgentPresetSelectResult> {
        const selected = await this.apiClient.call<string>("agentPresets/select", {
            agentId: sessionId,
            agentPreset,
        });
        return { agentPreset: selected };
    }

    public readAgentPreset(agentPreset: string): Promise<DshAgentPresetReadResult> {
        return this.apiClient.call("agentPresets/read", { agentPreset });
    }

    public async copyAgentPreset(from: string, agentPreset: string, name?: string): Promise<string> {
        await this.apiClient.call("agentPresets/copy", {
            from,
            id: agentPreset,
            ...(name === undefined ? {} : { name }),
        });
        return agentPreset;
    }

    public openAgentPresetDocument(agentPreset: string): Promise<DshAgentPresetOpenResult> {
        return this.apiClient.call("settings/openAgentPresetDirectory", { agentPreset });
    }

    public async removeAgentPreset(agentPreset: string): Promise<void> {
        await this.apiClient.call("agentPresets/deletePreset", { id: agentPreset });
    }

    public async setDefaultAgentPreset(agentPreset: string): Promise<void> {
        await this.apiClient.call("settings/update", {
            ns: "agent-presets",
            patch: { default: agentPreset },
        });
    }

    public async cancel(sessionId: string): Promise<void> {
        await this.apiClient.call("session/cancel", { request: { sessionId } });
    }

    public async updateQueue(
        sessionId: string,
        itemId: string,
        action: HarnessQueueAction,
    ): Promise<void> {
        await this.apiClient.call("session/updateQueue", { request: { sessionId, itemId, action } });
    }

    public createGoal(
        sessionId: string,
        objective: string,
        maxGoalRounds?: number,
    ): Promise<DshGoalRefResult> {
        return this.apiClient.call("goals/create", {
            agentId: sessionId,
            request: {
                objective,
                ...(maxGoalRounds === undefined ? {} : { maxGoalRounds }),
            },
        }).then((value) => normalizeGoalRefResult(value, "goals/create"));
    }

    public editGoal(
        sessionId: string,
        ref: DshGoalRef,
        changes: HarnessGoalEditChanges,
    ): Promise<DshGoalRefResult> {
        return this.apiClient
            .call("goals/edit", { agentId: sessionId, ref, request: changes })
            .then((value) => normalizeGoalRefResult(value, "goals/edit"));
    }

    public pauseGoal(sessionId: string, ref: DshGoalRef): Promise<DshGoalRefResult> {
        return this.apiClient
            .call("goals/pause", { agentId: sessionId, ref })
            .then((value) => normalizeGoalRefResult(value, "goals/pause"));
    }

    public resumeGoal(sessionId: string, ref: DshGoalRef): Promise<DshGoalRefResult> {
        return this.apiClient
            .call("goals/resume", { agentId: sessionId, ref })
            .then((value) => normalizeGoalRefResult(value, "goals/resume"));
    }

    public completeGoal(sessionId: string, ref: DshGoalRef): Promise<DshGoalRefResult> {
        return this.apiClient
            .call("goals/complete", { agentId: sessionId, ref })
            .then((value) => normalizeGoalRefResult(value, "goals/complete"));
    }

    public async clearGoal(sessionId: string, ref: DshGoalRef): Promise<{ cleared: true }> {
        const value = await this.apiClient.call("goals/clear", { agentId: sessionId, ref });
        // RC returns the tombstone GoalRef; the editor facade keeps its
        // historical `{ cleared: true }` acknowledgement shape.
        normalizeGoalRefResult(value, "goals/clear");
        return { cleared: true };
    }

    public listSubagents(
        parentSessionId: string,
        signal?: AbortSignal,
    ): Promise<DshSubagentCatalog> {
        return this.apiClient.call("subagents/list", { parentSessionId }, signal);
    }

    public async subagentHistory(
        address: DshSubagentAddress,
        beforeSeq?: number,
        maxMessages?: number,
        signal?: AbortSignal,
    ): Promise<DshSubagentHistoryResult> {
        const wireAddress = {
            kind: "subagent" as const,
            parentSessionId: address.parentSessionId,
            childSessionId: address.childSessionId,
            mode: address.mode,
        };
        const cacheKey = `${address.parentSessionId}:${address.childSessionId}:${address.mode}`;
        let throughSeq = this.subagentHistoryCursors.get(cacheKey);

        // The first page is opened through the addressed follow stream. This
        // supplies both the message-aligned tail and the cursor that must stay
        // fixed for subsequent backwards pagination.
        if (beforeSeq === undefined || throughSeq === undefined) {
            const oneShot = new AbortController();
            const followSignal = signal === undefined
                ? oneShot.signal
                : AbortSignal.any([signal, oneShot.signal]);
            let snapshot: { records: unknown[]; hasMore: boolean; projections?: unknown; cursor: number } | undefined;
            try {
                for await (const value of this.remoteConnection.open("session/follow", {
                    request: {
                        address: wireAddress,
                        ...(maxMessages === undefined ? {} : { maxMessages }),
                    },
                }, followSignal)) {
                    if (!isRemoteRecord(value) || value.type !== "snapshot") {
                        throw new RemoteProtocolError("Remote subagent follow did not begin with a snapshot");
                    }
                    if (!isSafeRemoteSeq(value.cursor)) throw new RemoteProtocolError("Remote subagent follow returned an invalid cursor");
                    if (!Array.isArray(value.records) || typeof value.hasMore !== "boolean") {
                        throw new RemoteProtocolError("Remote subagent follow snapshot is malformed");
                    }
                    snapshot = {
                        records: value.records,
                        hasMore: value.hasMore,
                        ...(value.projections === undefined ? {} : { projections: value.projections }),
                        cursor: value.cursor,
                    };
                    break;
                }
            } finally {
                oneShot.abort();
            }
            if (!snapshot) throw new Error(`Remote subagent ${address.childSessionId} did not provide a follow snapshot`);
            throughSeq = snapshot.cursor;
            this.subagentHistoryCursors.set(cacheKey, throughSeq);
            this.harnessState.watchSubagent(wireAddress);
            if (beforeSeq === undefined) {
                return {
                    events: remoteHistoryEntries(snapshot.records),
                    hasMore: snapshot.hasMore,
                    ...(snapshot.projections === undefined ? {} : { projections: remoteProjectionBlock(snapshot.projections) }),
                };
            }
        }

        const page = await this.apiClient.call<unknown>("session/page", {
            request: {
                address: wireAddress,
                throughSeq,
                beforeSeq,
                ...(maxMessages === undefined ? {} : { maxMessages }),
            },
        }, signal);
        if (!isRemoteRecord(page) || !Array.isArray(page.records) || typeof page.hasMore !== "boolean") {
            throw new RemoteProtocolError("Remote subagent page is malformed");
        }
        const records = page.records;
        const events = remoteHistoryEntries(records);
        if (beforeSeq !== undefined) {
            for (const entry of events) {
                if (typeof entry.event.seq !== "number" || entry.event.seq >= beforeSeq) {
                    throw new RemoteProtocolError("Remote subagent page contains an out-of-range sequence");
                }
            }
            if (page.hasMore && events.length === 0) {
                throw new RemoteProtocolError("Remote subagent page advertised more history without records");
            }
        }
        return {
            events,
            hasMore: page.hasMore,
        };
    }

    public promptSubagent(
        address: Extract<DshSubagentAddress, { mode: "continuable" }>,
        text: string,
        signal?: AbortSignal,
    ): Promise<DshSubagentPromptResult> {
        const clientTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        return this.apiClient.call("subagents/prompt", {
            parentSessionId: address.parentSessionId,
            childSessionId: address.childSessionId,
            mode: address.mode,
            requestId: randomUUID(),
            content: [{ type: "text", text }],
            ...(clientTimeZone ? { clientTimeZone } : {}),
        }, signal);
    }

    public interruptSubagent(
        address: Extract<DshSubagentAddress, { mode: "continuable" }>,
        signal?: AbortSignal,
    ): Promise<{ accepted: true }> {
        return this.apiClient.call("subagents/interruptByParent", address, signal);
    }

    /** Reads the Host-owned per-message feedback sidecar for one Session. */
    public async listMessageFeedback(
        sessionId: string,
        signal?: AbortSignal,
    ): Promise<DshMessageFeedbackListResult | undefined> {
        try {
            return await this.apiClient.call("messageFeedback/list", {
                request: { sessionId } satisfies DshMessageFeedbackListRequest,
            }, signal);
        } catch (error) {
            // The sidecar is optional on older or minimally composed Runtimes.
            if (error instanceof RemoteHttpError && error.status === 404) return undefined;
            throw error;
        }
    }

    /** Creates or replaces one feedback item using its observed CAS version. */
    public async putMessageFeedback(
        request: DshMessageFeedbackPutRequest,
        signal?: AbortSignal,
    ): Promise<DshMessageFeedbackPutResult | undefined> {
        try {
            return await this.apiClient.call("messageFeedback/put", { request }, signal);
        } catch (error) {
            if (error instanceof RemoteHttpError && error.status === 404) return undefined;
            throw error;
        }
    }

    /** Removes one feedback item after observing its current CAS version. */
    public async deleteMessageFeedback(
        request: DshMessageFeedbackDeleteRequest,
        signal?: AbortSignal,
    ): Promise<DshMessageFeedbackDeleteResult | undefined> {
        try {
            return await this.apiClient.call("messageFeedback/delete", { request }, signal);
        } catch (error) {
            if (error instanceof RemoteHttpError && error.status === 404) return undefined;
            throw error;
        }
    }

    public async respondRemoteEvent(
        eventId: string,
        outcome: import("./remote/contracts").RemoteEventOutcome,
    ): Promise<void> {
        await this.remoteConnection.answerRemoteEvent(eventId, outcome);
    }

    /** Stores a credential in the runtime-owned credential provider. */
    public async setCredential(ref: string, value: string): Promise<void> {
        await this.apiClient.call("credentials/set", { ref, value });
    }

    public listProviders(): Promise<DshProviderListResult> {
        return Promise.all([
            this.apiClient.call<readonly { id: string }[]>("llm/listProviders", {}),
            this.apiClient.call<readonly {
                provider: string;
                displayName: string;
                settingsNs: string;
                settingsPath: string[];
                declared?: boolean;
            }[]>(
                "llm/listConfigurableProviders",
                {},
            ),
        ]).then(([activeProviders, configurableProviders]) => {
            const active = new Set(activeProviders.map((provider) => provider.id));
            return {
                providers: configurableProviders.map((provider) => ({
                    ...provider,
                    active: active.has(provider.provider),
                })),
            };
        });
    }

    /** Returns the host-scoped catalog used by provider configuration surfaces. */
    public listLlmModels(): Promise<DshLlmModelsResult> {
        return this.apiClient.call("session/modelCatalog", {}).then((result) => ({
            groups: (result as { groups?: DshLlmModelsResult["groups"] }).groups ?? [],
            failures: (result as { failures?: DshLlmModelsResult["failures"] }).failures ?? [],
        }));
    }

    /** Interrogates a provider endpoint using an unsaved configuration draft. */
    public discoverLlmModels(
        payload: {
            settingsNs: string;
            provider?: string;
            baseURL?: string;
            api?: string;
            apiKey?: string;
        },
        signal?: AbortSignal,
    ): Promise<DshLlmDiscoverModelsResult> {
        const { settingsNs, ...request } = payload;
        return this.apiClient.call<DshLlmDiscoverModelsResult["models"]>("llm/discoverModels", {
            settingsNs,
            request,
        }, signal).then((models) => ({ models }));
    }

    public describeSettings(): Promise<DshSettingsDescribeResult> {
        return this.apiClient.call("settings/describe", {});
    }

    public describeCredentials(refs: string[]): Promise<DshCredentialDescribeResult> {
        return this.apiClient.call("credentials/describe", { refs });
    }

    public async unsetCredential(ref: string): Promise<void> {
        await this.apiClient.call("credentials/unset", { ref });
    }

    public async openSettingsDocument(): Promise<void> {
        await this.apiClient.call("settings/openSettingsDocument", {});
    }

    public mutateSettings(
        ns: string,
        ops: DshSettingsPathOperation[],
        expectedRevision?: number,
    ): Promise<DshSettingsNamespaceView> {
        return this.apiClient.call("settings/mutate", {
            ns,
            ops,
            ...(expectedRevision === undefined ? {} : { expectedRevision }),
        });
    }

    public async describeHost(): Promise<HarnessHostDescription> {
        return this.hostDescription ?? {
            version: "0.1.2-rc.1",
            cwd: "",
            attachedSessions: this.harnessState.catalog.snapshot().sessions.length,
            canOpenPath: true,
        };
    }

    public async listSkills(sessionId: string): Promise<DshSkillEntry[]> {
        const result = await this.apiClient.call<{ skills: DshSkillEntry[] }>("skills/list", { request: { sessionId } });
        return result.skills;
    }

    /**
     * Host-registered slash commands for one session, or undefined when the
     * connected Runtime serves no command registry (the Gateway answers 404
     * for an endpoint no composed plugin claims). Callers degrade to their
     * IDE-local commands rather than surfacing the gap as an error.
     */
    public async listCommands(sessionId: string): Promise<DshCommandDescriptor[] | undefined> {
        try {
            const commands = await this.apiClient.call<readonly DshCommandDescriptor[]>("commands/list", { agentId: sessionId });
            return [...commands];
        } catch (error) {
            if (error instanceof RemoteHttpError && error.status === 404) return undefined;
            throw error;
        }
    }

    /**
     * Runs one complete slash-command line against a session's agent. This is
     * pure admission: the resolved handler's outcome is also logged durably as
     * a `command/run` / `command/done` pair on the session. `undefined` means
     * the line resolved to no registered command.
     *
     * Images are handed over verbatim; the host executor enforces each
     * command's own `input.images` declaration and settles a non-declaring
     * invocation as an error before its handler runs.
     */
    public async executeCommand(
        sessionId: string,
        line: string,
        images: readonly DshImageUpload[] = [],
    ): Promise<DshCommandExecution | undefined> {
        return this.apiClient.call("commands/execute", { agentId: sessionId, line, images });
    }

    public async dispose(): Promise<void> {
        this.disposed = true;
        await this.stop();
    }

    private async startInternal(workspaceRoot?: string): Promise<string> {
        const configuration = this.configuration();
        const configuredUrl = configuration.get<string>("serverUrl", "").trim();
        const startupTimeout = configuration.get<number>("startupTimeoutMs", 30_000);

        if (!vscode.workspace.isTrusted) {
            const message = t("Trust the current workspace before dsh can run agent operations.");
            this.setStatus({ state: "error", message });
            throw new Error(message);
        }

        if (configuredUrl && isInsecureRemoteRuntimeUrl(configuredUrl)) {
            const message = t("Remote dsh Runtime URLs must use HTTPS.");
            this.setStatus({ state: "error", message });
            throw new Error(message);
        }

        this.setStatus({ state: "starting", message: t("Connecting to dsh web...") });

        if (configuredUrl) {
            if (this.child && this.startedByExtension) {
                await this.stop();
                this.setStatus({ state: "starting", message: t("Connecting to dsh web...") });
            }
            const endpoint = parseRuntimeEndpoint(configuredUrl);
            if (!endpoint) {
                const message = t("Invalid dsh Runtime URL.");
                this.setStatus({ state: "error", message });
                throw new Error(message);
            }
            const url = endpoint.baseUrl;
            this.setRuntimeEndpoint(endpoint);
            await this.waitForReady(url, startupTimeout);
            this.baseUrl = url;
            this.startedByExtension = false;
            this.setStatus({ state: "running", url });
            this.harnessState.start();
            return url;
        }

        if (this.baseUrl && (await this.isHarnessHealthy(this.baseUrl))) {
            this.setStatus({ state: "running", url: this.baseUrl });
            this.harnessState.start();
            return this.baseUrl;
        }

        // Reuse a Runtime started by the CLI, another VS Code window, or a
        // previous extension instance before creating another writer process.
        // Harness's web profile defaults to port 3080; an explicit setting wins.
        const configuredPort = this.configuration().get<number>("serverPort", 0);
        const existingEndpoint = await this.findExistingRuntime(configuredPort);
        if (existingEndpoint) {
            this.setRuntimeEndpoint(existingEndpoint);
            this.startedByExtension = false;
            this.setStatus({ state: "running", url: existingEndpoint.baseUrl });
            this.harnessState.start();
            return existingEndpoint.baseUrl;
        }

        if (!workspaceRoot) {
            const message = t("Open a workspace before starting dsh with it as the working directory.");
            this.setStatus({ state: "error", message });
            throw new Error(message);
        }

        if (this.child && this.startedByExtension) {
            await this.stop();
            this.setStatus({ state: "starting", message: t("Starting dsh web...") });
        }

        let command = this.configuration().get<string>("command", "dsh").trim() || "dsh";
        const configuredArgs = this.configuration().get<string[]>("commandArgs", ["web", "--no-open"]);
        let args = [...configuredArgs];
        const enableCompaction = this.configuration().get<boolean>("enableCompaction", true);

        // Discovery may trigger a managed Runtime download. This deliberately
        // happens before the runtime start lock so one window can download or
        // reuse the cache while another window keeps using an installed runtime.
        let launcher: DshLauncher;
        try {
            launcher = await discoverDsh(command, {
                storagePath: this.storagePath,
                installWhenMissing: this.configuration().get<boolean>("installWhenMissing", true),
                runtimeVersion:
                    this.configuration().get<string>("runtimeVersion", RUNTIME_DEFAULT_VERSION) ||
                    RUNTIME_DEFAULT_VERSION,
                configuredArgs,
                allowManaged: true,
                proxy: this.httpProxy(),
                onLog: (message) => this.output.appendLine(message),
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.setStatus({ state: "error", message });
            throw error;
        }
        command = launcher.command;
        // The managed launcher is an absolute path to the standalone runtime
        // binary; package-manager commandArgs do not apply to it.
        const launchArgs = launcher.usesConfiguredArgs === false
            ? [...launcher.args]
            : [...launcher.args, ...(launcher.source.kind === "managed" ? ["web", "--no-open"] : [...configuredArgs])];
        // Every launcher path lands here — the manifest default, a user's own
        // commandArgs, the pnpm/npx conversion, and the discovery fallback — so
        // this is the one place the pin cannot be routed around.
        args = isPackageManagerSource(launcher.source) ? pinDshPackageArgs(launchArgs) : launchArgs;
        this.output.appendLine(`[dsh] discovered executable: ${command} (${describeSource(launcher.source)})`);

        if (!(await this.acquireRuntimeLock())) {
            const deadline = Date.now() + startupTimeout;
            while (Date.now() < deadline) {
                const endpoint = await this.findExistingRuntime(configuredPort);
                if (endpoint) {
                    this.setRuntimeEndpoint(endpoint);
                    this.startedByExtension = false;
                    this.setStatus({ state: "running", url: endpoint.baseUrl });
                    this.harnessState.start();
                    return endpoint.baseUrl;
                }
                await delay(250);
            }
            const message = t("Another dsh runtime is starting, but it did not become available.");
            this.setStatus({ state: "error", message });
            throw new Error(message);
        }
        if (enableCompaction && isWebProfileArgs(args)) {
            this.compactionPatchPath = join(tmpdir(), `dsh-vscode-${process.pid}-compaction.patch.yml`);
            try {
                await writeFile(
                    this.compactionPatchPath,
                    "- id: compaction-basic\n  disabled: false\n\n- id: command-compact\n  disabled: false\n",
                    { encoding: "utf8", mode: 0o600 },
                );
            } catch (error) {
                await this.releaseRuntimeLock();
                throw error;
            }
            insertWebLauncherPatch(args, this.compactionPatchPath);
            this.output.appendLine(`[dsh] compaction command enabled with patch: ${this.compactionPatchPath}`);
        }
        args = ensureNoOpen(args);

        if (!args.some((argument) => argument === "--port" || argument === "-p" || argument.startsWith("--port="))) {
            // Port 0 asks Harness/the OS for a free port. This preserves the
            // normal 3080 default for discovery while still working when it is
            // occupied by another service or Runtime.
            args.push("--port", String(configuredPort > 0 ? configuredPort : 0));
        }

        const configuredNpxTimeout = configuration.get<number>("npxTimeoutMs", DEFAULT_NPX_TIMEOUT_MS);
        const npxTimeoutMs = Number.isFinite(configuredNpxTimeout) && configuredNpxTimeout > 0
            ? configuredNpxTimeout
            : DEFAULT_NPX_TIMEOUT_MS;
        const packageManagerFetchTimeoutMs = Math.min(npxTimeoutMs, DEFAULT_PACKAGE_MANAGER_FETCH_TIMEOUT_MS);
        const configuredNpmRegistry = normalizeNpmRegistry(
            configuration.get<string>("npmRegistry", DEFAULT_NPM_REGISTRY),
        );
        const packageManager = isPackageManagerSource(launcher.source) ? launcher.source.kind : undefined;
        const hasExplicitRegistry = hasNpmRegistryArgument(args, packageManager);
        const activeRegistry = isPackageManagerSource(launcher.source) && !hasExplicitRegistry
            ? await activeNpmRegistry(workspaceRoot, launcher.source.kind)
            : undefined;
        const npmRegistry = hasExplicitRegistry
            ? undefined
            : alternateNpmRegistry(configuredNpmRegistry, activeRegistry);
        const readinessTimeout = isPackageManagerSource(launcher.source) ? npxTimeoutMs : startupTimeout;

        if (isPackageManagerSource(launcher.source)) {
            this.output.appendLine(
                `[dsh] ${launcher.source.kind} registry: ${activeRegistry ? redactUrl(activeRegistry) : "<npm default>"}; fallback: ${npmRegistry ? redactUrl(npmRegistry) : "<disabled>"}`,
            );
            this.output.appendLine(
                `[dsh] ${launcher.source.kind} fetch timeout: ${packageManagerFetchTimeoutMs} ms; retries: 0 unless overridden by command or environment`,
            );
        }

        const launchAttempt = async (attemptArgs: string[]): Promise<string> => {
            const candidatePort = portFromArgs(attemptArgs);
            this.baseUrl = candidatePort
                ? `http://127.0.0.1:${candidatePort}`
                : undefined;
            this.launchUrl = undefined;
            this.authCookie = undefined;
            this.authPromise = undefined;

            this.output.appendLine(`[dsh] starting: ${command} ${attemptArgs.join(" ")}`);
            const launchEnv: NodeJS.ProcessEnv = { ...process.env };
            if (isPackageManagerSource(launcher.source)) {
                if ((launcher.source.kind !== "npx" || !hasNpmOptionArgument(attemptArgs, "--fetch-timeout"))
                    && !launchEnv.npm_config_fetch_timeout
                    && !launchEnv.NPM_CONFIG_FETCH_TIMEOUT) {
                    launchEnv.npm_config_fetch_timeout = String(packageManagerFetchTimeoutMs);
                }
                if ((launcher.source.kind !== "npx" || !hasNpmOptionArgument(attemptArgs, "--fetch-retries"))
                    && !launchEnv.npm_config_fetch_retries
                    && !launchEnv.NPM_CONFIG_FETCH_RETRIES) {
                    launchEnv.npm_config_fetch_retries = "0";
                }
            }
            const child = spawn(command, attemptArgs, {
                cwd: workspaceRoot,
                env: launchEnv,
                // Windows batch and PowerShell launchers fail with EINVAL unless
                // executed through the shell; native executables do not need it.
                shell: launcherNeedsShell(command),
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
            });
            this.child = child;
            this.startedByExtension = true;

            let exited = false;
            let launchError: Error | undefined;
            let outputTail = "";
            const recordOutput = (chunk: Buffer, stream: string): void => {
                const text = chunk.toString("utf8");
                const safeText = redactRuntimeOutput(text);
                outputTail = `${outputTail}${safeText}`.slice(-8_000);
                this.output.append(`[dsh:${stream}] ${safeText}`);

                const discoveredEndpoint = extractRuntimeEndpoint(text);
                if (discoveredEndpoint && (
                    discoveredEndpoint.baseUrl !== this.baseUrl ||
                    discoveredEndpoint.launchUrl !== this.launchUrl
                )) {
                    this.setRuntimeEndpoint(discoveredEndpoint);
                    void this.publishRuntimeLockUrl(discoveredEndpoint).catch((error) => {
                        this.output.appendLine(`[dsh] failed to publish Runtime URL: ${String(error)}`);
                    });
                }
            };

            child.stdout?.on("data", (chunk: Buffer) => recordOutput(chunk, "out"));
            child.stderr?.on("data", (chunk: Buffer) => recordOutput(chunk, "err"));
            child.once("error", (error) => {
                launchError = error;
                exited = true;
            });
            child.once("close", (code, signal) => {
                exited = true;
                this.output.appendLine(`[dsh] exited: code=${code ?? "null"}, signal=${signal ?? "null"}`);
                if (this.child === child) {
                    this.child = undefined;
                }
            });

            const startedAt = Date.now();
            const heartbeat = isPackageManagerSource(launcher.source)
                ? setInterval(() => {
                    const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1_000);
                    const timeoutSeconds = Math.ceil(readinessTimeout / 1_000);
                    this.output.appendLine(
                        `[dsh] ${launcher.source.kind} is still downloading/starting (${elapsedSeconds}s/${timeoutSeconds}s timeout)`,
                    );
                }, 15_000)
                : undefined;
            try {
                const url = await this.waitForReady(
                    undefined,
                    readinessTimeout,
                    () => exited,
                    () => launchError,
                    () => outputTail,
                );
                this.baseUrl = url;
                try {
                    await this.publishRuntimeLockUrl({
                        baseUrl: url,
                        ...(this.launchUrl === undefined ? {} : { launchUrl: this.launchUrl }),
                    });
                } catch (error) {
                    this.output.appendLine(`[dsh] failed to publish Runtime URL: ${String(error)}`);
                }
                return url;
            } catch (error) {
                await this.terminate(child);
                this.child = undefined;
                this.baseUrl = undefined;
                this.launchUrl = undefined;
                this.authCookie = undefined;
                this.authPromise = undefined;
                this.startedByExtension = false;
                throw new RuntimeLaunchFailure(outputTail, error);
            } finally {
                if (heartbeat !== undefined) clearInterval(heartbeat);
            }
        };

        let url: string;
        try {
            try {
                url = await launchAttempt(args);
            } catch (error) {
                const registry = npmRegistry;
                if (!isPackageManagerSource(launcher.source) || registry === undefined) throw error;
                const mirrorArgs = withNpmRegistry(args, registry, launcher.source.kind);
                if (!mirrorArgs || !isLikelyNpmDownloadFailure(error, error instanceof RuntimeLaunchFailure ? error.outputTail : "")) {
                    throw error;
                }

                this.output.appendLine(
                    `[dsh] ${launcher.source.kind} download/start failed; retrying with npm registry ${redactUrl(registry)}`,
                );
                try {
                    url = await launchAttempt(mirrorArgs);
                } catch (retryError) {
                    const firstMessage = error instanceof Error ? error.message : String(error);
                    const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
                    throw new Error(
                        `${firstMessage}\n\n${t("Retrying with the alternate npm registry also failed.")}\n\n${retryMessage}`,
                    );
                }
            }
        } catch (error) {
            await this.releaseRuntimeLock();
            let message = error instanceof Error ? error.message : String(error);
            if (launcher.source.kind === "managed") {
                // Keep the freshly installed runtime in place for diagnosis.
                message = t("Managed Runtime {version} ({target}) failed to become ready.\n\n{message}", {
                    version: launcher.source.version,
                    target: launcher.source.target,
                    message,
                });
            }
            this.setStatus({ state: "error", message });
            throw new Error(message);
        }

        this.baseUrl = url;
        this.setStatus({ state: "running", url });
        this.harnessState.start();
        return url;
    }

    private async waitForReady(
        initialUrl: string | undefined,
        timeoutMs: number,
        hasExited?: () => boolean,
        getLaunchError?: () => Error | undefined,
        getOutputTail?: () => string,
    ): Promise<string> {
        const deadline = Date.now() + timeoutMs;
        let lastError = "";

        while (Date.now() < deadline) {
            if (hasExited?.()) {
                const launchError = getLaunchError?.();
                if (launchError) {
                    throw new Error(t("Failed to start dsh: {message}", { message: launchError.message }));
                }

                const tail = getOutputTail?.().trim();
                throw new Error(
                    t("dsh web exited before becoming ready.{output}", {
                        output: tail ? `\n\n${t("Last output:")}\n${tail}` : "",
                    }),
                );
            }

            const url = initialUrl ?? this.baseUrl;
            if (url && (await this.isHarnessHealthy(url, initialUrl !== undefined))) {
                return url;
            }

            if (url) {
                lastError = t("Unable to connect to {url}", { url });
            }
            await delay(250);
        }

        const tail = getOutputTail?.().trim();
        throw new Error(t("Timed out waiting for dsh web.{reason}{output}", {
            reason: lastError
                ? ` ${lastError}.`
                : ` ${t("No local service address was found in the process output.")}`,
            output: tail ? `\n\n${t("Last output:")}\n${tail}` : "",
        }));
    }

    private setRuntimeEndpoint(endpoint: RuntimeEndpoint): void {
        const previousBaseUrl = this.baseUrl;
        const previousLaunchUrl = this.launchUrl;
        const launchUrl = endpoint.launchUrl ?? (
            previousBaseUrl === endpoint.baseUrl ? previousLaunchUrl : undefined
        );
        this.baseUrl = endpoint.baseUrl;
        this.launchUrl = launchUrl;
        if (previousBaseUrl !== this.baseUrl || previousLaunchUrl !== this.launchUrl) {
            this.authCookie = undefined;
            this.authPromise = undefined;
        }
    }

    private requestHeaders(): Record<string, string> {
        return this.authCookie === undefined ? {} : { cookie: this.authCookie };
    }

    private clearRuntimeAuthentication(): void {
        this.authCookie = undefined;
        this.authPromise = undefined;
    }

    /** Exchange dsh web's launch token for its authority-bound session cookie. */
    private async ensureAuthenticated(signal?: AbortSignal): Promise<void> {
        const launchUrl = this.launchUrl;
        if (!launchUrl || this.authCookie !== undefined) return;
        if (this.authPromise) return this.authPromise;

        const exchange = async (): Promise<void> => {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 1_500);
            const relayAbort = (): void => controller.abort(signal?.reason);
            signal?.addEventListener("abort", relayAbort, { once: true });
            try {
                const response = await fetch(launchUrl, {
                    redirect: "manual",
                    headers: { accept: "text/plain" },
                    signal: controller.signal,
                });
                if (response.status === 303) {
                    const setCookie = response.headers.get("set-cookie");
                    const cookie = setCookie?.split(";", 1)[0]?.trim();
                    if (!cookie || !/^[^=;]+=[^;]*$/u.test(cookie)) {
                        throw new Error("dsh web authentication did not return a session cookie");
                    }
                    if (this.launchUrl === launchUrl) {
                        this.authCookie = cookie;
                    }
                    return;
                }
                // Pre-0.1.2 runtimes did not require authentication. Keep the
                // compatibility path so an existing local server still works.
                if (response.ok) return;
                throw new Error(`dsh web authentication returned HTTP ${response.status}`);
            } finally {
                clearTimeout(timeout);
                signal?.removeEventListener("abort", relayAbort);
            }
        };

        const promise = exchange();
        this.authPromise = promise;
        try {
            await promise;
        } finally {
            if (this.authPromise === promise) this.authPromise = undefined;
        }
    }

    private async isHealthy(url: string): Promise<boolean> {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 1_500);
        try {
            await this.ensureAuthenticated(controller.signal);
            const response = await fetch(url, {
                headers: this.requestHeaders(),
                signal: controller.signal,
            });
            return response.ok;
        } catch {
            return false;
        } finally {
            clearTimeout(timeout);
        }
    }

    private async findExistingRuntime(configuredPort: number): Promise<RuntimeEndpoint | undefined> {
        const advertisedEndpoint = await this.readRuntimeEndpoint();
        if (advertisedEndpoint) {
            this.setRuntimeEndpoint(advertisedEndpoint);
            if (await this.isHarnessHealthy(advertisedEndpoint.baseUrl)) {
                return advertisedEndpoint;
            }
            this.clearRuntimeAuthentication();
        }
        const ports = (configuredPort > 0 ? [configuredPort, 3080] : [3080]).filter(
            (port, index, all): port is number => Number.isInteger(port) && port > 0 && all.indexOf(port) === index,
        );
        for (const port of ports) {
            const url = `http://127.0.0.1:${port}`;
            // A different port is a different origin. Restore the advertised
            // endpoint only for its own port; never reuse its Cookie elsewhere.
            const endpoint = advertisedEndpoint?.baseUrl === url
                ? advertisedEndpoint
                : { baseUrl: url };
            this.setRuntimeEndpoint(endpoint);
            if (await this.isHarnessHealthy(url)) return endpoint;
            this.clearRuntimeAuthentication();
        }
        // Probing writes the candidate endpoint so ensureAuthenticated can read
        // its launch token. None of them answered, so drop it again: getUrl() is
        // how the rest of the extension decides a Runtime is live, and a caller
        // that throws after this point would otherwise keep advertising a dead
        // port instead of its own startup failure.
        this.baseUrl = undefined;
        this.launchUrl = undefined;
        this.clearRuntimeAuthentication();
        return undefined;
    }

    private async isHarnessHealthy(url: string, failFast = false): Promise<boolean> {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 1_500);
        const rpcId = `dsh-remote-probe-${process.pid}-${randomUUID()}`;
        try {
            try {
                await this.ensureAuthenticated(controller.signal);
            } catch (error) {
                if (failFast && error instanceof Error && /HTTP 401\b/u.test(error.message)) {
                    throw new RemoteHttpError("session/list", 401);
                }
                if (failFast && error instanceof Error && /HTTP 403\b/u.test(error.message)) {
                    throw new RemoteHttpError("session/list", 403);
                }
                if (failFast) throw error;
                return false;
            }
            const response = await fetch(remoteEndpointUrl(url, "session/list"), {
                method: "POST",
                headers: {
                    ...this.requestHeaders(),
                    "content-type": "application/json",
                },
                body: JSON.stringify({
                    type: "client-request",
                    rpcId,
                    method: "session/list",
                    // RC's session.list descriptor names this reserved
                    // parameter `_request` (the DTO is intentionally empty).
                    payload: { args: { _request: {} } },
                }),
                signal: controller.signal,
            });
            if (!response.ok) {
                if (failFast && (response.status === 401 || response.status === 403)) {
                    throw new RemoteHttpError("session/list", response.status);
                }
                if (failFast && response.status === 404) {
                    throw new RemoteProtocolError(
                        t("Configured dsh Runtime does not expose RC Remote RPC (HTTP 404). Upgrade dsh to 0.1.2-rc.1."),
                    );
                }
                return false;
            }
            let body: unknown;
            try {
                body = await response.json();
            } catch (error) {
                if (failFast) {
                    throw new RemoteProtocolError(
                        t("Configured dsh Runtime returned invalid JSON from its RPC endpoint."),
                        { cause: error },
                    );
                }
                return false;
            }
            let envelope;
            try {
                envelope = parseRemoteServerResponse(body);
            } catch (error) {
                if (failFast) {
                    throw new RemoteProtocolError(
                        t("Configured dsh Runtime returned an incompatible RPC response."),
                        { cause: error },
                    );
                }
                return false;
            }
            // A structurally valid Remote failure is still proof that the
            // target speaks RC Remote v1; capability/domain failure is handled
            // by the actual facade call, not misclassified as an old protocol.
            if (envelope.rpcId !== rpcId) {
                if (failFast) {
                    throw new RemoteProtocolError(t("Configured dsh Runtime returned a mismatched RPC id."));
                }
                return false;
            }
            return true;
        } catch (error) {
            if (!failFast) return false;
            if (error instanceof RemoteHttpError || error instanceof RemoteProtocolError) throw error;
            // A transport failure can mean that the Runtime is still starting;
            // let waitForReady retry until its startup deadline. Protocol-level
            // failures above remain fail-fast so incompatible endpoints surface
            // immediately.
            return false;
        } finally {
            clearTimeout(timeout);
        }
    }

    private async acquireRuntimeLock(): Promise<boolean> {
        // A peer on the pre-rename lock cannot see ours, so check its file
        // first: deferring to a live legacy owner is what keeps the transition
        // from spawning two Runtimes.
        if (await this.legacyRuntimeLockOwnerAlive()) return false;
        const path = join(tmpdir(), RUNTIME_LOCK_FILE);
        try {
            const handle = await open(path, "wx", 0o600);
            const createdAt = Date.now();
            await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt }), "utf8");
            this.runtimeLock = { handle, path, createdAt };
            return true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            try {
                const contents = await readFile(path, "utf8");
                const pid = Number((JSON.parse(contents) as { pid?: unknown }).pid);
                if (Number.isInteger(pid) && pid > 0) {
                    try {
                        process.kill(pid, 0);
                        return false;
                    } catch (probeError) {
                        if ((probeError as NodeJS.ErrnoException).code !== "ESRCH") return false;
                    }
                }
                await unlink(path);
                return this.acquireRuntimeLock();
            } catch (staleError) {
                if ((staleError as NodeJS.ErrnoException).code === "ENOENT") return this.acquireRuntimeLock();
                return false;
            }
        }
    }

    private async readRuntimeEndpoint(): Promise<RuntimeEndpoint | undefined> {
        // The shared lock wins; the legacy one still answers for a peer that
        // has not updated yet.
        for (const name of [RUNTIME_LOCK_FILE, LEGACY_RUNTIME_LOCK_FILE]) {
            const endpoint = await readLockRecord(join(tmpdir(), name));
            if (endpoint) return endpoint;
        }
        return undefined;
    }

    /**
     * Whether a pre-rename peer is holding its own lock right now. A lock with
     * no readable live pid is stale and does not block us.
     */
    private async legacyRuntimeLockOwnerAlive(): Promise<boolean> {
        try {
            const contents = await readFile(join(tmpdir(), LEGACY_RUNTIME_LOCK_FILE), "utf8");
            const pid = Number((JSON.parse(contents) as { pid?: unknown }).pid);
            if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
            try {
                process.kill(pid, 0);
                return true;
            } catch (probeError) {
                return (probeError as NodeJS.ErrnoException).code !== "ESRCH";
            }
        } catch {
            return false;
        }
    }

    private publishRuntimeLockUrl(endpoint: RuntimeEndpoint): Promise<void> {
        const lock = this.runtimeLock;
        const advertisedUrl = loopbackRuntimeUrl(endpoint.baseUrl);
        if (!lock || !advertisedUrl) return Promise.resolve();
        const launchUrl = endpoint.launchUrl === undefined
            ? undefined
            : parseRuntimeEndpoint(endpoint.launchUrl, true)?.launchUrl;

        const write = this.runtimeLockWrite
            .catch(() => undefined)
            .then(async () => {
                if (this.runtimeLock !== lock) return;
                const contents = JSON.stringify({
                    pid: process.pid,
                    createdAt: lock.createdAt,
                    url: advertisedUrl,
                    ...(launchUrl === undefined ? {} : { launchUrl }),
                });
                await lock.handle.truncate(0);
                await lock.handle.write(contents, 0, "utf8");
                await lock.handle.sync();
            });
        this.runtimeLockWrite = write;
        return write;
    }

    private async releaseRuntimeLock(): Promise<void> {
        const lock = this.runtimeLock;
        this.runtimeLock = undefined;
        if (!lock) return;
        try {
            await this.runtimeLockWrite.catch(() => undefined);
            await lock.handle.close();
        } finally {
            await unlink(lock.path).catch(() => undefined);
        }
    }

    private async terminate(child: ChildProcess): Promise<void> {
        if (child.exitCode !== null || child.signalCode !== null) {
            return;
        }

        await new Promise<void>((resolve) => {
            let settled = false;
            const finish = (): void => {
                if (settled) {
                    return;
                }
                settled = true;
                resolve();
            };

            child.once("close", finish);
            child.kill("SIGTERM");
            setTimeout(() => {
                if (!settled) {
                    child.kill("SIGKILL");
                    finish();
                }
            }, 2_000);
        });
    }

    private configuration(): vscode.WorkspaceConfiguration {
        return vscode.workspace.getConfiguration("dsh");
    }

    /** Read the VS Code http.proxy setting so downloads honor it like curl. */
    private httpProxy(): string | undefined {
        const value = vscode.workspace.getConfiguration("http").get<string>("proxy", "");
        return value.trim() || undefined;
    }

    private setStatus(status: RuntimeStatus): void {
        this.status = status;
        for (const listener of this.listeners) {
            listener({ ...status });
        }
    }
}
