# DSH 崩溃后全自动恢复子系统设计

状态：设计稿，待审查
日期：2026-09-11
适用仓库：`dsh-vsc-integration`
范围：只处理 DSH Runtime 启动失败、启动后意外退出，以及下一次激活时的异常恢复再入。不包含变更时探路、配置监视、启动闸门等预防栈。

源码事实复核见：[DSH_CRASH_RECOVERY_SOURCE_REVIEW.md](./DSH_CRASH_RECOVERY_SOURCE_REVIEW.md)。仓库中没有 `deepseek-harness/`，因此 DSH 本体细节以本机安装的 `@deepseek-ai/dsh@0.1.5-rc.1` 分发源码为基线；涉及版本升级时必须重新做兼容性复核。

## 1. 结论摘要

方案只保留一个故障判定原语：`HealthOracle`。它不导入 `vscode`，把指定的启动组合复制或物化到临时沙箱，以真实 DSH 进程启动，再用现有 RC Remote `session/list` 探针判断健康。搜索层 `VariantEngine` 只负责产生有限的组合变体，修复层 `FixExecutor` 只提交经过沙箱复验的可逆变更，`RecoverySession` 负责持久状态、预算、取消和并发。

核心不变量：

1. 任何“恢复成功”都必须同时满足：Runtime 进程存活、`isHarnessHealthy` 通过、当前有效组合哈希已写入 `last-known-good`、账本为一致状态。
2. `last-known-good` 只用于当前组合 diff 和诊断，永远不作为恢复源，也不回退到历史快照。[D4][D8][F19]
3. 阶段 1 只使用扩展生成的 `--patch` 覆盖层，用户文件不改写；阶段 2 才允许在严格条件下写 profile 托管块或执行文件改名隔离。[D5][D9]
4. 所有 Oracle 启动都拥有独立的 `DSH_HOME`、临时端口和可清理的子进程；不取得真实 Runtime 锁，不访问 `sessions/` 和 `storages/`。[A1][A6]
5. Windows 上不从已退出的 wrapper PID 猜测后代归属。能证明的才清理，不能证明的保留进程和证据，不用一个更糟的清理错误覆盖真实崩溃原因。[F3][F4][F5]
6. 每个自动动作都必须能在账本中找到原因、时间、前后指纹和还原计划。账本无法解析时宁可停在诊断态，不声称安全。[D4][D5]

## 2. 范围、边界和不做的事

### 2.1 本方案处理

| 故障 | 自动动作 | 防止什么 | 防不死什么 |
| --- | --- | --- | --- |
| boot 阶段 `exit 1`、加载器激活失败、patch 组合失败 | 沙箱复现、搜索 bundle 或扩展附加层、应用可逆隔离、再次真实启动 | 插件导入/激活、补丁语法或组合冲突 | DSH 二进制损坏、安装依赖损坏、非确定性外部网络故障 |
| 已就绪 Runtime 意外退出 | 沿用现有 1s/5s/15s 原样重启；三次失败后进入搜索 | 瞬态崩溃和短暂启动失败 | 运行期 fail-loud 的第一次崩溃无法由进程外提前阻止 |
| 扩展激活时发现上次启动账本为 `unclean` | 先尝试收养有充分证据的健康 Runtime，再恢复会话 | VS Code 非正常死亡后的恢复再入 | VS Code 和 Runtime 都已死且没有后续激活时没有执行者 |
| 扩展生成的 compaction 等附加层冲突 | 移除该附加层或用后置 disabled overlay 覆盖 | 扩展附加层本身的冲突 | 用户 profile/home patch 的错误 |
| 单个用户 bundle 导致组合崩溃 | 沙箱二分定位，满足置信度后从有效 bundle 列表隔离 | 用户插件导入和激活故障 | 两个插件非单调交互、包本体损坏、DSH 核心故障 |

### 2.2 明确不处理

- 不修改 DSH 上游，不添加 `--parent-pid`，不使用 Windows Job Object。[五、已否决方案]
- 不使用安全模式、内嵌 agent、额外 API key 或第三方恢复插件。[D1][D2][D7]
- 不回滚快照，不复制整个 home，不触碰 `sessions/`、`storages/`、用户工作区内容。[D8][F15][F19]
- 不自动执行重装、删除、覆盖用户内容或改变包管理器依赖树。此类动作只能进入诊断包或等待明确确认。[D5]
- `serverUrl` 指向远程 Runtime 时不自动改远程 home，也不把远程 Runtime 当作扩展可拥有的子进程。
- 扩展自身损坏不由 VS Code 扩展进程自救；v2 提供同一套 Node core 的独立 repair CLI。[D6]

### 2.3 诚实边界

DSH 的 `installFailLoud` 可能在进程内部整体退出，扩展进程外无法阻止一次已经发生的运行期崩溃。这里的等价体验是：扩展在秒级重启，使用持久 session 重新连上。VS Code 全部关闭时没有任何进程负责执行恢复；下次激活通过 boot journal 和账本进入 fsck 式再入。若扩展本身不能加载，v2 repair CLI 是单独兜底。[D6][F12][F17]

## 3. 设计异议和必须接受的限制

这一节不是可选优化，而是对既定方向中存在的内在边界做显式说明。

### 3.1 `disabled` entry 不等于禁用 bundle

DSH 的 `--patch` 是可重复的单值选项，后层 patch 按 argv 顺序覆盖前层；但 `disabled: true` 只作用于已经合成且 id 命中的 entry。bundle 的 patch 文件在合成期间仍会被读取，坏 bundle 如果在 import 或 bundle patch 解析阶段失败，单纯的 disabled overlay 不能修复。[F14][A2][DSH_CRASH_RECOVERY_SOURCE_REVIEW.md 第 1、2 节]

因此本设计明确分流：

- 已知 entry 级问题，例如扩展自己的 compaction entry，使用阶段 1 overlay。
- bundle import/激活失败，必须在沙箱中构造“去掉该 bundle 的 profile manifest”，真实修复则使用阶段 2 profile 托管块或文件隔离。
- 如果只能证明“禁用某 entry 后通过”，但不能证明 bundle 解析阶段安全，不能把它标为 bundle 已隔离。

### 3.2 收养健康孤儿和安全谓词之间的证据缺口

现有 `findExistingRuntime` 可以通过锁、端口、认证和 `session/list` 判断一个 Runtime 可连接，但旧锁可能没有本次组合哈希。健康不等于“就是当前恢复组合”。因此：

1. `findExistingRuntime` 仍然是恢复搜索前的第一步，满足 A5。
2. 新版本锁记录必须增加 `compositionHash` 和 `recoverySessionId`。
3. 当前账本为 `unclean` 时，只有锁中组合哈希与计划组合哈希相同，或健康 Runtime 是本次会话刚启动的拥有进程，才允许标记为 `RECOVERED`。
4. 老锁、无哈希锁或端口探测到的无锁 Runtime 可以保留并报告，但不能被宣称为安全恢复源，也不能自动击杀。[D4][D5][F5]

### 3.3 沙箱的整个 `node_modules` junction 不是只读

DSH 启动会执行 `healProfilesModuleFallback`，可能在 `$DSH_HOME/profiles/node_modules`、`profiles/<profile>/node_modules` 和 `.dsh-module-fallback/node_modules` 写入或删除 link/proxy。把整个目录 junction 到真实 home 会把 Oracle 变成真实文件系统写入者。[F13][DSH_CRASH_RECOVERY_SOURCE_REVIEW.md 第 4 节]

本设计只在沙箱真实目录中逐项创建 link/proxy，目标包目录可以 junction 到安装目录，但 link 的父目录永远属于沙箱。若无法建立逐项隔离，Oracle 返回 `sandbox-error`，不进入下一变体。

### 3.4 `cordis.yml` 和 `dump-config` 不能当作只读接口

DSH 每次 `prepareProfile` 都会重写沙箱 profile 的空 `cordis.yml`；`dump-config` 虽不 boot，仍可能写该文件。Oracle 只在沙箱中调用这些路径，真实 home 不运行 `dump-config`，也不以 dump 输出替代真实 boot。[F13][DSH_CRASH_RECOVERY_SOURCE_REVIEW.md 第 3、8 节]

### 3.5 版本漂移不能静默兼容

本设计按 `0.1.5-rc.1` 的 CLI 和 patch 语义设计。检测到 Runtime 版本不匹配、profile schema 不认识、或沙箱构建无法证明等情况时，进入 `UNRECOVERABLE`/诊断态，不用猜测新版本的行为。[F1][F10][F14]

