export type PatchLayerKind =
    | "bundle"
    | "profile-user"
    | "home-user"
    | "extension-overlay"
    | "recovery-overlay"
    | "unknown";

export interface FileFingerprint {
    path: string;
    kind: "file" | "directory" | "link" | "missing";
    size?: number;
    mtimeMs?: number;
    contentHash?: string;
    secret?: boolean;
}

export interface PatchLayerDescriptor {
    kind: PatchLayerKind;
    path: string;
    order: number;
    contentHash?: string;
    entryIds?: readonly string[];
    sourceLabel: string;
}

export interface BundleDescriptor {
    packageName: string;
    packageDir?: string;
    manifestPath?: string;
    patchPath?: string;
    origin: "installation" | "profile-dependency" | "profile-manifest" | "unknown";
    selected: boolean;
    packageHash?: string;
    patchHash?: string;
}

export interface RuntimeBinaryDescriptor {
    command: string;
    resolvedPath?: string;
    source: string;
    version?: string;
    launcherArgs: readonly string[];
}

export interface EnvironmentSurface {
    cwd: string;
    dshHome: string;
    platform: NodeJS.Platform;
    arch: string;
    nodeVersion: string;
    inheritedNames: readonly string[];
    presentSensitiveNames: readonly string[];
    stableValuesHash: string;
}

export interface CompositionDescriptor {
    schemaVersion: 1;
    profile: string;
    profileManifestPath?: string;
    profilePackageHash?: string;
    profilePackageMtimeMs?: number;
    binary: RuntimeBinaryDescriptor;
    appArgs: readonly string[];
    patchLayers: readonly PatchLayerDescriptor[];
    bundles: readonly BundleDescriptor[];
    profileFiles: readonly FileFingerprint[];
    homeFiles: readonly FileFingerprint[];
    environment: EnvironmentSurface;
    extensionOverlayPaths: readonly string[];
    recoveryOverlayPaths: readonly string[];
    compositionHash: string;
}

export type HealthVerdict =
    | "healthy"
    | "unhealthy"
    | "timeout"
    | "process-error"
    | "sandbox-error"
    | "cancelled";

export type FailureClass =
    | "none"
    | "boot-exit"
    | "boot-timeout"
    | "rpc-unhealthy"
    | "rpc-protocol"
    | "auth"
    | "sandbox-build"
    | "sandbox-cleanup"
    | "launcher"
    | "unknown";

export interface ProcessEvidence {
    pid?: number;
    exitCode?: number | null;
    signal?: NodeJS.Signals | null;
    launcherExited: boolean;
    descendantOwnership: "owned" | "not-needed" | "unknown" | "verified-exited";
}

export interface HealthEvidence {
    bootId: string;
    variantId: string;
    compositionHash?: string;
    verdict: HealthVerdict;
    failureClass: FailureClass;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    process: ProcessEvidence;
    endpoint?: {
        baseUrl: string;
        authenticated: boolean;
        probe: "session/list";
        httpStatus?: number;
        rpcId?: string;
    };
    outputTail: string;
    outputTruncated: boolean;
    logPath?: string;
    sandboxPath?: string;
    cleanup: {
        processStopped: boolean;
        secretFilesRemoved: boolean;
        sandboxRemoved: boolean;
        deferredCleanup?: boolean;
    };
    classifierNotes: readonly string[];
}

export type VariantKind =
    | "v1-reproduce"
    | "v3-all-user-bundles-removed"
    | "v3-bundle-half-added"
    | "v3-bundle-singleton"
    | "v4-extension-overlays-removed";

export interface RestoreInstruction {
    kind: "remove-file" | "restore-file" | "restore-json" | "remove-managed-state";
    target: string;
    expectedHash?: string;
    displayCommand: string;
    requiresConfirmation: boolean;
}

export type CandidateFixKind =
    | "remove-extension-overlay"
    | "disable-profile-bundles";

export interface CandidateFix {
    id: string;
    kind: CandidateFixKind;
    targetIds: readonly string[];
    reason: string;
    evidenceBootIds: readonly string[];
    precondition: {
        runtimeMustBeDead: boolean;
        expectedSourceHashes: Readonly<Record<string, string>>;
    };
    removedPatchPaths?: readonly string[];
    profileManifestPath?: string;
    expectedProfileManifestHash?: string;
    overlayPath?: string;
    restore: RestoreInstruction;
}

export interface CompositionVariant {
    id: string;
    kind: VariantKind;
    parentHash: string;
    assumption: string;
    bundleSelection?: readonly string[];
    removedOverlayPaths?: readonly string[];
    composition: CompositionDescriptor;
    candidateFix?: CandidateFix;
}

export interface RecoveryBudget {
    maxBoots: number;
    usedBoots: number;
    reserved: {
        v1: number;
        v3: number;
        v4: number;
        confirmation: number;
    };
    skipped: Array<{
        variantId: string;
        reason: "budget" | "duplicate" | "unsupported" | "cancelled";
    }>;
}

export interface Attribution {
    category: "transient" | "bundle" | "extension-overlay" | "profile-patch" | "home-patch" | "environment" | "unknown";
    confidence: "high" | "medium" | "low";
    culpritIds: readonly string[];
    humanSummary: string;
}

export type LedgerEntryStatus =
    | "planned"
    | "applied"
    | "verified"
    | "reverted"
    | "conflicted"
    | "manual-required";

export interface RecoveryLedgerEntry {
    id: string;
    sessionId: string;
    status: LedgerEntryStatus;
    fix: CandidateFix;
    plannedAt: string;
    appliedAt?: string;
    verifiedAt?: string;
    revertedAt?: string;
    beforeCompositionHash: string;
    afterCompositionHash?: string;
    note?: string;
}

export interface RecoveryLedgerSession {
    id: string;
    startedAt: string;
    finishedAt?: string;
    clean: boolean;
    phase: "detected" | "searching" | "fix-applied" | "recovered" | "unrecoverable" | "cancelled";
    compositionHash: string;
    budget: RecoveryBudget;
    evidence: HealthEvidence[];
    attribution?: Attribution;
    error?: string;
}

export interface RecoveryLedgerState {
    schemaVersion: 1;
    revision: number;
    clean: boolean;
    activeSessionId?: string;
    lastKnownGood?: CompositionDescriptor;
    sessions: RecoveryLedgerSession[];
    entries: RecoveryLedgerEntry[];
}

export interface RecoveryStatusView {
    sessionId: string;
    phase: RecoveryLedgerSession["phase"];
    usedBoots: number;
    maxBoots: number;
    currentVariant?: string;
    summary?: string;
    canRestore: boolean;
}

export interface RecoveryOutcome {
    status: "retry" | "candidate" | "unrecoverable" | "cancelled";
    sessionId: string;
    composition?: CompositionDescriptor;
    fix?: CandidateFix;
    attribution?: Attribution;
    message: string;
}

export interface RecoveryLaunchSpec {
    command: string;
    args: readonly string[];
    cwd: string;
    env?: NodeJS.ProcessEnv;
    source: string;
}

export interface RecoveryBootLog {
    path: string;
    append(stream: "stdout" | "stderr" | "meta" | "probe", text: string): Promise<void>;
    finish(summary: HealthEvidence): Promise<void>;
}
