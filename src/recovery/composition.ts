import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, normalize, resolve } from "node:path";
import type {
    BundleDescriptor,
    CompositionDescriptor,
    EnvironmentSurface,
    FileFingerprint,
    PatchLayerDescriptor,
    RuntimeBinaryDescriptor,
} from "./types";

const SECRET_NAME = /(?:api[-_]?key|auth|credential|password|secret|token|cookie|private[-_]?key)/iu;
const SECRET_FILE = /(?:^|[\\/])(?:\.env(?:\.[^\\/]+)?|\.credentials(?:\.[^\\/]+)?|.*secret.*)$/iu;
const MAX_HASHED_FILE_BYTES = 2 * 1024 * 1024;

function sha256(value: string | Uint8Array): string {
    return createHash("sha256").update(value).digest("hex");
}

function stableValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stableValue);
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, child]) => [key, stableValue(child)]),
        );
    }
    return value;
}

function normalizedPath(path: string): string {
    const normalized = normalize(resolve(path)).replace(/\\/gu, "/");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function secretPath(path: string): boolean {
    return SECRET_FILE.test(path) || SECRET_NAME.test(basename(path));
}

function safeEnvironment(): EnvironmentSurface {
    const entries = Object.entries(process.env);
    const inheritedNames = entries.map(([name]) => name).sort();
    const presentSensitiveNames = entries
        .filter(([name]) => SECRET_NAME.test(name))
        .map(([name]) => name)
        .sort();
    const safeValues = entries
        .filter(([name]) => !SECRET_NAME.test(name))
        .map(([name, value]) => [name, value ?? ""])
        .sort(([left], [right]) => left.localeCompare(right));
    const stableValuesHash = sha256(JSON.stringify(safeValues));
    return {
        cwd: normalizedPath(process.cwd()),
        dshHome: normalizedPath(process.env.DSH_HOME || join(homedir(), ".dsh")),
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.versions.node,
        inheritedNames,
        presentSensitiveNames,
        stableValuesHash,
    };
}

async function fingerprintPath(path: string): Promise<FileFingerprint> {
    const normalized = normalizedPath(path);
    try {
        const stat = await lstat(path);
        if (stat.isSymbolicLink()) {
            return { path: normalized, kind: "link", mtimeMs: stat.mtimeMs };
        }
        if (stat.isDirectory()) {
            return { path: normalized, kind: "directory", mtimeMs: stat.mtimeMs };
        }
        if (!stat.isFile()) return { path: normalized, kind: "missing" };
        if (secretPath(path)) {
            return {
                path: normalized,
                kind: "file",
                size: stat.size,
                mtimeMs: stat.mtimeMs,
                secret: true,
                contentHash: sha256(`secret-present:${stat.size}:${stat.mtimeMs}`),
            };
        }
        if (stat.size > MAX_HASHED_FILE_BYTES) {
            return { path: normalized, kind: "file", size: stat.size, mtimeMs: stat.mtimeMs };
        }
        const contents = await readFile(path);
        return {
            path: normalized,
            kind: "file",
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            contentHash: sha256(contents),
        };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return { path: normalized, kind: "missing" };
        }
        throw error;
    }
}

function profileFromArgs(args: readonly string[]): string {
    const inline = args.find((argument) => argument.startsWith("--profile="));
    if (inline) return inline.slice("--profile=".length) || "default";
    const index = args.findIndex((argument) => argument === "--profile");
    if (index >= 0 && args[index + 1]) return args[index + 1] as string;
    if (args.includes("web")) return "web";
    return "default";
}

export function patchPathsFromArgs(args: readonly string[]): string[] {
    const paths: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === "--patch" && args[index + 1]) {
            paths.push(args[index + 1] as string);
            index += 1;
        } else if (argument.startsWith("--patch=")) {
            paths.push(argument.slice("--patch=".length));
        }
    }
    return paths;
}

function parsePatchLayer(path: string, order: number, extensionOverlayPaths: readonly string[], recoveryOverlayPaths: readonly string[]): PatchLayerDescriptor {
    const normalized = normalizedPath(path);
    const kind = recoveryOverlayPaths.some((candidate) => normalizedPath(candidate) === normalized)
        ? "recovery-overlay"
        : extensionOverlayPaths.some((candidate) => normalizedPath(candidate) === normalized)
            ? "extension-overlay"
            : "unknown";
    return {
        kind,
        path: normalized,
        order,
        sourceLabel: basename(path),
    };
}