## 4. 模块与文件清单

原则：Node core 只依赖 Node 标准库和仓库已有的无 VS Code 模块；VS Code 只存在于薄适配层。接口尽量深，调用方只需要提交启动组合、读取结果、提交生命周期事件。[D10]

### 4.1 新增 Node core

| 文件 | 职责 | 依赖和边界 |
| --- | --- | --- |
| `src/recovery/types.ts` | 所有组合、证据、账本、变体、预算、结果的类型 | 零 `vscode` import |
| `src/recovery/composition.ts` | 从当前启动参数和 home 构造组合描述；规范化路径、patch 顺序、环境面；计算 hash 和 diff | 零 `vscode` import |
| `src/recovery/sandbox.ts` | 临时 home/profile/workspace 构建、逐项 link、秘密文件清理、沙箱生命周期 | 零 `vscode` import；使用注入的文件/进程适配器 |
| `src/recovery/healthOracle.ts` | 启动沙箱 DSH、捕获 stdout/stderr、认证并执行 RC Remote 健康探针 | 零 `vscode` import；每次调用无共享运行态 |
| `src/recovery/variantEngine.ts` | V1/V3/V4 变体生成、排序、去重、预算消费、归因 | 零 `vscode` import |
| `src/recovery/ledger.ts` | 账本读取、schema 校验、原子更新、revision/CAS、unclean 再入 | 零 `vscode` import |
| `src/recovery/fixExecutor.ts` | 生成 overlay、profile 托管块、文件 quarantine、预检、应用、还原 | 零 `vscode` import |
| `src/recovery/recoverySession.ts` | 状态机、取消、恢复续跑、终止性、与 Oracle/Variant/Fix 协调 | 零 `vscode` import |
| `src/recovery/diagnostics.ts` | 世代日志、轮转、redaction、组合 diff、诊断包目录导出 | 零 `vscode` import |
| `src/recovery/processIdentity.ts` | 跨平台进程出生签名和沙箱后代清理辅助 | 零 `vscode` import；复用现有 PID 复核纪律 |

### 4.2 VS Code 薄壳和现有文件改动

| 文件 | 改动位置 | 理由 |
| --- | --- | --- |
| `src/recovery/vscodeRecovery.ts` | 新增 | 把 `ExtensionContext.globalStorageUri`、OutputChannel、通知、clipboard、workspace root 适配给 core；只做 UI 和生命周期桥接 |
| `src/dshRuntime.ts` | `startInternal`、`launchAttempt`、`findExistingRuntime`、`scheduleRuntimeRecovery`、`terminate` | 复用现有启动/锁/认证路径；接收 RecoveryController 的启动计划；修复 F4；记录组合哈希和 boot journal |
| `src/runtimeLock.ts` | `RuntimeLockRecord` 和共享写入 | 增加可选 `compositionHash`、`recoverySessionId`、`runtimeStartSignature`；不改变现有锁抢占、死主收养和 PID 复用规则 |
| `src/runtimeProcess.ts` | 公开已有拥有进程清理能力，必要时抽出进程出生签名适配 | Oracle 和真实 Runtime 都遵守 owned spawn；Windows wrapper 退出后不猜测后代 |
| `src/runtimeMigration.ts` | 复用 `listenerIdentity` 的进程命令行/出生时间校验 | 仅用于确认沙箱残留或旧 Runtime 身份，不改变旧 Runtime 的确认门控 |
| `src/extension.ts` | Runtime 创建、命令注册、activation/reentry、dispose | 创建唯一 `RecoveryController`；把显式生命周期操作转为会话事件；注册恢复命令 |
| `src/types.ts` | `RuntimeState`、`RuntimeStatus`、ChatViewState 相关视图类型 | 让 webview 看见 recovering、recovered、unrecoverable 和操作按钮 |
| `webview/src/components/StatusBanner.tsx` | 状态分支 | 增加非阻塞恢复中信息、取消按钮、已恢复的详情/还原入口；保留现有错误 banner |
| `webview/src/state.ts`、`src/chatView.ts` | 状态序列化和 action 路由 | 将恢复摘要送到现有聊天面，不让 webview 自己执行文件修复 |
| `package.json` | contributes.commands、configuration、activationEvents | 暴露恢复开关和取消/详情/还原/导出命令 |
| `package.nls.json`、`package.nls.zh-cn.json`、`package.nls.zh-hans.json` | 新文案键 | 所有用户可见文案双语同步；zh-hans 继续由 `scripts/sync-locales.mjs` 派生 |
| `scripts/verify-recovery.mjs` | 新增进程级冒烟脚本 | 不添加单元测试；使用 mock vscode、真实子进程、mkdtemp 和隔离 DSH_HOME |

不在本批改动中的文件：`sessions/`、`storages/`、工作区文件、DSH 安装目录、用户 `.env` 和 `.credentials.yaml`。

## 5. 数据结构和不变量

以下是 TypeScript interface 级设计，不是实现代码。

### 5.1 组合描述

组合描述必须能回答“这一次 boot 具体使用了什么”，但不能把秘密值放进诊断包。

```ts
export type PatchLayerKind =
    | "bundle"
    | "profile-user"
    | "home-user"
    | "extension-overlay"
    | "recovery-overlay"
    | "telemetry-derived";

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
    path?: string;
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

export interface EnvironmentSurface {
    cwd: string;
    dshHome: string;
    platform: NodeJS.Platform;
    arch: string;
    nodeVersion: string;
    inheritedNames: readonly string[];
    presentSensitiveNames: readonly string[];
    fileLayers: readonly FileFingerprint[];
    stableValuesHash: string;
}

export interface RuntimeBinaryDescriptor {
    command: string;
    resolvedPath?: string;
    source: "path" | "npm-prefix" | "pnpm" | "npx" | "managed" | "explicit" | "unknown";
    version?: string;
    packageHash?: string;
    launcherArgs: readonly string[];
}

export interface CompositionDescriptor {
    schemaVersion: 1;
    profile: string;
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
```

组合 hash 的规范化规则：

- 保留 patch 层的真实应用顺序；不按文件名排序。[F14]
- `--port 0` 归一化为动态端口占位符，避免每次 Oracle 生成不同 hash；固定端口则保留。
- 绝对路径使用规范化、大小写规则和分隔符规则；路径只用于当前机器诊断，不作为恢复源。
- 普通文件用 SHA-256；`.env`、`.credentials.yaml` 和任何命中 secret 规则的值使用安装级随机盐 HMAC，只保存“已存在”和 keyed fingerprint，不输出原文。[F13][D1]
- 不纳入 sessions、storages、日志内容、时间戳、随机 port、cookie 和 launch token。[F15][F16]
- hash 只标识组合，不暗示组合正确；只有真实 boot 健康后才写入 `last-known-good`。[D8]

### 5.2 健康证据

```ts
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
```

`outputTail` 在进入 core 之前和写盘之前都经过相同的 redaction；原始 chunk 不进入账本、诊断包或 OutputChannel。[F6][P8]

### 5.3 健康仲裁器接口

```ts
export interface HealthOracle {
    evaluate(
        composition: CompositionDescriptor,
        options?: {
            variantId?: string;
            signal?: AbortSignal;
            logSink?: BootLogSink;
        },
    ): Promise<HealthEvidence>;
}

export interface BootLogSink {
    beginBoot(input: {
        generationId: string;
        bootId: string;
        variantId: string;
        compositionHash: string;
    }): Promise<{
        path: string;
        append(stream: "stdout" | "stderr" | "meta", text: string): Promise<void>;
        finish(summary: HealthEvidence): Promise<void>;
    }>;
}
```

接口本身不暴露 `vscode`、全局 runtime lock、用户 session 或上次 Oracle 进程。一次 `evaluate` 结束后，除日志 sink 返回的证据外不保留进程状态。[A1][D10]

### 5.4 变体、预算和归因

```ts
export type VariantKind =
    | "v1-reproduce"
    | "v3-all-user-bundles-removed"
    | "v3-bundle-half-added"
    | "v3-confirm-culprit"
    | "v4-extension-overlays-removed"
    | "v2-static-yaml"
    | "v5-environment";

export interface CompositionVariant {
    id: string;
    kind: VariantKind;
    parentHash: string;
    assumption: string;
    bundleSelection?: readonly string[];
    removedOverlayPaths?: readonly string[];
    staticChecks?: readonly string[];
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
    machineSummary: {
        v1: "pass" | "fail" | "not-run";
        baseline: "pass" | "fail" | "not-run";
        readdResults: readonly Array<{
            bundleIds: readonly string[];
            verdict: HealthVerdict;
        }>;
        confirmation: "pass" | "fail" | "not-run";
        monotonicityAssumed: boolean;
    };
}

export interface VariantEngine {
    next(
        composition: CompositionDescriptor,
        budget: RecoveryBudget,
        history: readonly HealthEvidence[],
    ): Promise<CompositionVariant | undefined>;

    explain(
        variant: CompositionVariant,
        evidence: readonly HealthEvidence[],
    ): Attribution | undefined;
}
```

