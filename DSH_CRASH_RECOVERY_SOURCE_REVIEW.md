# DSH 崩溃恢复源码事实复核

复核日期：2026-09-11
复核范围：仅复核 DSH 分发源码、现有进程级冒烟脚本及扩展 Remote 健康探针；不实现功能、不创建测试、不启动真实用户 DSH。

## 复核基线

- `E:\desktop\deepseek-harness` 不存在；仓库内也没有 `deepseek-harness/`。
- 因此本次以安装版 `@deepseek-ai/dsh` `0.1.5-rc.1` 为源码事实基线：
  - `C:\Users\YS\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\package.json:1-4`
  - CLI：`C:\Users\YS\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js`
  - Profile boot：`C:\Users\YS\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\profile-boot-Dk-7KqJc.js`
  - Boot/fallback：`C:\Users\YS\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-app-boot\lib\index.js`
  - Loader：`C:\Users\YS\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\cordis-plugin-loader\lib\index.js`
- 未读取实际 `$DSH_HOME`、`.env` 或 `.credentials.yaml` 的内容；未执行真实 DSH 启动。下文的“沙箱副作用”是由写路径源码推导出的风险，不是实机结果。

## 1. CLI `--patch` 语义与顺序

### 已确认事实

- `--patch` 是“可重复的单值选项”，收集器为 `[...]previous, value`，因此 `--patch a.yml --patch b.yml` 的数组顺序就是 `a.yml`、`b.yml`；它不是 variadic 选项。
  依据：`C:\Users\YS\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js:23-27`，符号 `collect`。
- 根命令与 `web` 别名各自声明同样的重复 `--patch` 选项；根命令声明在 `:85`，`web` 子命令声明在 `:100-104`。`web` 是固定的 `--profile web` 别名，不是另一种 patch 算法。
- `resolveBoot()` 直接保留 `options.patch ?? []`，不排序、不去重，调用方随后以数组顺序传入 `runProfile()`：
  依据：`lib/bin.js:52-73`、`:141-152`，符号 `resolveBoot`、`runCli`。
- 实际运行时的合成顺序是：
  1. `profile.layers` 中各 bundle 的 patch，按 `dsh.profile.bundles` 数组顺序；
  2. profile 自己的 `cordis.patch.yml`；
  3. `$DSH_HOME/cordis.patch.yml`；
  4. 所有 `--patch` overlay，按 argv 出现顺序；
  5. `DSH_TELEMETRY_DISABLED` 派生出的 telemetry 禁用行（仅运行时 boot 路径）。

  依据：`lib/profile-boot-Dk-7KqJc.js:212-219` 的 `allPatches`，`:222-256` 的 `composeProfile`，以及 `:301-319` 的 `runProfile`。
- 每一层最终进入同一个扁平 patch 列表。`applyEntryPatches()` 按列表逐条处理：维护当前 entry id map；`insert` 会立即加入 map，后续 patch 可以命中本次 insert；普通 patch 按 `id` 查找并覆盖字段，`name` 不匹配时跳过并告警。
  依据：`C:\Users\YS\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-app-boot\lib\index.js:45-107`，符号 `applyEntryPatches`。
- 因此“后层覆盖前层”是同一合成算法内的顺序覆盖，不是按文件名、时间或 map 重排。`composeEntries()` 和 `boot()` 使用相同算法。
  依据：`dsh-app-boot\lib\index.js:897-909`，以及 `:1496-1538` 的 `boot`。

### 限定

- “纯 `--patch` 可禁用任意条目”精确含义是“可覆盖合成结果中已存在且 id 命中的条目”。若 id 不存在，patch 不会创造一个 disabled 条目，而是告警并跳过：`dsh-app-boot\lib\index.js:89-106`。
- `--dump-default-config` 明确拒绝任何 `--patch`：`lib/bin.js:63-73` 的 `resolveBoot()`；`runDumpConfig()` 也只输出 bundle 层，不输出 profile/home/overlay 层：`lib/dump-config-lFgMwK8i.js:24-49`。
- `--dump-config` 的 overlay 顺序仍是 argv 顺序，但其 dump 路径没有调用 `resolveTelemetryPatch()`；telemetry 派生行只在 `composeProfile()` 的正常 boot 合成中追加。该差异见本文“待确认项”。

## 2. Bundle 选择与 `disabled` entry 的区别

### 已确认事实

