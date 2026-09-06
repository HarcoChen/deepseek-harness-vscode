<p align="center">
  <img src="resources/dsh.png" alt="DSH IDE" width="128">
</p>

<h1 align="center">DeepSeek Harness for VS Code</h1>

<p align="center">
  <strong>Your coding agent, with every change in view.</strong><br>
  Bring DeepSeek Harness (DSH) into VS Code: work with your code, review native diffs, and follow each task with built-in Trace and usage insights.
</p>

<p align="center">
  <strong>English</strong> | <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://open-vsx.org/extension/harcochen/dsh-vsc-integration"><img src="https://img.shields.io/open-vsx/dt/harcochen/dsh-vsc-integration?style=flat-square&label=Open%20VSX%20downloads" alt="Open VSX downloads"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=HarcoChen.dsh-vsc-integration"><img src="https://vsmarketplacebadges.dev/installs-short/HarcoChen.dsh-vsc-integration.svg?style=flat-square" alt="VS Code Marketplace installs"></a>
  <a href="https://github.com/HarcoChen/deepseek-harness-vscode/stargazers"><img src="https://img.shields.io/github/stars/HarcoChen/deepseek-harness-vscode?style=flat-square" alt="GitHub Stars"></a>
  <a href="https://github.com/HarcoChen/deepseek-harness-vscode/blob/main/LICENSE"><img src="https://img.shields.io/github/license/HarcoChen/deepseek-harness-vscode?style=flat-square" alt="License"></a>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=HarcoChen.dsh-vsc-integration"><strong>Install for VS Code</strong></a> ·
  <a href="https://open-vsx.org/extension/harcochen/dsh-vsc-integration">Open VSX</a> ·
  <a href="https://github.com/HarcoChen/deepseek-harness-vscode/releases">Download VSIX</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>

<p align="center">
  <em>An independent community project. <a href="https://github.com/HarcoChen/deepseek-harness-vscode/issues">Issues</a> welcome.</em>
</p>

<p align="center">
  For JetBrains IDEs (IDEA, PyCharm, etc.), please see <a href="https://github.com/HarcoChen/dsh-intellij-integration">dsh-intellij-integration</a>.
</p>

<p align="center">
  <img src="public/scene-intro.gif" alt="DSH IDE Workflow Demo" width="100%">
</p>

## Why DSH?

- **See what changed.** Review tool edits in VS Code's native side-by-side diff, even outside a Git repository.
- **Decide before execution.** Approval cards show commands and target files, with proposed diffs for supported file writes.
- **Start with context.** Bring files, selections, Git diffs, or paused debugger state into a task without copying everything by hand.
- **Pick up where you left off.** Resume persistent sessions and follow tools, subagents, Todos, and token usage in the Activity panel.

## Quick start

Requires **VS Code 1.106.0 or later** and a configured DSH model provider with credentials.

1. **Install the extension** from the Marketplace or Open VSX links above, or search for `harcochen.dsh-vsc-integration` in Extensions.
2. **Open chat.** Open and trust your project folder, then run `DSH: Open Chat` from the Command Palette. The extension automatically starts or connects to a Runtime; by default, it attempts a managed Runtime download when no usable environment is available.
3. **Set up your provider.** Run `DSH: Configure API Key` for DeepSeek credentials. For other providers, use `DSH: Open dsh Web UI in Browser`. Select or register a DSH Workspace, then choose a model.
4. **Give it a task.** Type `@` to reference a file, or right-click a selection for DSH actions. Follow the task, respond to approval requests, and open diffs from tool cards to review the result.

> A **DSH Workspace** groups sessions in Harness and can be associated with a project path. When using the same Runtime, you can continue sessions created in the Web UI.

### Try it on real work

| Your task | A place to start |
| --- | --- |
| Understand unfamiliar code | Select code and use the DSH explain action: “Walk through the execution flow and edge cases.” |
| Review a change | Use the DSH review action on a Git diff in Source Control: “Check these changes for regressions and point to the relevant lines.” |
| Investigate a breakpoint | While paused, run `DSH: Explain Current Debug State` to attach context including the call stack and local variables. |
| Continue earlier work | Switch to a previous session and use the conversation outline to revisit the discussion. |

## Features

### Native diff for every edit, no Git required

After a `write`/`edit` tool call, open the target file to see VS Code's native side-by-side diff. The before-image is reconstructed by replaying hunks backwards from the Session log, so it also works in non-Git repositories and Git-ignored files.

![Native side-by-side diff preview](public/assets/diff.png)

### Preview before approval

The approval card shows the actual command line, working directory, and target files that will be written. For supported file-writing tools, open a native diff of the proposed change before approving it.

### Slash commands enumerated live from the Runtime

The slash menu dynamically fetches commands registered by the Runtime for the current session (`/plan`, `/compact`, `/goal`, etc.) and merges them with the extension's own IDE commands.

![Slash commands dropdown](public/assets/slash.png)

### Editor and Git context

- Right-click the current file, selection, or Git diff to explain, fix, review, or generate documentation.
- Right-click `Ask about resource` in Explorer to ask about a file or folder.
- The `@` menu autocompletes project files and previous Sessions.
- `DSH: Capture AppShot` (macOS only) captures a window screenshot and inserts it into the conversation as a draft.

### Sessions, Trace, and Activity at a glance

The sidebar provides a native conversation-outline TreeView. Trace, token usage, Todo lists, and subagents are gathered in the Activity panel. The UI supports VS Code's dark and light themes.