### 5.5 候选修复和账本

```ts
export type CandidateFixKind =
    | "disable-entry-overlay"
    | "remove-extension-overlay"
    | "disable-profile-bundles"
    | "quarantine-file";

export interface RestoreInstruction {
    kind: "remove-file" | "restore-file" | "restore-json" | "remove-managed-overlay";
    target: string;
    expectedHash?: string;
    displayCommand: string;
    requiresConfirmation: boolean;
}

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
    overlayPath?: string;
    restore: RestoreInstruction;
}

export type LedgerEntryStatus =
    | "planned"
    | "applied"
    | "verified"
    | "reverted"
    | "conflicted"
    | "manual-required";

export interface RecoveryLedgerEntry {
    entryId: string;
    generationId: string;
    fix: CandidateFix;
    status: LedgerEntryStatus;
    reason: {
        variantId: string;
        category: string;
        humanSummary: string;
        createdAt: string;
        appliedAt?: string;
        revertedAt?: string;
    };
    before: Readonly<Record<string, FileFingerprint>>;
    after?: Readonly<Record<string, FileFingerprint>>;
    restoreCommand: RestoreInstruction;
    verifiedCompositionHash?: string;
    lastError?: string;
}

export interface LastKnownGood {
    compositionHash: string;
    runtimeVersion: string;
    profile: string;
    recordedAt: string;
    source: "real-runtime-boot";
    generationId: string;
}

export interface RecoveryLedger {
    schemaVersion: 1;
    revision: number;
    clean: boolean;
    activeSessionId?: string;
    lastRuntimeBoot?: {
        state: "starting" | "running" | "stopped" | "unclean";
        ownerId?: string;
        compositionHash?: string;
        startedAt: string;
        finishedAt?: string;
    };
    lastKnownGood?: LastKnownGood;
    entries: readonly RecoveryLedgerEntry[];
    pendingCleanup: readonly string[];
}
```

账本不变量：

- `clean=false` 必须在第一项修复或启动 journal 写入前落盘；任何进程中断都能触发再入。[D4][D6]
- `planned` 表示“准备执行但尚未确认文件变化”；激活时先检查实际文件身份，再决定标记 `applied`、回滚或进入 `manual-required`。
- `verified` 只有在修复后实际 Runtime 健康、组合 hash 已记录为 LKG 后才允许写入。
- `restoreCommand` 是结构化、显示用的还原计划；不得把未经转义的用户路径直接拼成可执行 shell 字符串。
- 账本写入使用 revision 和原子替换。读到的 revision 已改变时，当前窗口放弃应用，不覆盖另一窗口的记录。

## 6. HealthOracle 沙箱构建

### 6.1 目录布局

每次 boot 使用新的临时目录：

```text
<temp>/dsh-recovery-<session>-<boot>/
  cwd/
  home/
    settings.yaml
    .env                    # 如需复现，按秘密文件策略复制
    .credentials.yaml       # 如需复现，按秘密文件策略复制
    cordis.patch.yml
    profiles/
      node_modules/         # 沙箱真实目录，逐项 link/proxy
      web/
        package.json
        cordis.patch.yml
        cordis.yml
        pnpm-lock.yaml
        pnpm-workspace.yaml
        node_modules/       # 沙箱真实目录，逐项 link
        .dsh-module-fallback/
          node_modules/     # 沙箱真实目录，逐项 link
  overlays/
```

不复制：

- `home/sessions/`、`home/storages/`、`.dsh-market` 和无关运行期目录。[F15]
- 用户文件内容和完整环境值进入诊断包。
- 整个 `profiles/node_modules` 或 `profile/node_modules` 的目录 junction。

### 6.2 小文件复制和秘密策略

复制白名单来自当前组合描述，不做“复制整个 home”：

- profile `package.json`、profile `cordis.patch.yml`、`cordis.yml`、pnpm 元数据；
- home `settings.yaml`、home `cordis.patch.yml`；
- 当为了 boot fidelity 必须读取时，`.env` 和 `.credentials.yaml` 作为 opaque file 复制到沙箱，权限设为仅当前用户可读；
- project cwd 的 `.env` 复制到 `sandbox/cwd/.env`，而不是把真实 workspace 作为 DSH cwd；
- 文件内容只参与 keyed fingerprint，永不写入 `HealthEvidence`、ledger 或诊断包。[F13][D1]

如果未来证明 boot 不需要 credentials 文件，v1 可以改为只传“文件存在”而不复制内容；这应通过进程级验收确认，不靠假设。

### 6.3 node_modules 物化规则

1. 沙箱创建真实的 `node_modules` 父目录。
2. 对源目录下每个一级 package entry，读取 link 目标但不递归复制整个包。
3. Windows 使用 junction 或文件 symlink 的逐项重建，POSIX 使用 symlink；目标包目录保持源安装目录，link 本身属于沙箱。
4. `.dsh-module-fallback/node_modules` 和 profile `node_modules` 分别物化，不能共同指向真实父目录。
   > **实现修正（2026-09-12，回应 PR #19 审查意见 F8）**：v1 实现把整个 home 用 `$DSH_HOME` 整体重定向进沙箱（`dsh-home-paths` 的 `resolveDshHome()` 以 `$DSH_HOME` 为最高优先级，非空白即生效；`DSH_HOME`/`HOME`/`USERPROFILE` 三者全部指向沙箱 home），因此 `healProfilesModuleFallback` 与 `healProfileModuleFallback` 里 `join(home, …)` / `join(profile.dir, …)` 的父目录**按构造就在沙箱内**，两个 fallback 目录即使不预物化也不会落到真实 home——invariant 不依赖预物化成立。已用实测探针确认真实 home 零改动。预物化规则保留为「若未来改用部分重定向」时的强制要求。
5. DSH 启动的 `healProfilesModuleFallback` 因此只会在沙箱父目录中创建、替换、删除 link/proxy；它仍能读取真实安装包代码，但不能改变源目录的 link 拓扑。[F13][DSH_CRASH_RECOVERY_SOURCE_REVIEW.md 第 4 节]
6. 若发现源目录是普通目录而不是可安全映射的包 entry，按 package 粒度复制该 entry 或返回 `sandbox-error`；绝不退化为整个目录 junction。
7. Oracle 结束后先终止 DSH，再删除 sandbox；若 Windows 文件占用导致删除失败，先清理秘密文件，登记 `pendingCleanup`，不继续下一变体。

### 6.4 cwd、环境和启动参数

- 子进程 cwd 设置为 `sandbox/cwd`，避免插件把工作区根当成真实用户目录写入；cwd 的 `.env` 仍按实际存在性复制。[F13][DSH_CRASH_RECOVERY_SOURCE_REVIEW.md 第 5 节]
- 子进程继承启动所需的 `PATH`、Node 运行环境和非秘密 bootstrap 配置；强制覆盖 `DSH_HOME=sandbox/home`、`TMP/TEMP` 到沙箱临时目录。
- `DSH_HOME` 必须由父进程环境设置，不能放入 `.env`，因为 DSH 将 `DSH_` 变量视为 bootstrap-only。[F9][DSH_CRASH_RECOVERY_SOURCE_REVIEW.md 第 5 节]
- 默认启动形态是 `--profile web` 或 `web`，端口始终为 `0`，host 固定 `127.0.0.1`，并带 `--no-open`。[F11][DSH_CRASH_RECOVERY_SOURCE_REVIEW.md 第 6 节]
- `--patch` 是重复单值参数，必须在 DSH 自己停止解析前插入。与现有 `insertWebLauncherPatch` 相同，放在 `web` 后、首个 web app 参数前；恢复 overlay 放在已有 extension overlay 之后，保证后层覆盖前层。[F14][src/dshRuntime.ts:715-745]
- Oracle 不继承固定的用户端口；如果原组合强制固定端口，V1 记录为环境差异并在沙箱中优先改为 `0`，不把动态端口写进 hash。

### 6.5 Windows wrapper 和清理

优先顺序：

