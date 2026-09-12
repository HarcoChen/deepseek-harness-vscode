import { createHash } from "node:crypto";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { atomicWrite, RecoveryLedgerStore } from "./ledger";
import { recomputeComposition } from "./composition";
import type { CandidateFix, CompositionDescriptor, RecoveryLedgerEntry } from "./types";

function sha256(value: string | Uint8Array): string {
    return createHash("sha256").update(value).digest("hex");
}

function samePath(left: string, right: string): boolean {
    return pathKey(left) === pathKey(right);
}

function pathKey(path: string): string {
    const resolved = resolve(path);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export class FixConflictError extends Error {
    /** Entries that were already reverted before this conflict was detected. */
    public readonly restored: readonly string[];

    public constructor(message: string, restored: readonly string[] = []) {
        super(message);
        this.name = "FixConflictError";
        this.restored = restored;
    }
}

interface Backup {
    schemaVersion: 1;
    fixId: string;
    target: string;
    beforeHash: string;
    afterHash: string;
    original: string;
}

export class FixExecutor {
    private readonly backupsDirectory: string;

    public constructor(
        private readonly ledger: RecoveryLedgerStore,
        private readonly output?: { appendLine(message: string): void },
    ) {
        this.backupsDirectory = join(ledger.directory, "backups");
    }

    public async filterLaunchArgs(args: readonly string[]): Promise<string[]> {
        const entries = await this.ledger.readEntries();
        const removed = new Set(entries
            .filter(entry => entry.status === "applied" || entry.status === "verified")
            .flatMap(entry => entry.fix.removedPatchPaths ?? [])
            .map(pathKey));
        if (!removed.size) return [...args];
        const result: string[] = [];
        for (let index = 0; index < args.length; index += 1) {
            const argument = args[index];
            if (argument === "--patch" && args[index + 1]) {
                const path = pathKey(args[index + 1] as string);
                if (!removed.has(path)) result.push(argument, args[index + 1] as string);
                index += 1;
            } else if (!argument.startsWith("--patch=") ||
                !removed.has(pathKey(argument.slice("--patch=".length)))) {
                result.push(argument);
            }
        }
        return result;
    }

    public async apply(
        fix: CandidateFix,
        composition: CompositionDescriptor,
    ): Promise<CompositionDescriptor> {
        await this.ledger.assertLease();
        if (fix.kind === "remove-extension-overlay") {
            return recomputeComposition(composition, {
                patchLayers: composition.patchLayers.filter(layer =>
                    !(fix.removedPatchPaths ?? []).some(path => samePath(path, layer.path))),
                extensionOverlayPaths: composition.extensionOverlayPaths.filter(path =>
                    !(fix.removedPatchPaths ?? []).some(candidate => samePath(candidate, path))),
            });
        }

        const manifestPath = fix.profileManifestPath;
        if (!manifestPath) throw new FixConflictError("Recovery bundle fix has no profile manifest");
        const original = await readFile(manifestPath, "utf8");
        const beforeHash = sha256(original);
        if (fix.expectedProfileManifestHash && beforeHash !== fix.expectedProfileManifestHash) {
            throw new FixConflictError(`Profile manifest changed before recovery: ${manifestPath}`);
        }
        let parsed: Record<string, unknown>;
        try {
            const value: unknown = JSON.parse(original);
            if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("root is not an object");
            parsed = value as Record<string, unknown>;
        } catch (error) {
            throw new FixConflictError(`Profile manifest is invalid JSON: ${String(error)}`);
        }
        const dsh = isRecord(parsed.dsh) ? parsed.dsh : {};
        const profile = isRecord(dsh.profile) ? dsh.profile : {};
        const bundles = profile.bundles;
        if (!Array.isArray(bundles) || !bundles.every(item => typeof item === "string")) {
            throw new FixConflictError("Profile manifest has no valid dsh.profile.bundles");
        }
        const removed = new Set(fix.targetIds);
        const nextBundles = bundles.filter((item): item is string => !removed.has(item));
        if (nextBundles.length === bundles.length) {
            throw new FixConflictError("Recovery bundle is no longer present");
        }
        const nextContents = `${JSON.stringify({
            ...parsed,
            dsh: { ...dsh, profile: { ...profile, bundles: nextBundles } },
        }, null, 2)}\n`;
        const afterHash = sha256(nextContents);
        await mkdir(this.backupsDirectory, { recursive: true });
        const backup: Backup = {
            schemaVersion: 1, fixId: fix.id, target: manifestPath,
            beforeHash, afterHash, original,
        };
        await atomicWrite(join(this.backupsDirectory, `${fix.id}.json`), `${JSON.stringify(backup, null, 2)}\n`);
        await atomicWrite(manifestPath, nextContents);
        this.output?.appendLine(`[dsh:recovery] applied ${fix.id} to ${manifestPath}`);
        return recomputeComposition(composition, {
            bundles: composition.bundles.map(bundle => ({
                ...bundle, selected: !removed.has(bundle.packageName),
            })),
            profilePackageHash: afterHash,
        });
    }

    public async restore(): Promise<string[]> {
        await this.ledger.acquireLease();
        try {
            const entries = (await this.ledger.readEntries()).filter(entry =>
                entry.status === "applied" || entry.status === "verified");
            const restored: string[] = [];
            const conflicts: string[] = [];
            for (const entry of [...entries].reverse()) {
                if (entry.fix.kind === "remove-extension-overlay") {
                    await this.ledger.restoreEntry(entry.id);
                    restored.push(entry.id);
                    continue;
                }
                // The whole revert is the per-entry attempt, not just the backup read: every
                // step after this point touches the user's file (read the target, check it is a
                // regular file, write it back, record the ledger transition). If any of them
                // throws — a deleted/renamed manifest, a backup that cannot be read, a target
                // replaced by a symlink — the entry must still be recorded as conflicted and the
                // remaining entries must still be attempted. Letting a throw escape would strand
                // every earlier entry as "applied" with no record of why, and would hide the
                // entries that were already reverted.
                try {
                    const backup = await this.readBackup(entry);
                    const current = await readFile(backup.target, "utf8");
                    if (sha256(current) !== backup.afterHash) {
                        throw new FixConflictError(`Profile manifest changed after recovery: ${backup.target}`);
                    }
                    await assertRegularFile(backup.target);
                    await atomicWrite(backup.target, backup.original);
                    await this.ledger.restoreEntry(entry.id);
                    restored.push(entry.id);
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    await this.ledger.restoreEntry(entry.id, "conflicted", message);
                    conflicts.push(message);
                }
            }
            // Entries are processed in reverse, so bailing out on the first conflict would
            // leave a partial restore that the caller never hears about. Report the whole
            // outcome instead, carrying the list of entries that were actually reverted.
            if (conflicts.length) throw new FixConflictError(conflicts.join("; "), restored);
            return restored;
        } finally {
            await this.ledger.releaseLease().catch(() => undefined);
        }
    }

    private async readBackup(entry: RecoveryLedgerEntry): Promise<Backup> {
        try {
            const value: unknown = JSON.parse(await readFile(
                join(this.backupsDirectory, `${entry.id}.json`), "utf8",
            ));
            if (!isRecord(value) || value.schemaVersion !== 1 ||
                value.fixId !== entry.id || typeof value.target !== "string" ||
                typeof value.beforeHash !== "string" || typeof value.afterHash !== "string" ||
                typeof value.original !== "string" || sha256(value.original) !== value.beforeHash) {
                throw new Error("invalid recovery backup");
            }
            return value as unknown as Backup;
        } catch (error) {
            throw new FixConflictError(`Recovery backup is unavailable for ${entry.id}: ${String(error)}`);
        }
    }
}

function isRecord(value: unknown): value is Record<string, any> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function assertRegularFile(path: string): Promise<void> {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new FixConflictError(`Refusing to restore non-regular file: ${path}`);
}
