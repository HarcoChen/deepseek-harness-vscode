import { cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { profileNameFromArgs } from "./composition";
import type {
    CompositionDescriptor,
    CompositionVariant,
    RecoveryLaunchSpec,
} from "./types";

const SENSITIVE_ENV_NAME = /(?:api[-_]?key|auth|credential|password|secret|token|cookie|private[-_]?key)/iu;

export class SandboxBuildError extends Error {
    public constructor(message: string, options?: { cause?: unknown }) {
        super(message);
        this.name = "SandboxBuildError";
        if (options?.cause !== undefined) this.cause = options.cause;
    }
}

export interface RecoverySandbox {
    root: string;
    dshHome: string;
    workspace: string;
    launch: RecoveryLaunchSpec;
    cleanup(): Promise<{ removed: boolean; secretFilesRemoved: boolean; deferredCleanup?: boolean }>;
}

function normalized(path: string): string {
    const normalized = resolve(path).replace(/\\/gu, "/");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function hasArgument(args: readonly string[], name: string): boolean {
    return args.some((argument) => argument === name || argument.startsWith(`${name}=`));
}

function materializedPortArgs(args: readonly string[]): string[] {
    const result: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === "--port" || argument === "-p") {
            index += 1;
            continue;
        }
        if (argument.startsWith("--port=")) continue;
        result.push(argument);
    }
    if (!hasArgument(result, "--host")) result.push("--host", "127.0.0.1");
    result.push("--port", "0");
    if (!result.includes("--no-open")) result.push("--no-open");
    return result;
}

function patchArgs(
    args: readonly string[],
    patchMap: ReadonlyMap<string, string>,
    allowedPaths: ReadonlySet<string>,
): string[] {
    const result: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        let source: string | undefined;
        let inline = false;
        if (argument === "--patch") {
            source = args[index + 1];
            index += 1;
        } else if (argument.startsWith("--patch=")) {
            source = argument.slice("--patch=".length);
            inline = true;
        }
        if (source !== undefined) {
            const key = normalized(source);
            if (!allowedPaths.has(key)) continue;
            const mapped = patchMap.get(key);
            if (!mapped) throw new SandboxBuildError(`Patch layer was not materialized: ${source}`);
            if (inline) result.push(`--patch=${mapped}`);
            else result.push("--patch", mapped);
            continue;
        }
        result.push(argument);
    }
    return materializedPortArgs(result);
}

async function exists(path: string): Promise<boolean> {
    try {
        await lstat(path);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
}

async function copyIfPresent(source: string, target: string): Promise<boolean> {
    if (!await exists(source)) return false;
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, { recursive: true, force: true });
    return true;
}