1. 能解析到本机 DSH 包时，Oracle 使用直接 Node entrypoint 启动，减少 `cmd.exe` wrapper 的不可追踪后代。
2. 必须使用 `.cmd`、`npx` 或 `pnpm` 时，继续使用 `spawnOwnedRuntime`，并记录 wrapper PID、命令、启动时间和沙箱 `DSH_HOME`。
3. wrapper 已退出时，`RuntimeDescendantOwnershipUnknownError` 不能被转换成普通启动错误。只有通过 listener PID、出生时间、命令行和沙箱 `DSH_HOME` 四项身份同时确认，才允许清理残留；否则记录 `descendantOwnership=unknown`，停止搜索并保留路径供诊断。[F3][F4][runtimeProcess.ts:75-104][runtimeMigration.ts:30-67]
4. 清理顺序为：停止健康探针、终止拥有进程、确认端口拒绝连接、删除秘密文件、删除沙箱目录。任何一步失败都进入 `sandbox-cleanup`，不把这次结果当成可应用修复。

### 6.6 Oracle 的健康判定

健康检查复用现有语义，不发起模型请求：

1. 从 stdout 的启动 URL 获取 loopback base URL 和 launch token；没有 URL 时使用已知 `127.0.0.1:<dynamic port>`。
2. 访问带 token 的 launch URL，要求 `303` 和 `Set-Cookie`；cookie 只在本次 Oracle 内存中使用。[F16][DSH_CRASH_RECOVERY_SOURCE_REVIEW.md 第 6 节]
3. 向 `/api/session/list` 发送 RC Remote v1 的 `POST`，payload 为 `{ args: { _request: {} } }`，校验 HTTP、JSON envelope、rpcId。
4. `401/403` 归为 auth/protocol 证据，不归因于插件；网络连接超时归为 unhealthy 或 timeout。
5. 在进程仍存活且探针通过时记录 `healthy`，随后清理。Oracle 的“健康”代表该组合能 boot，不代表它已经成为真实用户 Runtime。

## 7. VariantEngine 变体策略

### 7.1 总预算

默认每个 RecoverySession 最多 8 次 Oracle boot；每次 Oracle 的 readiness 上限沿用 `startupTimeoutMs`，包管理器不进入恢复搜索，建议硬上限 30 秒。若用户把启动超时调得更大，恢复预算仍由 8 次和单次 30 秒上限约束。[A6][Q5]

预算保留：

| 保留项 | 次数 | 说明 |
| --- | ---: | --- |
| V1 | 1 | 原组合复现 |
| V3 | 1 + `ceil(log2(n))` + 1 | `n` 为用户 bundle 数；首个为全移除基线，最后为确认 |
| V4 | 1 | 移除扩展附加层 |
| 机动 | 剩余 | 处理重试、冲突或低 n 的额外确认 |

若公式超过 8 次，先记录预算不足，按最有区分度的顺序截断，不动态增加上限。已由 `compositionHash` 证伪的变体永不重跑。[A6]

### 7.2 V1 原组合复现

假设标签：`transient-or-existing-composition`.

- 使用原始 profile bundle 顺序、profile/home patch、所有 extension overlay 和环境面。
- 如果 V1 通过，结论是瞬态或非扩展可归因故障；不应用修复，只记录 LKG 和清理当前恢复 session。
- 如果 V1 的失败是认证配置、远程 URL、版本不匹配或沙箱构建错误，直接终止搜索，避免把环境错误误判成坏插件。
- 证据：退出码、signal、stderr 尾部、第一次 URL、RPC HTTP 状态、总时延。[F17]

### 7.3 V3 bundle 集合收缩

V3 只把 profile `dsh.profile.bundles` 中的用户 bundle 作为候选。安装自带的 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app` 等 installation-owned bundle 默认保留；无法确定 origin 的 bundle 不自动移除。

算法：

1. 在沙箱 profile `package.json` 中建立用户 bundle 集合 `U`，不修改真实文件。
2. 生成 `U=empty` 的 profile manifest，启动基线。
3. 若基线仍失败，V3 不再声称用户 bundle 是根因，转到 V4 或终止。
4. 若基线通过，将 U 对半分，逐次回加一半；失败的一半继续二分，成功的一半作为候选非必要集合。
5. 对最终候选集做一次“回加确认”：移除候选集应通过，恢复候选集应失败，且两次 failure class/输出分类相容。
6. 仅在源 profile 内容 fingerprint 在搜索期间没有变化时输出 `high` 置信度。

V3 的人类输出示例：

```text
候选 bundle @example/plugin-x：原组合启动失败；移除全部用户 bundle 后通过；
二分回加后仅重新加入 @example/plugin-x 会失败；移除它的确认 boot 通过。
归因：高置信度的 bundle 激活故障。已验证 5/8 次 boot。
```

机器输出必须包含每一次集合和 hash，不能只保留“最终猜测”。[P5]

限制：

- 二分依赖“加入更多 bundle 不会把失败变成成功”的单调性。两个插件只有同时存在才失败时，结果可能是集合级线索而不是数学最小致坏集；`monotonicityAssumed=true` 必须进入诊断。
- bundle patch 文件仍会在选择阶段解析；如果 bundle 本身的 patch 读取就失败，V3 可能在 `U=empty` 时暴露 profile manifest 或 patch 层问题，应按证据分类。
- `dsh.profile.bundles` 缺包、bundle-less 或 link 解析失败时，变体是 `unhealthy`，不是成功的“禁用”。

### 7.4 V4 剥扩展附加层

V4 从组合中移除扩展拥有的 patch 文件，首要目标是现有 compaction overlay。它不删除 profile/home 用户文件。

- 如果移除后健康，候选修复是“不再注入 extension overlay”，而不是改用户 patch。
- 如果已有同 id 的用户层 entry 仍存在，则可额外生成后置 `disabled: true` overlay；只有 id 命中时才算应用成功。[DSH_CRASH_RECOVERY_SOURCE_REVIEW.md 第 1、2 节]
- V4 的证据必须列出被移除的 path、文件 hash 和 entry id；不能把所有 `--patch` 统称为扩展层。

### 7.5 v2 V2/V5

- V2 静态 YAML：只解析并定位文件、行号和错误，不执行 `!!js`；可使用 DSH 的 parser 或 `dump-config` 逻辑，但只能在沙箱中运行，因为 dump path 仍会重写 `cordis.yml`。[F10][DSH_CRASH_RECOVERY_SOURCE_REVIEW.md 第 8 节]
- V5 环境对照：比较 `--version`、启动器真实路径、包 manifest/lock 和 allowlisted environment；归因后不自动重装、不修改 registry、不替换依赖。
- V2/V5 的证据可以缩小搜索，但不增加 v1 的自动修复权限。[D5]

## 8. RecoverySession 状态机

### 8.1 对外状态

```text
DETECTED
  -> SEARCHING
  -> CANCELLED
  -> UNRECOVERABLE

SEARCHING
  -> SEARCHING       下一变体
  -> FIX_APPLIED     找到沙箱通过的候选修复
  -> CANCELLED       用户取消或显式生命周期操作接管
  -> UNRECOVERABLE   预算用尽、账本/沙箱不可用或无候选

FIX_APPLIED
  -> SEARCHING       真实启动失败，回滚当前无效修复并尝试下一候选
  -> RECOVERED       真实 Runtime 健康且安全谓词成立
  -> UNRECOVERABLE   修复无法复验、文件冲突或剩余预算不足
  -> CANCELLED       用户取消；保留已应用的有效隔离

RECOVERED / UNRECOVERABLE / CANCELLED
  -> DETECTED        之后出现新的失败或新的 unclean journal