![Trace and Activity panel](public/assets/Trace.png)

### Credentials and balance

The bottom bar shows your current balance, including peak and off-peak pricing. Low balances are highlighted clearly.

![Balance indicator](public/assets/balance.png)

## FAQ

**Do I need to install DSH manually?** Usually no. The extension looks for a usable local environment and attempts to download a managed Runtime when needed. The first download requires network access; `dsh.installWhenMissing` controls automatic installation.

**Can I connect to an existing Runtime?** Yes. Set `dsh.serverUrl` to your running `dsh web` address. The extension supports the RC Remote RPC introduced in `dsh 0.1.2-rc.1`; the default managed Runtime is `0.1.2-rc.1`.

**Does DSH support multi-root workspaces?** DSH supports multiple independent Workspaces, but each Session has one working directory (`cwd`). A VS Code multi-root workspace is therefore represented by the first workspace folder for Runtime startup; use separate DSH Workspaces or Sessions when roots need different working directories.

**Does DSH automatically identify secrets or personal information?** No. Context is based on files, selections, and attachments that you explicitly choose; DSH reports size/truncation but does not send workspace content to an additional secret/PII classifier.

**What if startup fails?** Run `DSH: Diagnose Environment`, then `DSH: Show dsh Runtime Logs` from the Command Palette. Include your extension version, OS, and redacted error details when opening an [issue](https://github.com/HarcoChen/deepseek-harness-vscode/issues).

**Does it support Chinese?** Yes. Commands, chat, Activity, and Trace follow VS Code's display language, with English and Simplified Chinese available.

## Architecture and runtime

The extension connects to the Runtime through RC Remote RPC, using HTTP calls and a multiplexed WebSocket for live session updates.

Multiple VS Code windows preferentially reuse the same local Harness Runtime. The Runtime launched by the extension publishes a random loopback port through a process lock; later windows connect directly, avoiding competing writes.

```mermaid
graph TD
    A[VS Code Extension Host] <-->|RC Remote RPC| B[Standalone Harness Runtime]
    A <-->|Typed Full-State Bridge| C[React Webview UI]
    B <-->|CNB Distribution| D[Managed Local Engine]
    A <-->|Process Lock| E[Multi-Window Shared Runtime]
```

## Configuration

Search `dsh` in VS Code settings for the full list.

| Setting | Default | What it does |
| --- | --- | --- |
| `dsh.serverUrl` | `""` | URL of an already running dsh web Runtime; when set, the extension connects directly. |
| `dsh.autoStart` | `true` | Automatically start or connect to dsh web when the extension activates. |
| `dsh.installWhenMissing` | `true` | Automatically download and manage a standalone Runtime when no usable npm/dsh environment is available. |
| `dsh.runtimeVersion` | `0.1.2-rc.1` | Version to download for the managed Runtime. |
| `dsh.npmRegistry` | `https://registry.npmmirror.com` | Registry mirror used as a download fallback. |
| `dsh.npxTimeoutMs` | `120000` | Timeout while waiting for package-manager download and startup. |
| `dsh.maxContextBytes` | `120000` | Maximum UTF-8 bytes of `<ide_context>` included per prompt. |
| `dsh.persistSession` | `true` | Reuse the previous Session ID for the current workspace when possible. |
| `dsh.agentStatusLabels` | *fat-whale messages* | Random text shown during each streaming turn; customizable. |
| `dsh.agentStatusLabel` | `""` | Pins a single fixed status line when set. |
| `dsh.enableEffortKnob` | `true` | Use the runner sprite animation as the reasoning-effort slider button. |

## Other ways to install

**From GitHub Releases** — download the `.vsix` from [Releases](https://github.com/HarcoChen/deepseek-harness-vscode/releases) and run `Extensions: Install from VSIX...`. Pre-release builds are published only to GitHub Releases.

**Build from source**:

```bash
npm install
npm run check
npm run package
```

Then install the generated `.vsix` via `Extensions: Install from VSIX...`.

## Extension API

Other VS Code extensions can hook into the API DSH exports.

<details>
<summary><strong>Conversation navigation API</strong> — register custom nodes</summary>

```ts
const registration = api.registerConversationNavigation([
    { seq: 42, label: "Review the PPO implementation", detail: "Training config" },
]);
context.subscriptions.push(registration);
```

</details>

<details>
<summary><strong>Agent status label API</strong> — customize streaming status text</summary>

```ts
const dsh = vscode.extensions.getExtension<import("dsh-vsc-integration").DshExtensionApi>(
    "harcochen.dsh-vsc-integration",
);
const api = await dsh?.activate();
context.subscriptions.push(
    api?.registerAgentStatusPresentation({ label: "🐋 Diving" }),
);
```

</details>

## Development and testing

```bash
npm install
npm run check      # TypeScript check (host + webview)
npm test           # Release gate: webview check + compile + test suite
npm run compile    # Build to dist/
npm run package    # Compile + vsce package
npm run release    # Test + version bump + CHANGELOG archive + tag
```

To verify the managed Runtime release logic:

```bash
node scripts/verify-managed-runtime.mjs              # remote contract only
node scripts/verify-managed-runtime.mjs --full       # install and smoke-test
```

## More information

- [Changelog](CHANGELOG.md)
- [Product TODO](TODO.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

## Acknowledgments

Thanks to [dsh-reasoning-effort](https://github.com/HanaAyane/dsh-reasoning-effort) for the chibi runner sprite reference. The conversation outline takes inspiration from the `dsh-milestone` project.

## License

[MIT](LICENSE)