async function readPackageJson(path: string): Promise<Record<string, unknown> | undefined> {
    try {
        const value: unknown = JSON.parse(await readFile(path, "utf8"));
        return value && typeof value === "object" && !Array.isArray(value)
            ? value as Record<string, unknown>
            : undefined;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        return undefined;
    }
}

async function resolveBundle(
    packageName: string,
    profileDir: string,
): Promise<BundleDescriptor> {
    const packageDir = join(profileDir, "node_modules", packageName);
    const packageJsonPath = join(packageDir, "package.json");
    const packageJson = await readPackageJson(packageJsonPath);
    const packageHash = packageJson ? sha256(JSON.stringify(stableValue(packageJson))) : undefined;
    const dsh = packageJson?.dsh;
    const bundle = dsh && typeof dsh === "object" && !Array.isArray(dsh)
        ? (dsh as Record<string, unknown>).bundle
        : undefined;
    const patchValue = bundle && typeof bundle === "object" && !Array.isArray(bundle)
        ? (bundle as Record<string, unknown>).patch
        : undefined;
    const patchPath = typeof patchValue === "string"
        ? resolve(packageDir, patchValue)
        : undefined;
    const patchFingerprint = patchPath ? await fingerprintPath(patchPath) : undefined;
    return {
        packageName,
        packageDir: (await fingerprintPath(packageDir)).kind === "missing" ? undefined : normalizedPath(packageDir),
        manifestPath: normalizedPath(packageJsonPath),
        patchPath: patchPath && patchFingerprint?.kind !== "missing" ? normalizedPath(patchPath) : undefined,
        origin: (await fingerprintPath(packageDir)).kind === "missing"
            ? "unknown"
            : "profile-dependency",
        selected: true,
        packageHash,
        patchHash: patchFingerprint?.contentHash,
    };
}

async function readBundles(manifestPath: string | undefined, profileDir: string): Promise<BundleDescriptor[]> {
    if (!manifestPath) return [];
    const packageJson = await readPackageJson(manifestPath);
    const dsh = packageJson?.dsh;
    const profile = dsh && typeof dsh === "object" && !Array.isArray(dsh)
        ? (dsh as Record<string, unknown>).profile
        : undefined;
    const bundles = profile && typeof profile === "object" && !Array.isArray(profile)
        ? (profile as Record<string, unknown>).bundles
        : undefined;
    if (!Array.isArray(bundles)) return [];
    const result: BundleDescriptor[] = [];
    for (const value of bundles) {
        if (typeof value !== "string" || !value.trim()) continue;
        result.push(await resolveBundle(value.trim(), profileDir));
    }
    return result;
}

function hashableComposition(composition: Omit<CompositionDescriptor, "compositionHash">): unknown {
    return stableValue({
        schemaVersion: composition.schemaVersion,
        profile: composition.profile,
        profileManifestPath: composition.profileManifestPath,
        profilePackageHash: composition.profilePackageHash,
        binary: composition.binary,
        appArgs: normalizeArgsForHash(composition.appArgs),
        patchLayers: composition.patchLayers,
        bundles: composition.bundles,
        profileFiles: composition.profileFiles,
        homeFiles: composition.homeFiles,
        environment: {
            ...composition.environment,
            cwd: normalizedPath(composition.environment.cwd),
            dshHome: normalizedPath(composition.environment.dshHome),
        },
        extensionOverlayPaths: composition.extensionOverlayPaths.map(normalizedPath).sort(),
        recoveryOverlayPaths: composition.recoveryOverlayPaths.map(normalizedPath).sort(),
    });
}

function normalizeArgsForHash(args: readonly string[]): string[] {
    const result = [...args];
    for (let index = 0; index < result.length; index += 1) {
        if ((result[index] === "--port" || result[index] === "-p") && result[index + 1] === "0") {
            result[index + 1] = "<dynamic-port>";
        } else if (result[index]?.startsWith("--port=0")) {
            result[index] = "--port=<dynamic-port>";
        }
    }
    return result;
}

export function recomputeComposition(
    composition: CompositionDescriptor,
    changes: Partial<Omit<CompositionDescriptor, "compositionHash" | "schemaVersion">>,
): CompositionDescriptor {
    const next: Omit<CompositionDescriptor, "compositionHash"> = {
        ...composition,
        ...changes,
        schemaVersion: 1,
    };
    return {
        ...next,
        compositionHash: sha256(JSON.stringify(hashableComposition(next))),
    };
}

export interface CompositionInput {
    command: string;
    resolvedPath?: string;
    source: string;
    version?: string;
    launcherArgs: readonly string[];
    appArgs: readonly string[];
    workspaceRoot: string;
    dshHome?: string;
    profile?: string;
    extensionOverlayPaths?: readonly string[];
    recoveryOverlayPaths?: readonly string[];
    profileManifestPath?: string;
}