```

内部可以有 `VERIFYING` 子阶段，但不把它暴露成新的公共状态，避免 UI 和持久 schema 无限增长。

### 8.2 转移守卫

| 当前 | 事件 | 守卫 | 动作 |
| --- | --- | --- | --- |
| `DETECTED` | 启动搜索 | `enabled && ledgerReadable && workspaceAvailable && acquireRecoveryLease` | 写 `clean=false`，创建 generation，进入 `SEARCHING` |
| `DETECTED` | 健康 Runtime 被收养 | hash 匹配且账本可解释 | 写 LKG、`clean=true`，直接 `RECOVERED` |
| `SEARCHING` | Oracle 通过 | 有候选 fix 且预算未超 | 记录证据，进入 `FIX_APPLIED` |
| `SEARCHING` | Oracle 失败 | 仍有未测试变体 | 记录证据、消费预算、继续 |
| `SEARCHING` | 无变体/预算封顶 | `usedBoots >= maxBoots` 或策略停止 | 输出归因和诊断，进入 `UNRECOVERABLE` |
| `FIX_APPLIED` | 修复预检失败 | 源 hash、进程存活或 ledger revision 不匹配 | 不写用户文件，进入 `UNRECOVERABLE` 或下一变体 |
| `FIX_APPLIED` | 修复后真实 boot 成功 | process live && `isHarnessHealthy` && current hash == LKG hash && ledger consistent | 标记 entry `verified`、`clean=true`、进入 `RECOVERED` |
| 任意非终态 | 取消 | `AbortSignal` 或用户取消命令 | 停止 Oracle/子进程；保留已验证隔离，写取消原因 |

### 8.3 终止性

每个变体的 `compositionHash` 只能进入 history 一次；预算上限为 8；每次 boot 有有限 readiness timeout，且所有异步结果检查 session generation 和 abort signal。状态图中没有无条件回边，因此一个 session 要么 `RECOVERED`，要么 `UNRECOVERABLE`/`CANCELLED`。[A4][A6]

### 8.4 与现有并发字段的关系

| 现有字段 | 规则 |
| --- | --- |
| `startPromise` | Oracle 和真实 Runtime 不共用同一 promise。恢复控制器只能通过一个 `RuntimeLaunchAdapter` 调用 start；同一窗口的第二次 start 返回既有 promise |
| `stopPromise` | `stop()` 先取消恢复 generation 和 Oracle，再沿用现有 bounded stop；恢复不在 stop 未完成时抢锁 |
| `startAbort` | 显式 `stop/restart` 先 abort 当前真实启动；RecoverySession 的 abort 另外维护，二者通过 adapter relay |
| `runtimeRecoveryGeneration` | 继续保护现有 1s/5s/15s raw retry；RecoverySession 有自己的 `sessionGeneration`，两者都必须匹配才允许回调改变状态 |
| `runtimeRecoveryInFlight` | raw retry 和 RecoverySession 互斥。raw retry 结束且三次失败后才创建 session；session 存在时不再 schedule raw retry |
| `resourceCleanupDepth` | 只有真实 Runtime 生命周期使用；Oracle 有独立 cleanup depth，不触发真实 Runtime 的 unexpected-exit recovery |

## 9. 与既有启动和恢复循环挂接

### 9.1 启动路径

当前关键点：

- `startInternal` 先检查信任、远程 URL、已有本窗口 Runtime，然后调用 `findExistingRuntime`，再发现 launcher、获取共享锁、注入 compaction patch、启动 child。[src/dshRuntime.ts:2231-2457]
- `launchAttempt` 负责 spawn、输出 tail、ready 等待和锁 URL 发布。[src/dshRuntime.ts:2458-2607]
- `findExistingRuntime` 会读取共享锁、认证并调用 `isHarnessHealthy`，之后才扫描固定端口。[src/dshRuntime.ts:2817-2863]

改造：

1. 在 `startInternal` 开始阶段读取 `RecoveryLedger` 的 active overlay、managed bundle block 和 planned composition。
2. 保留 `findExistingRuntime` 的第一顺序。若已有 Runtime 带匹配 `compositionHash` 且健康，直接收养；若 ledger unclean 但 hash 不明，记录 ambiguous adoption，不杀进程。
3. 由 `CompositionBuilder` 生成本次实际启动计划，包括 recovery overlay、需要抑制的 extension overlay 和有效 bundle list；扩展自身的 compaction patch 仍由现有逻辑生成，但 V4 变体可以通过 `suppressExtensionOverlayPaths` 明确禁止本次注入。
4. 把 `startInternal` 的 launcher args 传入 `RecoveryController`，由 Controller 在失败时使用同一组合构造 Oracle，不自行重新猜测 command、profile 或环境。
5. Runtime lock 发布时写入 `compositionHash`、`recoverySessionId`、`runtimeStartSignature`，不改变原有 ownerId、runtimePid、runtimeProcess 和 URL 语义。

建议的内部启动计划接口：

```ts
export interface RuntimeLaunchPlan {
    composition: CompositionDescriptor;
    recoverySessionId?: string;
    recoveryOverlayPaths: readonly string[];
    suppressExtensionOverlayPaths: readonly string[];
    managedBundleExclusions: readonly string[];
    source: "user" | "raw-retry" | "recovery";
}
```

### 9.2 F4 P0 修复

当前 `launchAttempt` catch 在等待 ready 失败后直接 `await this.terminate(child)`；Windows wrapper 已退出时可能抛 `RuntimeDescendantOwnershipUnknownError`，导致真实 `RuntimeLaunchFailure(outputTail, cause)` 没有机会抛出。[src/dshRuntime.ts:2576-2607][F4]

第一批必须改为以下语义：

```text
primaryFailure = waitForReady/launchError/abort 产生的原始错误
cleanupFailure = 尝试 terminate(child) 的错误

如果 cleanupFailure 是“已退出 wrapper，后代归属未知”：
    记录清理不确定性
    仍以 primaryFailure 作为 RuntimeLaunchFailure 的 cause
否则如果 cleanupFailure 存在：
    记录两个错误
    primaryFailure 仍然是顶层启动原因
    只有 child 仍被证明存活且不能清理时，保留 lock 并进入错误/诊断态
```

`RuntimeLaunchFailure` 建议增加可选的 `cleanupError` 和 `cleanupOwnership` 字段，但 `message` 首先呈现 DSH stderr/output tail 的真实原因。该修复必须由 F4 专项冒烟脚本验收。

### 9.3 意外退出映射

现有 `scheduleRuntimeRecovery` 的三次 raw retry 保留：

1. `ready=true` 后 child exit，进入现有 `handleUnexpectedRuntimeExit`。
2. 第 1/2/3 次按 1s、5s、15s 原样启动，不带 bundle 搜索变更；每次启动都使用当前有效 ledger overlay。
3. 任一次健康成功，清零 raw retry 次数，更新 boot journal 和 LKG。
4. 三次都失败，调用 `RecoveryController.begin({ kind: "unexpected-exit", evidence })`，不再把“请手工 restart”作为终止结果。
5. boot 期未 ready 的 `RuntimeLaunchFailure` 不走三次 ready-exit 循环，直接进入恢复 session；V1 仍会排除瞬态。

### 9.4 先收养再搜索

`RecoveryController.begin` 的第一步固定为：

```text
read ledger and boot journal
findExistingRuntime(configuredPort)
if healthy and composition evidence matches:
    adopt -> verify safe predicate -> RECOVERED
else:
    do not kill an ambiguous runtime
    acquire recovery lease
    start SEARCHING