- bundle 的“选择”来自 profile `package.json` 中 `dsh.profile.bundles` 数组。`loadProfileDirectory()` 对数组中的每个 package 解析目录、读取该包的 `dsh.bundle.patch` 声明并立即读取 patch 文件；缺包或缺 `dsh.bundle` 声明会失败。
  依据：`dsh-app-boot\lib\index.js:843-870`，符号 `loadProfileDirectory`；bundle 解析顺序在 `:815-831` 的 `resolveBundleDir`。
- bundle 解析优先使用 DSH 安装锚点，之后才使用 profile 目录；这保证同安装的内置 bundle 优先于 profile 中同名副本。
  依据：`dsh-app-boot\lib\index.js:815-829`。
- `disabled` 是 entry 选项，不是 bundle 选择器。Loader 的有效 disabled 状态来自当前 entry 或父 group；普通布尔值直接取值，`!!js` 则在 Loader context 中求值。
  依据：`C:\Users\YS\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\cordis-plugin-loader\lib\index.js:359-382`，符号 `Entry.disabled`、`disabledOf`。
- disabled entry 不启动插件：更新时若候选 entry disabled，跳过 `init()`；刷新时也直接返回；最终 `assertEntriesLoaded()` / `assertEntriesActivated()` 对 disabled entry 不视为失败。
  依据：`cordis-plugin-loader\lib\index.js:389-392`、`:404-445`，以及 DSH boot `dsh-app-boot\lib\index.js:1428-1494`。

### 对恢复搜索的直接事实边界

- 用 `--patch` 写 `- id: X, disabled: true`，前提是 X 已被 bundle/profile/home 等前层合成出来；它会禁止 X 的激活，但不会从 `dsh.profile.bundles` 删除 bundle。
- 因为 bundle patch 在合成前已经被解析，禁用 bundle 产生的 entry 不等于跳过该 bundle package 的解析或 patch 文件读取；这是“entry 禁用”，不是“bundle 未选择”。
- 真正排除 bundle 需要改变 profile 的 `dsh.profile.bundles`，或选择另一个 profile；当前 CLI 没有一个“只在本次 invocation 选择 bundle 子集”的启动 flag。profile 初始化另有 `--from-default-profile`，但它是创建 profile 的操作，不是临时 bundle overlay：`lib/bin.js:85`、`:111-115`，以及 `dsh-app-boot\lib\index.js:372-398`。

## 3. `cordis.yml` 重写与 Loader writeback

- `prepareProfile()` 每次加载 profile 后都同步写入 profile 目录下的空根配置 `cordis.yml`；有效组合通过 patch 参数传入 `boot()`，不是从该文件中读取 bundle 组合。
  依据：`lib/profile-boot-Dk-7KqJc.js:192-210`，符号 `prepareProfile`。
- 该重写发生在正常 boot 和 dump 路径，因为 `runDumpConfig()` 也调用 `prepareProfile()`：`lib/dump-config-lFgMwK8i.js:24-25`。因此“dump 不 boot”不等于“完全不写 profile 文件”。
- root Include 的 `write()` 会把当前 root tree data 排入写队列；实际写入先写 `cordis.yml.tmp`，再 rename 覆盖目标，并对 Windows 常见 `EACCES/EBUSY/EPERM` 做有限重试。
  依据：`dsh-app-boot\lib\index.js:245-283`，符号 `Include._writeFile`、`Include.write`。
- Loader 的 `EntryTree.create/remove/update()` 会调用 `tree.write()`；运行期配置变化、entry 禁用或移除可能触发该 writeback。
  依据：`C:\Users\YS\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\cordis-plugin-loader\src\config\tree.ts:96-142`，符号 `EntryTree.create/remove/update`。
- Loader 还会在嵌套 entry 的 `internal/update` 后调用父 tree 的 `write()`；被写回的内容可能包含已组装的 entry 行。
  依据：`cordis-plugin-loader\lib\index.js:687-705`。
- DSH 每次 boot 先恢复空 `cordis.yml`，正是为了避免此前 Loader writeback 把 bundle 组合烙入根文件后，下一次再叠加 bundle patch。该意图也写在 `prepareProfile()` 注释中：`lib/profile-boot-Dk-7KqJc.js:192-199`。

## 4. `profiles/node_modules` fallback/heal 写路径

### 已确认写路径