export async function buildComposition(input: CompositionInput): Promise<CompositionDescriptor> {
    const dshHome = resolve(input.dshHome || process.env.DSH_HOME || join(homedir(), ".dsh"));
    const profile = input.profile || profileFromArgs(input.appArgs);
    const profileDir = join(dshHome, "profiles", profile);
    const profileManifestPath = input.profileManifestPath || join(profileDir, "package.json");
    const patchPaths = patchPathsFromArgs(input.appArgs);
    const extensionOverlayPaths = [...(input.extensionOverlayPaths ?? [])].map(normalizedPath);
    const recoveryOverlayPaths = [...(input.recoveryOverlayPaths ?? [])].map(normalizedPath);
    const patchLayers: PatchLayerDescriptor[] = [];
    for (const [index, path] of patchPaths.entries()) {
        const layer = parsePatchLayer(path, index, extensionOverlayPaths, recoveryOverlayPaths);
        const fingerprint = await fingerprintPath(path);
        patchLayers.push({
            ...layer,
            contentHash: fingerprint.contentHash,
        });
    }
    const profileManifest = await fingerprintPath(profileManifestPath);
    const profileFiles = [
        profileManifest,
        await fingerprintPath(join(profileDir, "cordis.patch.yml")),
    ].filter((item) => item.kind !== "missing");
    const homeFiles = [
        await fingerprintPath(join(dshHome, "cordis.patch.yml")),
    ].filter((item) => item.kind !== "missing");
    const environment = {
        ...safeEnvironment(),
        cwd: normalizedPath(input.workspaceRoot),
        dshHome: normalizedPath(dshHome),
    };
    const binary: RuntimeBinaryDescriptor = {
        command: input.command,
        ...(input.resolvedPath === undefined ? {} : { resolvedPath: normalizedPath(input.resolvedPath) }),
        source: input.source,
        ...(input.version === undefined ? {} : { version: input.version }),
        launcherArgs: [...input.launcherArgs],
    };
    const composition = {
        schemaVersion: 1 as const,
        profile,
        ...(await fingerprintPath(profileManifestPath)).kind === "missing"
            ? {}
            : { profileManifestPath: normalizedPath(profileManifestPath) },
        ...(profileManifest.contentHash === undefined ? {} : { profilePackageHash: profileManifest.contentHash }),
        ...(profileManifest.mtimeMs === undefined ? {} : { profilePackageMtimeMs: profileManifest.mtimeMs }),
        binary,
        appArgs: [...input.appArgs],
        patchLayers,
        bundles: await readBundles(
            profileManifest.kind === "missing" ? undefined : profileManifestPath,
            profileDir,
        ),
        profileFiles,
        homeFiles,
        environment,
        extensionOverlayPaths,
        recoveryOverlayPaths,
    };
    return {
        ...composition,
        compositionHash: sha256(JSON.stringify(hashableComposition(composition))),
    };
}

export function compositionDiff(
    current: CompositionDescriptor | undefined,
    lastKnownGood: CompositionDescriptor | undefined,
): Record<string, unknown> {
    if (!current || !lastKnownGood) {
        return {
            currentHash: current?.compositionHash,
            lastKnownGoodHash: lastKnownGood?.compositionHash,
        };
    }
    return {
        currentHash: current.compositionHash,
        lastKnownGoodHash: lastKnownGood.compositionHash,
        profile: current.profile === lastKnownGood.profile ? undefined : [lastKnownGood.profile, current.profile],
        appArgs: JSON.stringify(current.appArgs) === JSON.stringify(lastKnownGood.appArgs)
            ? undefined
            : { before: lastKnownGood.appArgs, after: current.appArgs },
        patchLayers: JSON.stringify(current.patchLayers) === JSON.stringify(lastKnownGood.patchLayers)
            ? undefined
            : { before: lastKnownGood.patchLayers, after: current.patchLayers },
        bundles: JSON.stringify(current.bundles) === JSON.stringify(lastKnownGood.bundles)
            ? undefined
            : { before: lastKnownGood.bundles, after: current.bundles },
        environment: current.environment.stableValuesHash === lastKnownGood.environment.stableValuesHash
            ? undefined
            : { before: lastKnownGood.environment.stableValuesHash, after: current.environment.stableValuesHash },
    };
}

export function profileNameFromArgs(args: readonly string[]): string {
    return profileFromArgs(args);
}