```

如果健康孤儿无组合 hash，且它占有共享 Runtime lock，搜索不会为了“自动化”而击杀它；诊断中记录 PID、端口、锁版本和 hash 缺失原因。若它随后退出，下一次 acquisition 再继续。这个限制由 D4、D5 和现有 PID 复用纪律共同决定。[F5][runtimeLock.ts:80-111]

## 10. 修复执行和复验

### 10.1 阶段 1：recovery overlay

适用：entry 已存在、问题属于 extension-owned overlay 或可证明的 entry disabled。

流程：

1. `VariantEngine` 产生候选 entry ids 或要移除的 extension overlay path。
2. `FixExecutor` 生成 globalStorage 下的稳定 patch 文件，例如 `recovery/overlays/<entryId>.patch.yml`，内容只包含命中的 `id` 和 `disabled: true`。
3. ledger 先写 `planned`，包含文件 hash、原因、variantId、还原计划。
4. 在新的沙箱中以“当前组合 + recovery overlay”再 boot；未通过则不碰真实 Runtime。
5. 沙箱通过后把 entry 标为 `applied`，真实 Runtime 停止且没有 live listener 时才允许重新启动。
6. 真实启动健康后标为 `verified`。overlay 文件保留，后续每个扩展启动都从 active ledger 注入，直到用户还原或新账本替代。[D9]

现有 compaction patch 是一次性临时文件，路径在 `tmpdir()`；恢复 overlay 不放在 tmp，因为 VS Code 进程崩溃后需要下次激活继续注入。两者顺序为：用户层、现有 compaction extension overlay、recovery overlay，后者优先。[src/dshRuntime.ts:2394-2407][F14]

### 10.2 阶段 2：profile 托管块

适用：V3 二分已定位用户 bundle，且必须从 `dsh.profile.bundles` 中移除才能避免 bundle patch/import。

推荐的持久形式：

- 在 profile `package.json` 增加扩展拥有的 `dsh.recovery` 元数据，记录被隔离 bundle 的原始顺序和原始 manifest hash；
- 同时把 `dsh.profile.bundles` 写成“原数组去掉被隔离项”的有效数组，使 DSH 原生 loader 真正不解析该 bundle；
- 不删除 dependency，不动 pnpm lock，不移动 sessions/storages；
- DSH `plugin` 命令未来可能根据已安装依赖重新 reconcile bundle list，因此每次扩展启动在 Runtime 未启动前检查 managed block；若发现被隔离项被重新加入，记录 composition drift，不覆盖用户新改动，等待新的搜索/诊断。

原子写入条件：

1. runtime lock 没有健康 listener，扩展拥有的 child 已确认结束；
2. profile `package.json` 当前 hash 等于搜索时的 before hash；
3. 账本 revision 仍等于读取时的 revision；
4. 写入前在 ledger 中记录原始 bytes hash 和恢复数组；
5. 写入临时文件后同目录 rename；写入后立即重新读取、解析并验证 bundle list；
6. 真实启动前先在沙箱用有效 profile manifest boot；失败则恢复原文件，不进入真实启动。

阶段 2 是可逆的用户文件修改，不是“无害覆盖层”。因此 v1 只在下节推荐的高置信度条件满足时自动执行；否则保留阶段 1/诊断并进入 `UNRECOVERABLE`。[D5][D9][Q3]

### 10.3 文件改名隔离

适用：v2 V2 静态解析明确定位单个坏 patch 文件，且没有更小的 overlay/bundle 变体。

- 只对 `cordis.patch.yml` 等允许的配置文件执行同目录 rename，目标形如 `<name>.quarantine.<generationId>`。
- rename 前检查运行时已死、listener 已拒绝、`lstat` 身份和 contentHash 未变化；Windows 文件占用失败时不强杀不明进程，写 `manual-required`。
- 原文件不删除；ledger 同时保存原路径、隔离路径、before/after fingerprint 和结构化 restore instruction。
- 不改名 `cordis.yml`，因为 DSH 每次 boot 会重写它。[F13]
- v1 不自动隔离无法被静态定位的用户文件；避免把“能启动”误当成“知道哪个用户文件应该丢到 quarantine”。[D5]

### 10.4 一键还原

`dsh.recovery.restore` 只允许用户显式触发：

1. 停止当前 Runtime，取消搜索。
2. 按 ledger entry 的逆序处理；每一步先比较 after hash，变化过的文件标为 `conflicted`，不覆盖。
3. 删除 recovery overlay、恢复 profile bundle 原顺序或把 quarantine 文件移回原名。
4. 写入新的 ledger revision，`clean=false`，然后启动标准组合。
5. 标准组合健康后清空 active entries、记录新 LKG、`clean=true`；失败则创建新的检测事件，不自动把还原再反向覆盖回去。

## 11. 账本、并发窗口和会话续跑

### 11.1 物理布局

```text
<globalStorageUri>/
  recovery/
    ledger.json
    ledger.mutation
    sessions/
      <generationId>.json
    overlays/
      <entryId>.patch.yml
    diagnostics/
      <exportId>/
    pending-cleanup.json
  logs/
    <generationId>/
      manifest.json
      boot-001-v1.log
      boot-002-v3-base.log
      ...
```

只在 globalStorage 保存小型账本、组合摘要和受限日志；不把 node_modules、sessions、storages 复制到 C 盘。[F8][F15]

### 11.2 多窗口协调

- `ledger.mutation` 使用和 `mutateRuntimeLock` 相同的 `open wx`、ownerId、contents/identity 检查和 fail-closed 原则；不要用“读后 unlink”冒充互斥。[runtimeLock.ts:114-151]
- 正常情况下只有一个窗口持有 recovery lease。其他窗口读取 ledger，看到 active session 后只监听 revision，不启动第二个 Oracle，不应用第二份 fix。
- 应用修复前进行 ledger revision CAS；窗口 A 获胜后，窗口 B 的写入失败并重新读取，若发现同一 composition hash 已测试则放弃。
- 运行时实际启动仍由共享 `dsh-runtime.lock` 串行化；recovery lease 不取代 Runtime lock。
- lease owner 进程崩溃后，按 PID + process start signature 判断是否已退出；无法证明时保留 mutation 文件并进入诊断态，不删除未知 owner 的 guard。可确认的 stale guard 才能在同一 identity 检查下回收。[F5][D5]

### 11.3 账本损坏

- JSON、schemaVersion、revision 或 entries 任一失败，原文件保留，不重写、不自动清空。
- 只读模式生成诊断摘要，状态为 `UNRECOVERABLE`，原因 `ledger-corrupt`；不应用 profile 改名、bundle 删除或 overlay。
- 下一次运行仍可由用户导出原 ledger；v2 repair CLI 提供带备份的人工重建。

## 12. 日志固化和诊断包

### 12.1 日志

每个 RecoverySession 获得一个 generation id，Oracle 的每次 boot 都有独立文件。日志内容：

- `meta`：variant、compositionHash、启动器来源、profile、argv 的 redacted 版本、时间和耗时；
- stdout/stderr：经 streaming redaction 的全量输出，达到上限后保留尾部并标记 `truncated=true`；
- probe：认证状态、HTTP 状态、rpcId、协议解析结论；
- cleanup：child、listener、sandbox cleanup 结果。

推荐限制：[Q5]

- 每个 generation 总上限 2 MB；
- 每 generation 至少保留最后 32 KB 的 stdout/stderr 尾部；
- 保留最近 5 个 generation，删除前确认路径位于 `globalStorage/logs`；
- 当前运行中的 generation 不轮转；达到上限只丢弃较早的中间 chunk，不丢 meta、最后失败证据和 cleanup 结果。

Redaction 规则：

- URL 中 `token=`、`access_token=`、`auth=` 等值替换；
- `Authorization`、`Cookie`、`Set-Cookie`、Bearer/API key/secret/password/credential 行替换；
- 命令参数沿用现有 `redactArguments` 规则；敏感变量只记录 name 和 set/unset；
- `.env`、`.credentials.yaml` 永远不作为诊断文件复制，也不把文件内容拼到输出；
- 发现疑似 secret 的长 token 时按保守规则替换；误删一小段日志优于泄露凭据。[D1][F6][P8]

### 12.2 诊断包

一键导出写入：

```text
<globalStorageUri>/recovery/diagnostics/<exportId>/
  manifest.json
  conclusion.md
  ledger.json
  composition-current.json
  composition-last-known-good.json
  composition-diff.json
  runtime-info.json
  logs/
    <最近 5 个 generation 的受限副本>
```

包含：

- 最近 5 个 generation 的日志和每次 boot 的 verdict；
- 当前 ledger、active session、预算、已跳过变体和归因；
- 当前组合与 LKG 的结构化 diff，仅 hash、路径、bundle/entry 元数据；
- DSH/扩展/Node/VS Code/平台版本，启动器来源，是否为 Windows wrapper；
- 清理失败路径、PID 证据和待人工动作。

不包含：

- `.env`、`.credentials.yaml`、cookie、launch token、API key；
- sessions/storages、node_modules 内容、用户工作区源文件；
- 未经 redaction 的 patch 原文。

VS Code 命令 `dsh.recovery.exportDiagnostics` 导出目录并复制目录路径到 clipboard，同时在 OutputChannel 输出相同路径。v1 不强依赖 zip 工具，目录本身就是诊断包，避免引入依赖和跨平台压缩差异。[D5][P9]

## 13. UI、命令和配置草案

### 13.1 状态展示

建议扩展现有 `RuntimeStatus`：

```ts
export type RuntimeState =
    | "stopped"
    | "starting"
    | "running"
    | "recovering"
    | "error";

export interface RecoveryStatusView {
    sessionId: string;
    phase: "detected" | "searching" | "fix-applied" | "recovered" | "unrecoverable" | "cancelled";
    usedBoots: number;
    maxBoots: number;
    currentVariant?: string;
    summary?: string;
    canCancel: boolean;
    canRestore: boolean;
    canExportDiagnostics: boolean;
}

