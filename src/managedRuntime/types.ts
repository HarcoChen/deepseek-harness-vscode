/**
 * Managed (self-installed) DSH Runtime support.
 *
 * Cache layout under <globalStorageUri>:
 *
 *   runtime/
 *   ├── locks/                       # per (target, version) install locks
 *   ├── <target>/<version>/          # installed runtimes
 *   │   ├── installed.json           # install metadata
 *   │   └── dsh-runtime/             # extracted archive
 *   └── runtime-downloads/           # transient download area
 *
 * The download source is pinned to CNB in this version. The download source
 * and base URL stay as constants so a replaced remote manifest cannot silently
 * upgrade the runtime beyond the pinned version.
 */

export interface RuntimeAsset {
    /** Plain file name of the asset, e.g. dsh-runtime-v0.1.2-rc.1-linux-x64.tar.gz */
    filename: string;
    /** Lowercase hex SHA-256 of the archive file. */
    sha256: string;
    /** Exact archive size in bytes. */
    size: number;
}

export interface RuntimeManifest {
    version: string;
    /** Keyed by platform target, e.g. "linux-x64". */
    platforms: Record<string, RuntimeAsset>;
}

export interface RuntimeInstallMetadata {
    version: string;
    target: string;
    filename: string;
    sha256: string;
    size: number;
    installedAt: string;
}

/** A runtime that passed the local integrity check and can be launched. */
export interface ManagedRuntime {
    version: string;
    target: string;
    versionDir: string;
    launcherPath: string;
    metadata: RuntimeInstallMetadata;
}

/** User-visible phases of a managed Runtime install. */
export type RuntimeInstallPhase = "preparing" | "downloading" | "verifying" | "installing";

export interface RuntimeDownloadProvider {
    readonly kind: "cnb" | "github";
    getManifest(version: string, signal?: AbortSignal): Promise<RuntimeManifest>;
    downloadAsset(
        asset: RuntimeAsset,
        destination: string,
        options?: { signal?: AbortSignal; onProgress?: (received: number, total: number) => void },
    ): Promise<{ sha256: string; size: number }>;
}

/** Pinned runtime version; never request "latest" from a remote manifest. */
export const RUNTIME_DEFAULT_VERSION = "0.1.5-rc.1";

/** Download source for the first version; reserved for a future GitHub provider. */
export const RUNTIME_DOWNLOAD_SOURCE = "cnb" as const;

/** CNB releases base URL. */
export const CNB_RUNTIME_BASE_URL = "https://cnb.cool/harcochen/dsh-runtime";