- 共享 fallback 目录固定为 `$DSH_HOME/profiles/node_modules`，启动时先 `mkdirSync`；缺失或不匹配时在该目录名对应的跨进程文件锁内修复。
  依据：`dsh-app-boot\lib\index.js:646-667`，符号 `healProfilesModuleFallback`。
- `withFileLock(filename)` 使用同级 `${filename}.lock`，即共享 fallback 的锁路径是 `$DSH_HOME/profiles/node_modules.lock`，通过 `wx` 创建并在操作结束删除；锁竞争超时不会猜测并删除既有锁。
  依据：`C:\Users\YS\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-atomic-write\lib\index.js:107-145`。
- 普通 Node 安装使用 symlink；源码实际调用 `symlinkSync(target, link, "junction")`。打包 executable 则在共享 fallback 下写入 DSH 管理的 ESM proxy 文件。
  依据：`dsh-app-boot\lib\index.js:543-579` 的 `ensureModuleProxy`、`ensureSymlink`，以及 `:611-625` 的 `resolveModuleFallbackEntries`。
- 共享 fallback 的修复写入点是每个 packageName 对应的 `$DSH_HOME/profiles/node_modules/<packageName>`：`dsh-app-boot\lib\index.js:668-676`。
- profile 专属修复另外创建两处目录：
  - `$DSH_HOME/profiles/<name>/node_modules`
  - `$DSH_HOME/profiles/<name>/.dsh-module-fallback/node_modules`

  依据：`dsh-app-boot\lib\index.js:711-716`，符号 `healProfileModuleFallback`。
- profile 专属修复会根据选中的 bundle 层计算依赖闭包；清理由 DSH 管理的旧 projection link，之后写入 `.dsh-module-fallback/node_modules/<packageName>`，再把 profile `node_modules/<packageName>` 投影到该 owned link。
  依据：`dsh-app-boot\lib\index.js:717-738`。
- pnpm 管理的 profile-local entry 优先，DSH 只补齐缺失的 fallback；源码注释明确写出“pnpm-managed entries remain authoritative”。
  依据：`dsh-app-boot\lib\index.js:301-308`、`:646-653`。
- 共享 fallback 修复函数本身只遍历当前安装闭包并确保 entry，源码中未看到像 profile 专属路径那样的 obsolete entry 删除循环：`dsh-app-boot\lib\index.js:668-676` 对比 `:729-730`。这是当前实现观察，不等同于对历史目录状态的实机结论。
- profile 专属 `healProfileModuleFallback()` 的源码路径未包在与共享 fallback 相同的 `withFileLock()` 中；多进程/多窗口同时修复 profile-local link 的行为需要另行进程级确认。依据：`dsh-app-boot\lib\index.js:657-667`、`:711-738`。

### 沙箱共享 `node_modules` 的副作用推导

- 如果 Oracle 沙箱只复制配置文件，却把 `$DSH_HOME/profiles/node_modules` junction 到真实 home，那么 DSH 的启动 heal 可能直接在真实 home 下创建或替换共享 symlink/proxy，并使用真实的 `profiles/node_modules.lock`。
- 如果 profile 的 `node_modules` 或 `.dsh-module-fallback` 也 junction 到真实 profile，则 profile 专属 heal 可能在真实 profile 下创建、替换或删除 DSH 管理的 link。
- 因而“配置副本 + 真实共享 node_modules junction”不是源码意义上的只读 boot；它还可能与真实 Runtime 或另一个沙箱发生 fallback writer 竞争。这是由上述写路径推导的风险，尚未执行真实 DSH 验证。
- `ensureSymlink()` 对已有的非 symlink、且不是 DSH 管理 proxy 的路径会直接报错，不会静默接管：`dsh-app-boot\lib\index.js:406-431`。

## 5. 环境层与 cwd

- `DSH_HOME` 的解析优先级是显式配置路径、环境变量 `$DSH_HOME`、默认 `~/.dsh`；空白或全空白 `$DSH_HOME` 视作未设置。
  依据：`C:\Users\YS\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-home-paths\lib\index.js:63-75`，符号 `resolveDshHome`。
- CLI `runCli()` 以当前进程的 `process.cwd()` 调用 `loadLayeredEnv("dsh")`，然后把返回的环境快照传入 `runProfile()`：`lib/bin.js:141-152`。
- 环境快照的优先级是 inherited process、invocation cwd 的 project `.env`、DSH home 的 user `.env`；两份文件先检查再应用，已继承的环境变量不会被文件覆盖。
  依据：`dsh-app-boot\lib\index.js:1064-1098`，符号 `loadLayeredEnv`；快照查找顺序见 `dsh-launch-environment\lib\index.js:9-53`。