export interface RuntimeStatus {
    state: RuntimeState;
    url?: string;
    message?: string;
    recovery?: RecoveryStatusView;
}
```

webview 行为：

- `recovering`：信息级 banner，显示“正在自动恢复（已使用 n/8 次）”，提供取消和详情；不弹 modal，不阻塞编辑器。
- `recovered`：信息级通知，显示隔离了哪些 bundle/overlay，提供“还原修复”和“查看详情”；用户可以忽略。[Q2]
- `unrecoverable`：警告 banner，显示“自动恢复未完成”，提供“导出诊断包”“打开日志”，不自动把已验证隔离回滚。
- `cancelled`：显示已取消且保留哪些隔离；不把 cancel 当作系统故障。
- 现有 `StatusBanner` 的 runtime error 分支保留；recovering 使用 `role=status`，不抢占普通错误语义。[src/webview/src/components/StatusBanner.tsx:7-45]

### 13.2 命令

建议新增：

| command | 用途 | 是否命令面可见 |
| --- | --- | --- |
| `dsh.recovery.cancel` | 取消当前搜索，保留已应用的有效隔离 | 可见 |
| `dsh.recovery.openDiagnostics` | 打开当前 session 详情和日志 | 可见 |
| `dsh.recovery.exportDiagnostics` | 导出诊断包并复制路径 | 可见 |
| `dsh.recovery.restore` | 显式还原已应用修复 | 可见 |

`dsh.restart` 在恢复期间的语义：先发送“显式生命周期操作接管”取消 session，再执行 stop -> start；不允许恢复回调在手工 restart 后修改状态或释放新 Runtime 的锁。[Q1][P13]

### 13.3 配置

建议只暴露必要配置，预算硬上限不能被用户调大：

| setting | 默认 | 约束 |
| --- | --- | --- |
| `dsh.recovery.enabled` | `true` | 关闭后保留日志和诊断，但 boot 失败只走现有错误路径 |
| `dsh.recovery.maxBootsPerSession` | `8` | 允许 1-8；只能降低，不允许超过安全封顶 |
| `dsh.recovery.logRetentionGenerations` | `5` | 允许 1-5；当前 generation 不删除 |
| `dsh.recovery.autoPersistBundleIsolation` | `true` | v1 只在 Q3 的高置信度条件满足时生效；关闭后只用 overlay/诊断 |

NLS 键位草案：

```text
command.recovery.cancel.title
command.recovery.openDiagnostics.title
command.recovery.exportDiagnostics.title
command.recovery.restore.title
config.recovery.enabled.description
config.recovery.maxBoots.description
config.recovery.logRetention.description
config.recovery.autoPersistBundleIsolation.description
recovery.detected.message
recovery.searching.message
recovery.recovered.message
recovery.unrecoverable.message
recovery.cancelled.message
recovery.restore.confirmation
recovery.diagnostics.exported
recovery.ambiguousRuntime.message
```

英文源放 `package.nls.json`，中文放 `package.nls.zh-cn.json`，再运行现有 locale sync 派生 zh-hans。[F7]

## 14. P13 失败路径处理

| 场景 | 处理 | 终态/防护 |
| --- | --- | --- |
| 沙箱构建失败 | 不运行 Oracle 变体；记录失败步骤、path、平台错误码；不触碰真实 home | `UNRECOVERABLE`，原因 `sandbox-build` |
| Oracle 超时 | 终止拥有 child；Windows wrapper 后代未知时按身份规则处理；记录 timeout 和 cleanup | 当前变体失败；预算继续，cleanup 不确定则停止 |
| 二分不收敛 | 记录非单调或预算不足，不伪造最小集合；保留已验证 fix | `UNRECOVERABLE` 或低置信度诊断 |
| 账本损坏 | 原文件保留，只读生成诊断；不自动应用或恢复 | `UNRECOVERABLE`，原因 `ledger-corrupt` |
| 多窗口并发 | recovery lease + ledger revision CAS；只有一个窗口应用；Runtime lock 仍负责真实进程 | 其他窗口等待/收养，不重复 spawn |
| DSH 升级后首启 | 版本 gate 和组合 schema 不匹配时停止自动修复；要求新版本重新建立 LKG | 不自动迁移旧 profile 修复 |
| HMR live 热载期崩溃 | 若进程 exit，按 ready-exit 走 raw retry；V1 重新 boot；不把一次 HMR 事件直接归因到 bundle | 可能 `RECOVERED` 或继续搜索 |
| PID 复用 | 所有 kill/reclaim 需要 ownerId、PID、出生签名、listener/command line 一致；不匹配则不杀 | 保留锁/进程并诊断 |
| Runtime 已死时改名隔离但文件占用 | 先确认 listener 和所有 child；rename 失败不 force kill 不明进程 | entry `manual-required` |
| 用户执行 `dsh.restart` | 取消 recovery session、增加 generation、等待 stop 完成，再按当前 ledger 启动；旧回调不能写新状态 | 手工动作优先 |
| `findExistingRuntime` 找到健康但无 hash 的孤儿 | 可以记录和等待，但 dirty recovery 不宣称 recovered，不自动击杀 | `ambiguous-runtime` |
| active overlay 文件丢失 | ledger entry 标为 conflict；不静默生成未知内容；若能从结构化 fix 重建则先沙箱复验 | `UNRECOVERABLE` 或下一搜索 |
| profile package.json 被用户改动 | before hash 不匹配，停止阶段 2 自动写入；保留阶段 1/诊断 | `manual-required` |
| 已应用修复后再次崩溃 | 当前 active ledger 作为组合的一部分重新 V1；排除已验证隔离项，避免振荡 | 新 generation，有限搜索 |
| VS Code 非正常死亡 | boot journal 保留 `starting/running`；下次激活先收养，再校验 lock 和 ledger，必要时再入 | fsck 语义 |
| VS Code 关闭且 DSH orphan 存活 | 下次激活先通过 lock/health 收养；不可证明组合时不杀 | 不突破 D5 |
| 诊断日志达到上限 | 丢弃较早中间 chunk，保留 meta、末尾和结论，设置 truncated | 不影响状态机 |
| 日志轮转删除失败 | 保留旧日志，记录 pending cleanup，不删除当前世代 | 不影响恢复安全谓词 |

## 15. Q1-Q5 推荐决策

### Q1 恢复中允许哪些用户干预

推荐：只允许“取消”，以及查看详情/导出诊断这种不改变状态的操作。`dsh.restart` 作为显式生命周期操作自动取消当前 session 后执行。取消后保留已经应用且通过沙箱复验的隔离，并在 ledger 中记录 `cancelled` 原因。[Q1][D5]

理由：恢复循环涉及多个组合和文件身份，允许用户在中途任意修改会让证据和 restore plan 失效；取消是唯一容易定义的安全中断点。

### Q2 RECOVERED 通知

推荐：信息级、可忽略，附“还原修复”和“查看详情”。不使用 modal，不阻断聊天或编辑器。[Q2]

### Q3 阶段 2 何时自动

推荐 v1 默认允许，但必须同时满足：

1. V3 基线通过；
2. 二分得到一个或一组明确的 profile-dependency bundle，origin 不是 installation-owned/unknown；
3. 去掉该 bundle 的沙箱 boot 连续通过两次；
4. 回加确认失败，failure class 与 V1 相容；
5. profile `package.json` 和依赖 lock 在搜索期间 fingerprint 未变；
6. Runtime 已死且没有 live listener，当前窗口持有 recovery lease；
7. ledger 能原子记录原始 bytes hash、原始 bundle 顺序和结构化还原计划；
8. `autoPersistBundleIsolation=true`。

若候选集大于 2、存在非单调交互、origin 不明、文件已被用户改变或只能通过改名用户 patch 才能通过，则不自动写 profile，进入诊断。[D5][D9]

### Q4 预算穷尽时是否保留修复

推荐：保留已经通过沙箱复验且没有被后续真实启动直接证伪的隔离；对导致真实启动失败、文件冲突或 cleanup 不确定的 entry 回滚。所有保留、回滚和原因写入 ledger。这样下次激活可以从有效缩小后的组合继续，而不会反复振荡。[Q4][A6]

### Q5 日志上限和世代数

推荐：每个 generation 2 MB，保留最近 5 个 generation，每次 boot 保留至少 32 KB 尾部；达到上限只截断中间 chunk，绝不把大体量 DSH home 搬到 globalStorage。[Q5][F8]

## 16. 验证计划

仓库规则禁止新增单元测试；验证全部使用 `scripts/verify-*.mjs` 的进程级冒烟模式。范本是 `scripts/verify-runtime-shutdown.mjs`：父进程 `mkdtemp`，worker 注入 mock vscode，使用真实 child/listener，finally 清理隔离目录。[F7]

建议新增 `scripts/verify-recovery.mjs`，内部按 scenario 创建独立 worker。每个 scenario 都设置 `TMPDIR/TMP/TEMP`、临时 `DSH_HOME`、临时 globalStorage 和临时 workspace。

### 16.1 必测场景

| scenario | 验收 |
| --- | --- |
| `bad-bundle-auto-recover` | 注入声明为 dsh bundle 的 fake plugin；原组合 boot 失败；V3 基线通过；二分定位；profile managed block 写入；真实 Runtime 健康；ledger/LKG 正确 |
| `transient-v1` | fixture 第一次 boot exit，第二次原组合健康；V1 通过后不写任何隔离，不进入 V3 |
| `extension-overlay` | compaction/extension patch 使 boot 失败；移除 extension overlay 后通过；用户 profile/home 文件 mtime/hash 不变 |
| `unclean-reentry` | 预写 `ledger.clean=false`、未完成 session 和 boot journal；激活先收养健康 Runtime，收养失败后续跑；已证伪 hash 不重跑 |
| `budget-exhausted` | Oracle fixture 对所有变体返回失败；断言最多 8 次、最终 `UNRECOVERABLE`、账本保留全部证据 |
| `sandbox-build-failure` | 让逐项 link 或临时目录构建失败；断言不触碰真实 home，不产生真实 Runtime |
| `sandbox-cleanup-failure` | 持有沙箱文件句柄/监听端口；断言秘密文件先清理，pending cleanup 落盘，搜索停止 |
| `multi-window` | 两个 worker 同时 begin；只允许一个 lease/apply/real spawn；另一个读取 revision 并不重复修复 |
| `wrapper-crash-primary-error` | Windows-like wrapper fixture 在 ready 前退出并让 terminate 抛 descendant unknown；断言真实 stderr 在 RuntimeLaunchFailure，清理错误另记 |
| `manual-restart-during-search` | Oracle boot 期间调用 restart；断言 abort、generation guard、生效修复不被旧回调覆盖 |
| `pid-reuse-and-unrelated-listener` | stale lock 指向退出 owner，但端口 listener 是 unrelated process；断言不杀 unrelated listener |
| `hmr-runtime-exit` | ready 后 fixture exit；三次 raw retry 后才进入 RecoverySession；不会把一次 exit 直接当作已定位 bundle |
| `ledger-corrupt` | 写入半截 JSON；断言原文件保留、没有自动修复、诊断包含 corrupt 原因 |
| `restore-conflict` | 用户在恢复后修改 profile 文件；还原命令检测 after hash 不匹配，不覆盖用户修改 |
| `version-drift` | fake launcher 报不支持版本；断言版本 gate 先于 Oracle/修复，锁不被误删 |

### 16.2 验收命令和边界

```text
npm run compile
node scripts/verify-recovery.mjs
node scripts/verify-runtime-shutdown.mjs
node scripts/verify-runtime-lock.mjs
```

脚本必须断言：

- 没有读取或修改真实 `$DSH_HOME`、真实 lock、sessions、storages；
- 所有新建 child、listener、temp/globalStorage 在 finally 清理；
- 不添加 `test/*.test.js` 或任何单元测试；
- Windows 场景不依赖管理员权限；junction 失败时应验证安全降级，而不是跳过清理。

## 17. 分期和验收标准

### v1

包含：

- Node-only `CompositionDescriptor`、组合 hash、`HealthOracle` 沙箱；
- V1、V3、V4 和固定 8 次预算；
- `RecoverySession`、ledger、unclean reentry、generation/CAS、多窗口；
- 阶段 1 recovery overlay；
- Q3 条件下的 profile bundle managed block；
- 现有 start/stop/restart/raw retry 挂接；
- F4 真实错误优先级修复；
- generation 日志、redaction、诊断目录和非阻塞 UI；
- 进程级 recovery smoke。

v1 验收必须证明：一个注入的坏 bundle 在不触碰 sessions/storages、不调用模型、不依赖用户操作的情况下，能被沙箱定位并隔离，真实 Runtime 通过 RC Remote 健康探针，账本/LKG/还原计划完整；瞬态故障只走 V1；预算、取消、并发和 cleanup failure 均有确定终态。

### v2

包含：

- V2 静态 YAML 解析和文件行号定位；
- V5 `--version`、包完整性和环境对照；
- RPC hang 检测和 bounded probe，[F17 类 d]；
- profile/home patch quarantine 的自动化；
- 更完整的诊断导出和可选 zip；
- 独立 `dsh-recovery-repair` CLI，复用同一 Node core，在扩展损坏时读取 ledger、导出诊断、还原或清理可验证的 owned artifacts。[D6]

v2 仍不自动重装、删除用户内容、管理 API key 或修改 DSH 上游。

## 18. 机制覆盖矩阵

| 机制 | 防哪类 | 防不死哪类 | 关键依据 |
| --- | --- | --- | --- |
| `HealthOracle` 真实沙箱 boot | plugin import/activation、patch composition、boot-time exit | runtime 语义错误、模型/网络、扩展自身崩溃 | [A1][F12] |
| V1 | 瞬态失败误归因 | 持续确定性故障 | [A2][F17] |
| V3 | 用户 bundle 造成的失败 | 非单调交互、安装损坏、DSH 内核失败 | [A2][A6] |
| V4 | 扩展自己的附加层冲突 | profile/home 用户层错误 | [A2][D9] |
| 阶段 1 overlay | entry 级可逆隔离、零用户文件改写 | bundle 在解析阶段失败 | [D9][F14] |
| 阶段 2 managed block | 真正从 bundle 选择中排除插件 | 用户随后重写 manifest、未知 bundle origin | [D5][D9] |
| ledger + boot journal | VS Code 非正常死亡、恢复再入、还原审计 | ledger 损坏、磁盘不可写 | [D4][D6] |
| global revision/CAS | 多窗口重复 apply、状态覆盖 | 文件系统异常和无法证明 stale guard | [F5][A6] |
| owned process + identity | orphan、PID 复用、错误击杀 | 外部 Runtime、Windows wrapper 不可证明后代 | [F3][F5] |
| 日志 redaction | 崩溃栈和启动证据固化 | 第三方进程输出的未知编码秘密 | [D1][F6] |
| LKG diff | 诊断当前组合漂移 | 任何恢复决策；它不是快照 | [D8][F19] |
| v2 repair CLI | 扩展自身损坏 | OS、Node、DSH 安装本体损坏 | [D6] |

## 19. 显式假设

1. v1 运行时仍是 `@deepseek-ai/dsh@0.1.5-rc.1`，支持重复 `--patch`、`web` profile、`--port 0`、launch token 和 RC Remote v1。[F1][F10][F11][F16]
2. `dsh.profile.bundles` 位于标准 JSON profile manifest，未知的 `dsh.recovery` metadata 不会被 DSH 本体当作 bundle 配置；若事实改变，版本 gate 失败而不是继续写。
3. 当前扩展启动 DSH 时可获得 workspace root；无 workspace 且无 configured server URL 时现有 Runtime 本来就不能启动。[src/dshRuntime.ts:2309-2313]
4. 当前工作区 `.env`、home `.env` 和 credentials 的存在性可能影响 boot；它们可以作为 opaque sandbox input，但永远不进入诊断包。[F13]
5. bundle origin 可以从 profile dependency、安装锚点和 manifest 解析；origin 不明时不自动阶段 2。
6. globalStorage 可写且可以保存几 KB 到受限日志；若不可写，Oracle 仍可只读探测，但不能满足 D4 的账本一致谓词，因此不能标记 recovered。
7. 预防栈会复用 `CompositionDescriptor`、组合 hash 和 `HealthOracle`，但不会复用 RecoverySession 的修复权限；接口不包含“只在恢复时存在”的字段。[D10]

## 20. 最终建议

按 v1 先实现这一条窄而完整的闭环：

```text
启动失败/三次 raw retry 失败
  -> 读取并校验 ledger
  -> findExistingRuntime 收养有 hash 证据的健康 Runtime
  -> HealthOracle V1 原组合复现
  -> V3 bundle 收缩 / V4 移除 extension overlay
  -> 沙箱复验
  -> ledger planned -> apply -> real boot
  -> process live + session/list + compositionHash + ledger consistent
  -> RECOVERED，并保留一键还原
```

这条闭环承认三个不能被包装掉的事实：运行期崩溃只能快速重启，孤儿 Runtime 缺少组合证据时不能自动击杀，`disabled` entry 不能代替 bundle 选择。其余自动化都围绕可验证证据、有限预算和可逆账本展开。
