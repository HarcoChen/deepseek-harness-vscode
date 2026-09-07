#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = new URL("../", import.meta.url);
const packagePath = new URL("package.json", root);
const lockPath = new URL("package-lock.json", root);
const changelogPath = new URL("CHANGELOG.md", root);

const REPO = "https://github.com/HarcoChen/dsh-vsc-integration";

function usage() {
    console.log(`Usage: npm run release -- <patch|minor|major|stable|x.y.z> [--push]

The release command requires a clean worktree and a non-empty CHANGELOG.md
[Unreleased] section. It runs the test suite, updates package metadata,
promotes the Unreleased notes, commits, and creates the matching vX.Y.Z tag.

When the current version is a prerelease (e.g. 0.6.0-beta.1), releasing its
stable version folds every matching prerelease section of the CHANGELOG into
the new stable entry, so the graduated release lists everything its betas
shipped; its compare link inherits the earliest beta's starting point. Use the
\`stable\` bump to graduate the current prerelease in place.

Options:
  --push       push the current branch and release tag to origin
  --dry-run    validate and run checks without changing files or git state
  --help       show this help

Example:
  npm run release -- stable --push
  npm run release -- 0.6.0`);
}

function fail(message) {
    console.error(`release: ${message}`);
    process.exit(1);
}

function git(args, options = {}) {
    try {
        return execFileSync("git", args, {
            cwd: new URL("../", import.meta.url),
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        }).trim();
    } catch (error) {
        if (options.allowFailure) return "";
        const detail = error instanceof Error ? error.message : String(error);
        fail(`git ${args.join(" ")} failed: ${detail}`);
    }
}

function run(command, args) {
    execFileSync(command, args, {
        cwd: new URL("../", import.meta.url),
        stdio: "inherit",
    });
}

function parseVersion(value) {
    if (typeof value !== "string") return undefined;
    // Accept an optional SemVer prerelease suffix (e.g. 0.6.0-beta.1): the
    // release triple is what we order releases by, the prerelease is carried
    // alongside so beta -> stable transitions can be reasoned about.
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value.trim());
    if (!match) return undefined;
    return {
        release: [Number(match[1]), Number(match[2]), Number(match[3])],
        prerelease: match[4] ?? null,
    };
}

// SemVer prerelease precedence: a stable release outranks any prerelease of the
// same release triple; between prereleases the dot-separated identifiers compare
// left to right, numeric identifiers numerically and below alphanumeric ones,
// and a shorter identifier set has lower precedence when all else is equal.
function comparePrerelease(a, b) {
    if (a === b) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    const as = a.split(".");
    const bs = b.split(".");
    for (let i = 0; i < Math.max(as.length, bs.length); i += 1) {
        if (i >= as.length) return -1;
        if (i >= bs.length) return 1;
        const x = as[i];
        const y = bs[i];
        if (x === y) continue;
        const xn = /^\d+$/.test(x);
        const yn = /^\d+$/.test(y);
        if (xn && yn) return Math.sign(Number(x) - Number(y));
        if (xn !== yn) return xn ? -1 : 1;
        return x < y ? -1 : 1;
    }
    return 0;
}

function compareVersions(a, b) {
    for (let i = 0; i < 3; i += 1) {
        if (a.release[i] !== b.release[i]) return Math.sign(a.release[i] - b.release[i]);
    }
    return comparePrerelease(a.prerelease, b.prerelease);
}

function sameRelease(a, b) {
    return a.release[0] === b.release[0]
        && a.release[1] === b.release[1]
        && a.release[2] === b.release[2];
}

function nextVersion(current, bump) {
    const parsed = parseVersion(current);
    if (!parsed) fail(`package.json has an unsupported version: ${current}`);
    const explicit = parseVersion(bump);
    if (explicit) {
        if (compareVersions(explicit, parsed) <= 0) {
            fail(`new version ${bump} must be greater than current version ${current}`);
        }
        return bump;
    }

    const [major, minor, patch] = parsed.release;
    switch (bump) {
        case "major":
            return `${major + 1}.0.0`;
        case "minor":
            return `${major}.${minor + 1}.0`;
        case "patch":
            return `${major}.${minor}.${patch + 1}`;
        case "stable":
        case "release":
            // Graduate the current prerelease to its own release triple.
            if (!parsed.prerelease) {
                fail(`current version ${current} is already stable; nothing to graduate`);
            }
            return `${major}.${minor}.${patch}`;
        default:
            fail(`bump must be patch, minor, major, stable, or an explicit x.y.z version (received ${bump})`);
    }
}