async function linkOrCopy(source: string, target: string): Promise<void> {
    await mkdir(dirname(target), { recursive: true });
    try {
        await symlink(source, target, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
        // A locked-down Windows machine may reject junction creation. Copy only
        // the selected package, never the whole node_modules parent.
        try {
            await cp(source, target, { recursive: true, force: true });
        } catch (copyError) {
            throw new SandboxBuildError(`Unable to project bundle ${source}`, { cause: copyError ?? error });
        }
    }
}

async function rewriteProfileManifest(
    source: string,
    target: string,
    variant: CompositionVariant,
): Promise<void> {
    let value: Record<string, unknown> = {};
    if (await exists(source)) {
        try {
            const parsed: unknown = JSON.parse(await readFile(source, "utf8"));
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                value = parsed as Record<string, unknown>;
            }
        } catch (error) {
            throw new SandboxBuildError(`Unable to parse profile manifest ${source}`, { cause: error });
        }
    }
    if (variant.bundleSelection !== undefined) {
        const currentDsh = value.dsh && typeof value.dsh === "object" && !Array.isArray(value.dsh)
            ? value.dsh as Record<string, unknown>
            : {};
        const currentProfile = currentDsh.profile && typeof currentDsh.profile === "object" &&
            !Array.isArray(currentDsh.profile)
            ? currentDsh.profile as Record<string, unknown>
            : {};
        value.dsh = {
            ...currentDsh,
            profile: {
                ...currentProfile,
                bundles: [...variant.bundleSelection],
            },
        };
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export class SandboxManager {
    public constructor(private readonly parentDirectory = tmpdir()) {}

    public async create(
        composition: CompositionDescriptor,
        variant: CompositionVariant,
    ): Promise<RecoverySandbox> {
        const root = await mkdtemp(join(this.parentDirectory, "dsh-recovery-"));
        const dshHome = join(root, "home");
        const temp = join(root, "tmp");
        const workspace = join(root, "workspace");
        const profile = variant.composition.profile || profileNameFromArgs(composition.appArgs);
        const profileDir = join(dshHome, "profiles", profile);
        try {
            await mkdir(workspace, { recursive: true });
            await mkdir(temp, { recursive: true });
            await mkdir(profileDir, { recursive: true });

            const sourceHome = composition.environment.dshHome || process.env.DSH_HOME || join(homedir(), ".dsh");
            const sourceProfile = join(sourceHome, "profiles", profile);
            const sourceManifest = composition.profileManifestPath || join(sourceProfile, "package.json");
            await rewriteProfileManifest(sourceManifest, join(profileDir, "package.json"), variant);
            await copyIfPresent(join(sourceProfile, "cordis.patch.yml"), join(profileDir, "cordis.patch.yml"));
            await copyIfPresent(join(sourceHome, "cordis.patch.yml"), join(dshHome, "cordis.patch.yml"));

            const patchMap = new Map<string, string>();
            for (const [index, layer] of variant.composition.patchLayers.entries()) {
                const source = layer.path;
                const target = join(root, "patches", `${String(index).padStart(3, "0")}-${basename(source)}`);
                if (!await copyIfPresent(source, target)) {
                    throw new SandboxBuildError(`Patch layer does not exist: ${source}`);
                }
                patchMap.set(normalized(source), target);
            }

            const selectedBundles = variant.composition.bundles.filter((bundle) => bundle.selected);
            for (const bundle of selectedBundles) {
                if (!bundle.packageDir) {
                    throw new SandboxBuildError(`Bundle directory is unavailable: ${bundle.packageName}`);
                }
                const target = join(profileDir, "node_modules", bundle.packageName);
                await linkOrCopy(bundle.packageDir, target);
            }

            const allowedPaths = new Set(variant.composition.patchLayers.map((layer) => normalized(layer.path)));
            const env: NodeJS.ProcessEnv = {};
            for (const [name, value] of Object.entries(process.env)) {
                if (!SENSITIVE_ENV_NAME.test(name)) env[name] = value;
            }
            Object.assign(env, {
                DSH_HOME: dshHome,
                TMPDIR: temp,
                TMP: temp,
                TEMP: temp,
                HOME: dshHome,
                ...(process.platform === "win32" ? { USERPROFILE: dshHome } : {}),
            });
            const launch: RecoveryLaunchSpec = {
                command: composition.binary.command,
                args: patchArgs(composition.appArgs, patchMap, allowedPaths),
                cwd: workspace,
                env,
                source: composition.binary.source,
            };
            return {
                root,
                dshHome,
                workspace,
                launch,
                cleanup: async () => {
                    let secretFilesRemoved = true;
                    for (const path of [
                        join(dshHome, ".env"),
                        join(dshHome, ".credentials.yaml"),
                        join(profileDir, ".env"),
                        join(profileDir, ".credentials.yaml"),
                    ]) {
                        try {
                            await rm(path, { force: true });
                        } catch {
                            secretFilesRemoved = false;
                        }
                    }
                    try {
                        await rm(root, { recursive: true, force: true });
                        return { removed: true, secretFilesRemoved };
                    } catch {
                        return { removed: false, secretFilesRemoved, deferredCleanup: true };
                    }
                },
            };
        } catch (error) {
            try {
                await rm(root, { recursive: true, force: true });
            } catch {
                // The caller records the build failure; never mask it with cleanup.
            }
            if (error instanceof SandboxBuildError) throw error;
            throw new SandboxBuildError(`Unable to build recovery sandbox ${root}`, { cause: error });
        }
    }
}