- `.env` 不能设置决定进程启动/代码加载/网络 bootstrap 的变量；`DSH_` 前缀属于 bootstrap-only，因此 `$DSH_HOME` 必须在启动 DSH 的父进程环境中设置，而不是依赖项目 `.env` 搬运。
  依据：`dsh-app-boot\lib\index.js:947-1057`。
- `runProfile()` 将环境快照安装到 proxy 环境并通过 `DSH_LAUNCH_ENVIRONMENT_KEY` 提供给 DSH context：`lib/profile-boot-Dk-7KqJc.js:279-319`。
- DSH base 的 sandbox policy 将 `workspaceRoot` 设为 `process.cwd()`；文件 sandbox 的 `cwd` 默认同样来自 `process.cwd()`，overlay 才能改写。
  依据：`C:\Users\YS\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-base\cordis.patch.yml:202-212`、`:477-480`。
- 结论：沙箱必须同时明确设置进程 cwd 与 `DSH_HOME`；只重定向 home 不会把 DSH 的 workspace/sandbox 根目录改到沙箱目录。

## 6. 启动、认证与健康路由

- `web-startup` 插件从 `cmdlineArgs` 解析 `--host`、`--port`、`--trusted-host`、`--no-open`，再提供 `webStartup` 服务；`--host 0.0.0.0` 和非数字 port 会在启动阶段报 usage error。
  依据：`C:\Users\YS\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-web-app\lib\startup.js:21-50`。
- `dsh-web-app` 的 bundle patch 将 `webStartup.host/port` 接到 `webserver`，默认 host 为 `127.0.0.1`、port 为 `3080`；`--port 0` 由 webserver 交给 OS 选端口。
  依据：`C:\Users\YS\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-web-app\cordis.patch.yml:132-161`，以及 `dsh-host-webserver\lib\index.js:156-168`、`:296-301`。
- DSH 只有在 Loader settled 且 `webServer`、`connection` 都存在后，才打印带 token 的 authenticated URL；boot 失败时不应假设已经得到 URL。
  依据：`dsh-web-app\lib\index.js:194-216`，符号 `apply` 内的 `announceReady`。
- Connection 的 BrowserAuth 从 credentials provider 读取或创建持久签名 secret；本复核没有读取任何 credential 内容。
  依据：`C:\Users\YS\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-client-connection\lib\index.js:321-364`。
- 启动 URL 的认证交换只接受一次 `GET /?token=<process-launch-token>`，成功返回 `303`、`Set-Cookie` 和干净的 `/`；cookie 绑定请求 authority。无有效 cookie 的请求返回 `401`。
  依据：`dsh-client-connection\lib\index.js:366-448`，符号 `BrowserAuth.authenticatedUrl`、`authorizeIndex`、`isAuthenticated`。
- `/api` 路由先做 Host/Origin trust fence，失败为 `403`；通过 fence 但没有有效 cookie 为 `401`，之后才进入 JSON RPC bridge。
  依据：`dsh-client-connection\lib\index.js:552-555`、`:767-781`。
- `session/list` 是直接调用的 unary endpoint，参数名严格为 `_request`，返回可见 Session 列表且不激活 Agent。
  依据：生成描述 `dsh-api-session-controller\lib\typert.host.js:896-919`，实现 `dsh-api-session-controller\lib\index.js:1824-1847`、`:2820-2827`。
- 扩展侧 `RemoteUnaryClient.probe()` 对 `/api/session/list` 发 `POST`，payload 为 `{ args: { _request: {} } }`，使用调用方 cookie header，并按配置 timeout；`probe()` 代码在 `E:\desktop\dsh-vsc-integration\src\remote\unaryClient.ts:34-109`。

## 7. 现有进程级冒烟验证惯例

### `scripts/verify-runtime-shutdown.mjs`