function changelogNotes(changelog) {
    const heading = /^## \[Unreleased\]\s*\n/m.exec(changelog);
    if (!heading) fail("CHANGELOG.md is missing an [Unreleased] section");

    const bodyStart = heading.index + heading[0].length;
    const nextHeading = /^## \[/gm;
    nextHeading.lastIndex = bodyStart;
    const next = nextHeading.exec(changelog);
    const bodyEnd = next?.index ?? changelog.length;
    const notes = changelog.slice(bodyStart, bodyEnd)
        .replace(/<!--[^]*?-->/gu, "")
        .trim();
    if (!notes) fail("CHANGELOG.md [Unreleased] section is empty");

    const before = changelog.slice(0, heading.index);
    const after = changelog.slice(bodyEnd);
    return { notes, rest: `${before}${after}` };
}

// The version sections of the changelog body (everything before the trailing
// link-reference block): heading label, note body, and the [start, end) span.
function changelogSections(changelog) {
    const linkStart = changelog.search(/^\[[^\]]+\]:\s+https?:\/\//m);
    const boundary = linkStart < 0 ? changelog.length : linkStart;
    const headingRe = /^## \[([^\]]+)\][^\n]*\n/gm;
    const heads = [];
    let match;
    while ((match = headingRe.exec(changelog)) !== null) {
        if (match.index >= boundary) break;
        heads.push({
            label: match[1],
            heading: match[0],
            contentStart: match.index + match[0].length,
            start: match.index,
        });
    }
    return heads.map((head, index) => ({
        label: head.label,
        heading: head.heading,
        body: changelog.slice(head.contentStart, index + 1 < heads.length ? heads[index + 1].start : boundary),
        start: head.start,
        end: index + 1 < heads.length ? heads[index + 1].start : boundary,
    }));
}

// The "from" side of a section's compare link, e.g. 0.5.3 for
// `[0.6.0-beta.1]: .../compare/v0.5.3...v0.6.0-beta.1`.
function linkReferenceFrom(changelog, label) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`^\\[${escaped}\\]:[^\\n]*\\/compare\\/v(.+?)\\.\\.\\.`, "m").exec(changelog);
    return match ? match[1] : undefined;
}

// Fold every prerelease section sharing this stable release's triple into one
// merged note body. Returns the pruned changelog (folded sections and their
// dangling link references removed), the merged notes, and the compare base
// inherited from the earliest folded prerelease.
function foldPrereleases(changelog, version) {
    const target = parseVersion(version);
    if (!target || target.prerelease) {
        return { changelog, mergedNotes: "", mergedLabels: [], compareBase: undefined };
    }
    const folded = changelogSections(changelog).filter((section) => {
        if (/\[YANKED\]/i.test(section.heading)) return false;
        const parsed = parseVersion(section.label);
        return Boolean(parsed) && parsed.prerelease !== null && sameRelease(parsed, target);
    });
    if (folded.length === 0) {
        return { changelog, mergedNotes: "", mergedLabels: [], compareBase: undefined };
    }

    let pruned = changelog;
    // Remove sections back to front so earlier offsets stay valid.
    for (const section of [...folded].sort((a, b) => b.start - a.start)) {
        pruned = pruned.slice(0, section.start) + pruned.slice(section.end);
    }
    const mergedLabels = folded.map((section) => section.label);
    for (const label of mergedLabels) {
        const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        pruned = pruned.replace(new RegExp(`^\\[${escaped}\\]:[^\\n]*\\n`, "m"), "");
    }
    const mergedNotes = folded
        .map((section) => section.body.trim())
        .filter(Boolean)
        .join("\n\n");
    const earliest = [...folded]
        .sort((a, b) => compareVersions(parseVersion(a.label), parseVersion(b.label)))[0];
    return {
        changelog: pruned,
        mergedNotes,
        mergedLabels,
        compareBase: linkReferenceFrom(changelog, earliest.label),
    };
}

