import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { recomputeComposition } from "./composition";
import type {
    Attribution,
    CandidateFix,
    CompositionDescriptor,
    CompositionVariant,
    HealthEvidence,
    RecoveryBudget,
    VariantKind,
} from "./types";

function pathKey(path: string): string {
    const resolvedPath = resolve(path);
    return process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
}

function idFor(kind: VariantKind, target: readonly string[]): string {
    const digest = createHash("sha256")
        .update(`${kind}:${target.join("\0")}`)
        .digest("hex")
        .slice(0, 12);
    return `${kind}-${digest}`;
}

function bundleVariant(
    base: CompositionDescriptor,
    kind: VariantKind,
    selected: readonly string[],
    assumption: string,
    candidate?: CandidateFix,
): CompositionVariant {
    const selectedSet = new Set(selected);
    const bundles = base.bundles.map((bundle) => ({
        ...bundle,
        selected: selectedSet.has(bundle.packageName),
    }));
    const composition = recomputeComposition(base, { bundles });
    return {
        id: idFor(kind, selected),
        kind,
        parentHash: base.compositionHash,
        assumption,
        bundleSelection: [...selected],
        composition,
        ...(candidate === undefined ? {} : { candidateFix: candidate }),
    };
}

function overlayVariant(base: CompositionDescriptor): CompositionVariant {
    const removed = [...base.extensionOverlayPaths];
    const remaining = new Set(removed.map(pathKey));
    const patchLayers = base.patchLayers.filter((layer) => !remaining.has(pathKey(layer.path)));
    const composition = recomputeComposition(base, {
        patchLayers,
        extensionOverlayPaths: [],
    });
    const candidate: CandidateFix = {
        id: idFor("v4-extension-overlays-removed", removed),
        kind: "remove-extension-overlay",
        targetIds: removed.map((path) => basename(path)),
        reason: "The original composition is unhealthy without the extension-owned patch layer.",
        evidenceBootIds: [],
        precondition: {
            runtimeMustBeDead: true,
            expectedSourceHashes: Object.fromEntries(
                base.patchLayers
                    .filter((layer) => removed.some((path) => pathKey(path) === pathKey(layer.path)))
                    .map((layer) => [layer.path, layer.contentHash ?? ""]),
            ),
        },
        removedPatchPaths: removed,
        restore: {
            kind: "remove-managed-state",
            target: "recovery/active-fixes.json",
            displayCommand: "Remove the recovery overlay state",
            requiresConfirmation: false,
        },
    };
    return {
        id: idFor("v4-extension-overlays-removed", removed),
        kind: "v4-extension-overlays-removed",
        parentHash: base.compositionHash,
        assumption: "The extension-owned patch layer is the failing part of the boot composition.",
        removedOverlayPaths: removed,
        composition,
        candidateFix: candidate,
    };
}

function bundleCandidate(
    base: CompositionDescriptor,
    variant: CompositionVariant,
    removed: readonly string[],
): CandidateFix | undefined {
    if (removed.length === 0 || removed.length > 2 || !base.profileManifestPath) return undefined;
    const targets = base.bundles.filter((bundle) =>
        removed.includes(bundle.packageName) && bundle.origin === "profile-dependency",
    );
    if (targets.length !== removed.length) return undefined;
    return {
        id: idFor(variant.kind, removed),
        kind: "disable-profile-bundles",
        targetIds: [...removed],
        reason: `Profile dependency bundle candidate: ${removed.join(", ")}`,
        evidenceBootIds: [],
        precondition: {
            runtimeMustBeDead: true,
            expectedSourceHashes: {
                [base.profileManifestPath]: base.profilePackageHash ?? "",
            },
        },
        profileManifestPath: base.profileManifestPath,
        expectedProfileManifestHash: base.profilePackageHash,
        restore: {
            kind: "restore-json",
            target: base.profileManifestPath,
            expectedHash: base.profilePackageHash,
            displayCommand: `Restore the managed bundle list in ${base.profileManifestPath}`,
            requiresConfirmation: true,
        },
    };
}

export class VariantEngine {
    public plan(composition: CompositionDescriptor, budget: RecoveryBudget): CompositionVariant[] {
        const variants: CompositionVariant[] = [];
        const seen = new Set<string>();
        const add = (variant: CompositionVariant): void => {
            if (seen.has(variant.composition.compositionHash)) {
                variant = { ...variant, id: `${variant.id}-duplicate` };
                return;
            }
            seen.add(variant.composition.compositionHash);
            variants.push(variant);
        };

        add({
            id: idFor("v1-reproduce", [composition.compositionHash]),
            kind: "v1-reproduce",
            parentHash: composition.compositionHash,
            assumption: "The failure was transient; reproduce the exact launch composition.",
            composition,
        });

        if (composition.extensionOverlayPaths.length > 0) {
            add(overlayVariant(composition));
        }

        const userBundles = composition.bundles
            .filter((bundle) => bundle.selected && bundle.origin === "profile-dependency")
            .map((bundle) => bundle.packageName);
        if (userBundles.length > 0) {
            const baseSelected = userBundles;
            const empty = bundleVariant(
                composition,
                "v3-all-user-bundles-removed",
                [],
                "All non-installation bundles are removed in the sandbox to test the core/profile baseline.",
            );
            if (userBundles.length === 1) {
                empty.candidateFix = bundleCandidate(composition, empty, userBundles);
            }
            add(empty);

            const halves: string[][] = [];
            const midpoint = Math.ceil(userBundles.length / 2);
            halves.push(userBundles.slice(0, midpoint));
            if (midpoint < userBundles.length) halves.push(userBundles.slice(midpoint));
            for (const half of halves) {
                const variant = bundleVariant(
                    composition,
                    "v3-bundle-half-added",
                    half,
                    `Only this bundle half is retained: ${half.join(", ")}`,
                    undefined,
                );
                const removed = baseSelected.filter((name) => !half.includes(name));
                variant.candidateFix = bundleCandidate(composition, variant, removed);
                add(variant);
            }
            for (const bundle of userBundles) {
                const variant = bundleVariant(
                    composition,
                    "v3-bundle-singleton",
                    [bundle],
                    `Only this bundle is retained: ${bundle}`,
                );
                variant.candidateFix = bundleCandidate(
                    composition,
                    variant,
                    userBundles.filter((name) => name !== bundle),
                );
                add(variant);
            }
        }
        return variants.slice(0, Math.max(1, budget.maxBoots));
    }

    public explain(
        variant: CompositionVariant,
        evidence: readonly HealthEvidence[],
    ): Attribution | undefined {
        const current = evidence.find((item) => item.variantId === variant.id);
        if (!current || current.verdict !== "healthy") return undefined;
        if (variant.kind === "v1-reproduce") {
            return {
                category: "transient",
                confidence: "medium",
                culpritIds: [],
                humanSummary: "原始组合在沙箱中恢复健康，故障更接近瞬态启动失败。",
            };
        }
        if (variant.kind === "v4-extension-overlays-removed") {
            return {
                category: "extension-overlay",
                confidence: "high",
                culpritIds: variant.removedOverlayPaths ?? [],
                humanSummary: "移除扩展附加层后沙箱通过健康探针。",
            };
        }
        return {
            category: "bundle",
            confidence: variant.candidateFix?.targetIds.length === 1 ? "high" : "medium",
            culpritIds: variant.candidateFix?.targetIds ?? [],
            humanSummary: `收缩 bundle 组合后沙箱通过健康探针：${variant.candidateFix?.targetIds.join(", ") || "组合交互"}`,
        };
    }
}