- 父进程先 `mkdtemp()`，再以 worker 子进程运行验证；worker 环境显式设置 `TMPDIR/TMP/TEMP` 和临时 `DSH_HOME`，父进程 finally 递归清理临时目录：`E:\desktop\dsh-vsc-integration\scripts\verify-runtime-shutdown.mjs:14-25`。
- worker 通过 `Module._load` 注入最小 mock `vscode`，加载扩展 dist 后立即恢复原始 loader：`:28-43`。
- 运行真实子进程 fixture：wrapper 再 spawn listener child，并通过端口连通性、退出、锁文件消失和 bounded deadline 验收；并发调用 `dispose()/stop()`，要求子 listener 在 dispose resolve 前停止：`:44-121`。
- 对“启动异步准备期间 stop”单独验证，要求取消后不发生迟到的 Runtime spawn 或锁 claim：`:123-151`。
- 清理只针对本 smoke 新建的隔离 child/process group：`:115-119`。

### `scripts/verify-runtime-discovery.mjs`

- 每个 scenario 都是独立 `mkdtemp` + worker 子进程，隔离 `TMPDIR/TMP/TEMP/DSH_HOME`，并在 finally 删除目录：`E:\desktop\dsh-vsc-integration\scripts\verify-runtime-discovery.mjs:15-27`。
- 脚本在入口处明确拒绝 Windows（`:16`），所以它能作为进程级结构范式，但不能直接作为本任务的 Windows 验收脚本。
- 用临时 fake executable 记录实际启动名、argv 和版本探测；通过 `Module._load` 注入 mock `vscode`：`:33-94`。
- 只替换外部 Runtime discovery/RPC 边界；launcher 选择、版本探测、实际 spawn、argv 和 lock lifecycle 保持生产代码：`:95-105`。
- 验收包含版本不匹配、显式 command、pnpm/npx fallback、取消、lock runtimeVersion/runtimePid 和最终锁清理：`:108-144`。

### `scripts/verify-remote-runtime.mjs`

- 这是“真实 DSH launcher + 隔离 home/workspace + loopback mock model”的进程级集成范式；环境使用 allowlist，不继承 API key、用户 profile 路径或 loader override：`E:\desktop\dsh-vsc-integration\scripts\verify-remote-runtime.mjs:27-61`。
- 启动参数直接采用 `--profile web --patch <path> --no-open --host 127.0.0.1 --port 0`：`:96-100`。
- 认证验收顺序是：先无 cookie 的 probe 必须 `401/403`，再访问带 token 的 launch URL，断言 `303` 和 `set-cookie`，之后才创建带 cookie 的 Remote connection：`:137-149`。
- finally 会停止 Remote coordinator/connection、先 SIGTERM 后在 3 秒后 SIGKILL 兜底、关闭 mock server，并按 `--keep` 决定是否保留隔离目录：`:257-270`。
- 本次只复核脚本源码，没有执行该脚本，也没有启动真实用户 DSH。

## 8. 差异与待确认项

1. **F14 的 telemetry 范围需要在主设计中注明。** 正常 `runProfile()` 会在所有 overlays 之后追加 telemetry disabled patch（`profile-boot-Dk-7KqJc.js:242-250`）；`dsh --dump-config` 路径只调用 `runDumpConfig()` 的 bundle/profile/home/overlay 合成，不调用该派生逻辑（`dump-config-lFgMwK8i.js:24-49`）。这不是推翻 F14，而是“dump 输出是否必须模拟 telemetry 派生层”的待确认边界。
2. **“禁用 bundle”不能直接等同于 `disabled: true`。** 当前源码只支持 entry 级 disabled；bundle package 的 patch 文件和包目录在合成阶段仍会被读取。若设计需要“完全不解析某 bundle”，需要另有 profile 选择/manifest 变体，不能只生成 entry disabled overlay。
3. **“任意条目”必须有已存在 id。** 未命中的 disabled patch 只产生 Loader warning 并跳过；需要确认恢复搜索是否把“未命中”记为变体无效，而不是已应用修复。
4. **dump 路径会重写 `cordis.yml`，但不会执行 boot heal。** `prepareProfile()` 会写空 root；`runDumpConfig()` 没有调用 `healProfilesModuleFallback()`。若把 dump 当作完全只读诊断或把它当作 boot 等价物，均需在主设计中明确边界。
5. **沙箱 junction 的写入隔离尚未实机确认。** 源码已明确共享 fallback 和 profile-local fallback 的写路径；尚未在本机用真实 DSH 做 junction/并发写验证，符合本次“不运行真实用户 DSH”的限制。
6. **profile-local heal 的并发保护尚待确认。** 共享 fallback 有 `profiles/node_modules.lock`，但 `healProfileModuleFallback()` 展示的调用链没有同等跨进程锁；多窗口验收应覆盖同一 profile 同时启动的 link reconciliation。