function promoteChangelog(changelog, version, previousVersion) {
    const { changelog: folded, mergedNotes, compareBase } = foldPrereleases(changelog, version);
    const { notes, rest } = changelogNotes(folded);
    const date = new Date().toISOString().slice(0, 10);
    const combined = mergedNotes ? `${notes}\n\n${mergedNotes}` : notes;
    const entry = `## [${version}] - ${date}\n\n${combined}\n\n`;
    const unreleased = "## [Unreleased]\n\n<!-- 在这里填写下一版本的发布说明；npm run release 会自动提升这一节。 -->\n\n";
    const from = compareBase ?? previousVersion;
    const link = `[${version}]: ${REPO}/compare/v${from}...v${version}`;
    const firstSection = rest.search(/^## \[/m);
    const withEntry = `${rest.slice(0, firstSection < 0 ? rest.length : firstSection)}${unreleased}${entry}${firstSection < 0 ? "" : rest.slice(firstSection)}`;
    const linkIndex = withEntry.search(/^\[[^\]]+\]:\s+https?:\/\//m);
    if (linkIndex < 0) return `${withEntry.trimEnd()}\n\n${link}\n`;
    return `${withEntry.slice(0, linkIndex)}${link}\n${withEntry.slice(linkIndex)}`;
}

function updateJson(path, version, update) {
    const value = JSON.parse(readFileSync(path, "utf8"));
    update(value);
    writeFileSync(path, `${JSON.stringify(value, null, 4)}\n`, "utf8");
}

function main() {
    const rawArgs = process.argv.slice(2);
    if (rawArgs.includes("--help") || rawArgs.length === 0) {
        usage();
        process.exit(rawArgs.length === 0 ? 1 : 0);
    }

    const push = rawArgs.includes("--push");
    const dryRun = rawArgs.includes("--dry-run");
    const bump = rawArgs.find((argument) => !argument.startsWith("--"));
    if (!bump) fail("missing version bump");

    const status = git(["status", "--porcelain"]);
    if (status) {
        fail("working tree is not clean; commit application changes before releasing");
    }

    const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
    const currentVersion = typeof packageJson.version === "string" ? packageJson.version : "";
    const version = nextVersion(currentVersion, bump);
    const tag = `v${version}`;
    if (git(["tag", "--list", tag])) fail(`tag ${tag} already exists`);

    const changelog = readFileSync(changelogPath, "utf8");
    const nextChangelog = promoteChangelog(changelog, version, currentVersion);
    console.log(`Preparing ${tag}`);
    console.log(`- test suite`);
    console.log(`- package.json and package-lock.json -> ${version}`);
    console.log(`- CHANGELOG.md [Unreleased] -> ${version}`);
    console.log(`- commit and tag${push ? ", then push" : ""}`);

    run("npm", ["test"]);
    if (dryRun) {
        console.log("Dry run complete; no files or git refs were changed.");
        process.exit(0);
    }

    updateJson(packagePath, version, (value) => {
        value.version = version;
    });
    updateJson(lockPath, version, (value) => {
        value.version = version;
        const packages = value.packages;
        if (packages?.[""]) packages[""].version = version;
    });
    writeFileSync(changelogPath, nextChangelog, "utf8");

    run("git", ["add", "package.json", "package-lock.json", "CHANGELOG.md"]);
    run("git", ["commit", "-m", `release: ${tag}`]);
    // Annotated tag: `git push --follow-tags` only pushes annotated tags.
    run("git", ["tag", "-a", tag, "-m", `release: ${tag}`]);

    if (push) {
        const branch = git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
        if (!branch) fail("cannot push from a detached HEAD");
        run("git", ["push", "origin", branch, "--follow-tags"]);
    } else {
        console.log(`Release ${tag} is ready. Push it with: git push origin HEAD --follow-tags`);
    }
}

const invokedDirectly = process.argv[1]
    && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();

export {
    parseVersion,
    comparePrerelease,
    compareVersions,
    nextVersion,
    changelogNotes,
    changelogSections,
    foldPrereleases,
    promoteChangelog,
};
