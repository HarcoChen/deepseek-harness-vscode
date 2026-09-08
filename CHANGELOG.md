# 更新日志

本文档记录 DSH IDE 的重要版本变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

<!-- 在这里填写下一版本的发布说明；npm run release 会自动提升这一节。 -->

### 修复

- 新增 `dsh.serverToken` 配置项。手动配置 `dsh.serverUrl` 时可以单独填写 dsh web 启动 Token，连接新版 Runtime 不再必须把 Token 拼进地址。
- 修复空对话首次切换 preset/mode 时选择失效的问题；选择 mode 前会先恢复已有 Session，并把新对话的选择保存在草稿中。
- 已有 Session 但没有本地 Workspace 时不再允许选择 mode，避免启动 Runtime 时缺少工作目录。

### 变更

- 临时暴露 `deepseek-v4.1-flash-expires-on-0910` 模型，并补齐可用的 reasoning 选项；该 fallback 仅展示至 2026-09-10，且在 DSH 未登记该模型时按 text-only route 处理。

## [0.9.0] - 2026-09-07

本版本是 `0.7.0-beta.1` 那批功能的第一个**可安装**构建：`0.7.0-beta.1` 的 vsix 漏了运行时依赖，装上后必然卡在加载，该版本已从 Open VSX 撤回。完整的功能与协议变更见下方 `0.7.0-beta.1` 条目。

### ⚠️ 破坏性变更

沿续 `0.7.0-beta.1`：整体切换到 `dsh 0.1.2-rc.1` 的 RC Remote 协议，旧 ApiProxy 协议已删除，**不保留向后兼容路径**。**必须升级 dsh Runtime**——`0.1.1-rc.2` 及更早不再可用，连接旧 Runtime 会报「未暴露 RC Remote RPC」且不降级；托管 Runtime 默认 pin 为 `0.1.2-rc.1`，首启会下载，预览版之间存储格式可能不兼容。手动配置 `dsh.serverUrl` 的用户需同步升级那个 `dsh web` 实例。详见下方 `0.7.0-beta.1` 条目。

### 修复

- 修复安装后卡在加载：`dist/remote/muxClient.js` 在模块加载时 `require("ws")`，而 `0.7.0-beta.1` 的 vsix 里一个 `node_modules` 文件都没有——打包步骤的 `--no-dependencies` 会让 vsce 完全跳过 node_modules 收集，`.vscodeignore` 中 `!node_modules/ws/**` 的负向规则因此失效。`ws` 解析失败会让承载所有 RC Remote 逻辑流的 mux WebSocket 无法建立，且运行时不报错、只表现为界面停在加载。打包不再传该参数，并新增发布门禁：逐个核对 `package.json` 声明的运行时依赖是否真的进了 vsix，缺失即让发布失败。

### 变更

- 版本号改用奇偶 minor 分流：`0.8.0` 起正式版走偶数 minor（`0.8.x`），预发布走更高的奇数 minor（`0.9.x`）。发布流水线按同一规则决定是否以 `--pre-release` 打包发布，`npm run release` 也会在动手前打印解析出的通道。客户端总是升到版本号最高的那个、不看通道，因此让预发布号始终高于所有正式版号，才能保证正式版发布不会把尝鲜用户拽出预发布通道。带 SemVer 预发布后缀的版本（如 `0.7.0-beta.1`）仍按预发布处理，但这类版本号 VS Code Marketplace 不接受，只能进 Open VSX 与 GitHub Releases。

## [0.7.0-beta.1] - 2026-09-07

### ⚠️ 破坏性变更

本版本整体切换到 `dsh 0.1.2-rc.1` 的 RC Remote 协议，旧 ApiProxy 协议已从代码中删除，**不保留向后兼容路径**。

- **必须升级 dsh Runtime**：`0.1.1-rc.2` 及更早不再可用。连接旧 Runtime 时 `session/list` 返回 404，扩展直接报「未暴露 RC Remote RPC」并提示升级，不会降级回旧协议——会话列表、流式回答、审批与提问全部不可用。
- **托管 Runtime 默认 pin 从 `0.1.1-rc.2` 提升到 `0.1.2-rc.1`**：首次启动会下载新的 Runtime；预览版之间 Runtime 存储格式可能不兼容，旧会话数据不保证可读。
- **手动指定 `dsh.serverUrl` 的用户需要同步升级**那个 `dsh web` 实例，或把 `dsh.runtimeVersion` 留在默认值改用托管 Runtime。
- **UI 级流式、审批/提问交互与断线恢复仍是未覆盖的人工冒烟项**，这也是本版本以 beta 发布的原因。

### 变更

- 运行时兼容范围：已验证 `dsh 0.1.2-rc.1`，契约 pin `dsh-v0.1.2-rc.1@a66e4702047846cdaa10c66c9d3df3951f5ea70d`。更高版本未经验证而非被阻止——扩展不检测高于已验证范围的 Runtime，升级默认 pin 前需按 `RPC_ADAPTATION_PLAN.md` §14 做 tag diff 并重跑 smoke。
- 优化中英文 README：突出原生 Diff、审批与任务可观测性，补充首次配置、使用场景和排障入口；更新仓库地址、扩展商店名称、简介、分类、搜索关键词与展示背景。
- 完整适配 `dsh 0.1.2-rc.1` 的 RC Remote 协议（契约 pin：`dsh-v0.1.2-rc.1@a66e4702047846cdaa10c66c9d3df3951f5ea70d`，见 `RPC_ADAPTATION_PLAN.md`）。新增 `src/remote/` carrier：unary（`/api/<namespace>/<method>` + `{args}` envelope，严格校验 `server-response` 与 rpcId）、单 WebSocket 多逻辑流的 `remote.mux`（open/cancel/item/error/end，终止帧幂等）、`$events` ready 作为每代连接的就绪屏障（generation 退避重连，旧代结果不得污染新状态）、`workspace/follow`/`session/control`/`session/follow`+`session/page` 原子 baseline 与增量合并、approval/question waterfall 以同代 `clientId` 应答 `$events/result`、prompt 幂等 `requestId` 防重发重复。
- 旧 ApiProxy 协议整体移除：`harnessClient`（点号 endpoint、双 WebSocket、`/api/respond`）、`harnessState`、`harnessConnection`、`harnessProtocol` 与其测试删除；`sessionStore`/`sessionCatalog` 改为接收 Remote 状态协调器的明确 mutation/baseline（其 envelope reducer 保留为护栏测试入口）；`HarnessHostDescription`/`HarnessGoalEditChanges`/`HarnessQueueAction`/`HarnessStreamEnvelope` 迁入 `types.ts`。
- 会话与工作区全量改走 RC Remote 端点：session（list/search/create/rename/fork/prompt/attachment/updateQueue/cancel/canOpenWorkspacePath/openWorkspacePath/modelCatalog/selectModel）、workspace（create/rename/insertBefore/insertSessionBefore/archiveSession/delete）、agentPresets、goals（携带 agentId 与 ref.revision 冲突语义）、commands、subagents、skills、messageFeedback、settings、credentials、llm、directoryPicker；`directoryPicker/*` 不可用时安全降级。
- 错误分层落地：401/403 报鉴权、404 报能力缺失不降级旧协议、`gateway/arguments-invalid` 视为契约不匹配、未知 namespaced code 显示服务端文案并记录脱敏 details。已对真实 `0.1.2-rc.1` runtime 完成 32 项自动化 smoke（鉴权交换、unary/流握手、baseline、workspace 生命周期、能力端点、错误路径），UI 级流式与审批交互仍需人工冒烟。
- 新增 Prompt 模板：`.dsh/prompts` 下的本地 Markdown 只读发现（限 100 个文件 / 4 层深度 / 单个 32 KiB，frontmatter `title` 或首个 `#` 标题作展示名，路径经 `..` 与绝对路径校验），入口为 Composer 的`/template` 与命令面板 `DSH: Insert Prompt Template`；选中后整篇成为输入框草稿，发送仍由用户完成。大小上限在读取前用 `workspace.fs.stat` 判定，列表侧不会为取标题而整读超限文件。不做自动注入与隐式记忆。
- 新增只读插件清单：消费 `pluginInventory/list`，对 Loader 条目与 Agent preset 组合做严格快照校验，设置面板提供全局/会话分组、生命周期相位、搜索与手动刷新；不提供凭空的插件管理动作。
- 新增动态插件面板（Cordis Host）：inventory、停止、移除与待批准请求提示，移除在面板内做行内二次确认，待批准可跳转 dsh Web UI。扩展不执行不可信的 `getClientCode`，Client half 仍由 Harness Web UI 负责。
- 新增定时提醒面板：只读展示 schedule projection 的提醒内容、规则与下次执行时间。
- 子代理补齐历史预览、跟进与中断：预览的待处理状态在刷新后显式结算，不会因为节点消失或活动状态变化而卡住后续操作。
- `@` 引用补全接入 Runtime 侧候选：`fileReferences/list` 与 `sessionReferenceResolver/candidates`，端点缺失时回退本地候选；文件位置跳转在本地边界检查失败且 Host 宣布 `canOpenPath` 时回落到`session/openWorkspacePath`，为远程工作区保留公开协议路径。
- 扩展启动的 Runtime 异常退出后按 1s/5s/15s 有界退避自动恢复；外部 Runtime 仍只复用、不接管。
- 明确多根工作区语义：DSH 的 Session 与 DirectoryPicker 契约均为单 `cwd`，VS Code multi-root 不映射成一个DSH Session，启动 Runtime 时使用第一个 workspace folder；README 与 FAQ 同步说明，并补充「不会自动识别密钥或个人信息」这一上下文边界。
- 活动面板与设置面板的滚动区域（Goal 详情、子代理转录、定时提醒、Todo）可用键盘聚焦并滚动。
- 内部结构整理：chatView 拆出 `sessionCatalogCache`、`subagentController` 与 `messageFeedbackController`，目录缓存的请求去重、失效代际与重拉排队各只保留一处实现。
- 预发布版本不再只挂 GitHub Releases：release workflow 对含 `-` 的版本改用 `vsce package --pre-release` 打包并以 `ovsx publish --pre-release` 发到 Open VSX，注册表会标记该版本，只有主动切换到预发布版本的用户才会收到，稳定通道不会被拽上去。VS Code Marketplace 不接受带 SemVer 预发布后缀的版本号，因此这类版本仍不进 Marketplace。

## [0.6.2] - 2026-09-05

- 紧急修复：锁定dsh版本，上游巨大RPC变化后面慢慢做

## [0.6.1] - 2026-09-04

- 修复托管 Runtime 解包：提取文件时重新应用归档中的权限位，`bin/node`、`bin/dsh` 和 node-pty 的 `spawn-helper` 不再因为落地成不可执行而导致 Runtime 起不来；同时跳过 tar 的全零结束块（其空文件名会解析回暂存目录本身），并去掉 GNU 长文件名条目结尾计入长度的 NUL 字节。
- 新增 `scripts/verify-managed-runtime.mjs`：直接驱动扩展自己编译出的 `dist/managedRuntime` 校验某个 Runtime 发布是否真的可用，默认只检查远端契约（manifest 与五个平台资产），`--full` 会做一次真实安装并冒烟测试启动器（含 `web`）。
- 新增单向 Debug Context：通过 `DSH: Explain Current Debug State`、暂停时 Debug Toolbar 的鲸鱼按钮或 `/ide` 选择器，采集当前调试线程/帧、停止原因、前 10 层调用栈、局部变量、源码附近 24 行和 workspace diagnostics；敏感变量脱敏并作为一次性 IDE context 注入下一条 prompt，暂不依赖 DSH 插件或双向调试 RPC。

## [0.6.0] - 2026-08-27

- 精简底部常驻区：Token 用量并入输入框下方的紧凑入口（点击仍展开完整统计面板，此后从底部上弹），Todo 清单并入活动面板成为置顶的可折叠标签页，去掉多余的常驻统计条与堆叠边框，底部只保留输入框上沿一条分隔线。
- 统一消息流与卡片视觉：工具卡、压缩卡与通用卡片的圆角、留白对齐，用户气泡去边框仅保留背景；间距改用 4px 基准刻度，圆角与阴影收敛为统一的设计 token，输入框默认更紧凑，整体更清爽。

- 审批卡显示这次调用实际要做什么：命令类调用展示命令行与工作目录，写文件类调用列出目标文件并可在批准前打开原生 diff 预览拟议改动（待批准的调用尚未执行，磁盘上的文件即真实 before，无需重建）。
- 权限面板的 preset 可直接点击切换，走宿主自己的 `/permissionPresets` 命令；Runtime 未提供该命令时退回原有说明。组合器底部常驻权限指示，点击在可选 preset 间循环。

- Release workflow 识别 SemVer 预发布版本（版本号含 `-`）：此类 tag 只产出 vsix 并建预发布 GitHub Release，不再推送到 Open VSX，避免 beta 成为所有用户升级到的版本。
- `npm run release` 支持预发布版本毕业到正式版：可从 `x.y.z-beta.N` 发布 `x.y.z`（或用 `stable` 提升关键字），并把变更日志中同基线的所有 beta 段落自动合并进新的正式版段落，比较链接沿用最早那个 beta 的起点。

- 斜杠菜单回车选中即执行，不再把命令名填回输入框；需要参数的命令仍可手动输入完整命令行提交（打空格后菜单自动关闭）。
- 以 `/` 直接调用的 skill 同样即时发送，并在消息流中渲染为调用标记而非字面 prompt 文本；`$name` 的句中引用手势保持原样，仍是补全进草稿。

- 继续收窄 ChatViewProvider：Workspace 管理与 Agent Preset 管理的 QuickPick 流程迁至 `workspaceActions.ts` 与 `agentPresetActions.ts`，通过窄接口回调告知视图需要失效的草稿状态，`chatView.ts` 由 3169 行降至 2820 行、方法数 98 → 90。新建会话草稿的五个字段统一由 `clearNewSessionDraft` 清理；移除 Workspace 时保留已选的 agent mode，不再连带清空。
- 工具卡新增按次编辑的原生 Diff：`write` / `edit` / `str_replace_editor` 完成后可逐文件打开 VS Code 自带的并排 diff 编辑器。before 一侧不依赖 Git，而是用 Runtime 已随日志持久化的 hunk 从磁盘上的当前文件反向回放重建，因此非 Git 仓库、被 gitignore 的文件同样可用，粒度也从「整轮」细化到「单次调用」。锚点缺失或不唯一时明确报错而非展示不忠实的 diff；该文件此后未被再次修改且为 LF 行尾时，右侧直接使用可编辑的真实文件。
- Slash 命令面板改为向 Runtime 实时枚举：通过 Gateway 通道的 `commands/list` 拉取当前会话真实注册的命令（`/plan`、`/compact`、`/goal`、`/feedback` 等随 profile 组合变化），与扩展自有的 IDE 命令合并展示，并在 `commands/change` 到达时失效重拉。命令执行改走 `commands/execute`，替换此前把 `/compact`、`/goal` 当作裸 prompt 文本发送的做法——该做法在 `0.1.1-rc.2` 上并不生效，会把命令行当普通消息发给模型。
- 推进 Webview UI 重构：拆分 Composer 与消息渲染子组件，稳定流式消息引用以减少无关行重渲染，移除阻塞式原生对话框，并补齐 Focus Mode、错误横幅和键盘可访问性。
- 将 ActivityDock 拆为独立壳层及 Goal、Queue、Subagents、Jobs、Permissions、Changes 六个面板模块，移除跨消息列表的反向依赖。
- 将设置、权限、统计、Todo、图片附件和推理强度的纯投影/校验逻辑从 ChatViewProvider 迁至独立呈现模块，收窄宿主 God Object。
- 新增 macOS AppShot：从附件菜单或命令面板选择应用窗口截图，并作为一次性图片草稿随消息发送。
- 托管 Runtime 默认 pin 更新至 CNB 已发布的 `0.1.1-rc.2`，覆盖 macOS、Linux 和 Windows 五个平台资产；安装时校验 manifest 版本必须与请求版本一致，并在设置说明中提示预览版存储格式兼容性。
- 提问卡片支持折叠、多行自定义回答和草稿保留，便于处理较长的 `ask_user_question` 内容。
- Job Center 补充后台任务 kind、job id、实时持续时间、所有者和输出摘要；单任务停止继续等待 Harness 公开控制 RPC。
- `@` 候选菜单现在同时支持工作区文件和 Session；Session 按公开目录/搜索结果匹配，并插入官方 `dsh-session:` Markdown mention。
- 递归渲染嵌套 MCP/ACP/PTC 内容中的持久图片附件，工具卡也复用现有附件懒加载与缓存。
- 新增通用插件设置卡片：基于公开 `settings.describe/mutate` 编辑非敏感字段，使用 revision 防止并发覆盖，密钥字段只显示配置状态。
- 安全 Markdown 渲染器支持表格、对齐和单元格内联 Markdown；窄侧栏自动提供横向滚动。
- 修复 `zh-Hans` VS Code 语言环境下命令面板仍显示英文的问题，并保留 `zh-cn` 语言包兼容。
- 修复命令面板中命令分类和标题重复显示 `DSH` 前缀的问题；现在每条命令只保留一个 `DSH` 分类前缀。
- Provider 管理在加载 Runtime/配置时显示进度；没有可枚举 Provider 时提供明确的 Web UI 入口，不再静默无响应。
- Provider 管理列表现在只显示已配置路由；未配置 Provider 统一引导到 dsh Web UI。
- “高级配置”统一打开 dsh Web UI；即使 Runtime 尚未启动，扩展也会先启动并再打开浏览器。

## [0.5.3] - 2026-08-22

- 修复 pnpm 启动 DSH 时 compaction 的 `--patch` 参数顺序错误：现在会在 Web 参数前传给 DSH 启动器，不再被 Web 命令误报为未知选项。

## [0.5.2] - 2026-08-22 [YANKED]

> 此版本已撤回（yanked），请使用 `0.5.3` 或更高版本。

- 修复交互卡片残留显示的问题：审批、计划评审和提问区域现在按顺序只展示当前待处理的卡片，已解决的卡片不再重复出现；提交中的卡片会保留到结果返回后，再自动切换到下一个等待项。
- Runtime 启动默认改用 `pnpm dlx @deepseek-ai/dsh web --no-open`，以规避 npx 的依赖解析问题；pnpm 不可用时自动回退到 npx，且扩展自行拉起 Runtime 时不再打开浏览器窗口。
- 新增 `dsh.npxTimeoutMs` 设置：控制等待包管理器下载 DSH 包并启动 Web 服务的最长时间。
- 新增 `dsh.npmRegistry` 设置：下载或启动失败时自动改用备用 npm registry 重试一次（默认 npmmirror；当前已在使用 npmmirror 时改试官方源），留空可禁用回退。
- 优化发版流程：新增 `npm run release` 脚本，统一完成测试、版本号提升、CHANGELOG 归档与打 tag；发布流水线支持手动按已有 tag 重跑，并新增 Open VSX 发布步骤。

## [0.5.1] - 2026-08-18

- 新增原生“对话大纲” TreeView：按当前会话的用户消息生成导航节点，点击即可跳转到对应消息。
- 新增 `Conversation Navigation API`，允许配套扩展注册自定义对话里程碑。
- 修复 `/effort` 在新会话或 effort 选项尚未加载时无法打开滑块的问题；现在会先加载选项，再打开聊天内控件。
- 新增可配置的 Agent 状态文案，支持每轮流式输出随机选择候选文本，并保留插件覆盖 API。
- 感谢 [dsh-reasoning-effort](https://github.com/HanaAyane/dsh-reasoning-effort) 提供跑步 sprite 参考与素材，也感谢 `dsh-milestone` 对对话里程碑导航设计的启发。

## [0.5.0] - 2026-08-16

- 新增深色模式适配，聊天、活动面板、Trace 和 Token 使用界面颜色与 VS Code 主题保持一致。
- 新增从 CNB 安装完整 Runtime 与 Standalone 镜像的能力，并增强下载进度和 HTTP 请求结束处理。
- 新增 LSP 集成、Web Search 卡片和 TODO 卡片展示，补充更多 Harness 任务状态反馈。
- 新增 Preset 管理，支持创建和选择自定义 Agent Preset；`/preset` 可作为 `/mode` 别名使用，并显示当前 Preset。
- 优化 Slash Command 在空工作区中的处理，支持 `/compact`，并修复 `/model` 在新对话中误创建空 Session 的问题。
- 新增 effort 滑块和图片附件入口，改善发送前的任务参数配置。
- 优化 Workspace 管理及 Runtime 发布流程。

## [0.3.0] - 2026-08-14

- 新增紧凑的 Token 与上下文统计入口：使用环形进度展示估算占用，并在独立浮层中展示当前模型、reasoning effort、计费输入/输出、推理 Token 和缓存命中；数据来自 Harness 公开 usage/context projection，并明确区分计费值与估算值。
- 新增文件跳转：支持聊天回答、工具参数与结果、Trace 摘要及详情中的裸文件路径和 `path:line[:column]`，裸路径默认打开第 1 行；Extension Host 会校验工作区信任、真实文件、符号链接和工作区边界后再打开编辑器定位。
- 新增编辑器快捷任务：可从编辑器选区、当前文件或 Source Control 的 Git diff 右键入口预填“解释、修复、审查、生成文档”prompt；内容保持可编辑且不会自动提交，菜单会跟随 VS Code 语言显示中文或英文。
- 新增全界面国际化：扩展命令、设置说明、通知与选择器、聊天 Webview、Activity Dock、Token 面板和 Trace 均支持英文与简体中文，并跟随 VS Code 显示语言。
- 新增按 turn 汇总的变更审查面板：在 Git 工作区展示新增、修改、删除和重命名文件，并使用 VS Code 原生 diff 查看稳定快照；整轮恢复前会检测任务结束后的用户修改、路径占用和符号链接父路径，发生冲突时拒绝覆盖。
- 优化 Runtime 启动体验：`dsh.autoStart` 默认在扩展激活时启动或连接 DSH，“未启动”和“错误”状态可直接点击启动或重试；连接成功后会自动恢复工作区上次会话并加载完整历史。
- 新增 `@` 文件引用实时候选：根据输入内容查询工作区文件，排除 `.git` 和 `node_modules`，点击候选项即可插入引用。
- 增强发送前上下文反馈：附件显示字节大小和截断状态，并汇总本次实际进入 prompt 的上下文数量与大小。
- 更新 Marketplace 描述，突出流式任务、持久会话、Trace、变更审查和 Token/上下文可观测性。
- 增强 Runtime 发现：按配置路径、PATH、npm 全局目录和 `npx --no-install` 顺序查找 dsh，并记录最终来源。
- 修复 Windows 下启动 `.cmd`、`.ps1` 和 `npx.cmd` 可能触发 `EINVAL` 的问题。
- 增强 `@` 文件引用候选：支持路径模糊匹配，当前活动文件置顶，过滤常见构建和元数据目录。

## [0.3.2] - 2026-08-14

- 新增资源管理器入口：文件和目录右键可将目标路径与 workspace root 预填到 DSH Chat，不会自动发送或读取文件内容。
- 新增 `DSH: Diagnose Environment`：输出脱敏的 VS Code、Node、平台、工作区信任、命令发现、npm 全局目录、Runtime 健康状态和 API Key 引用诊断。
- 修复 Windows 下 npm 全局前缀查询无法通过 `.cmd` 启动器执行的问题，并保留 `.cmd`/`.ps1` Runtime 启动兼容性。

## [0.4.1] - 2026-08-16

- 新增 Provider 管理：可查看 Provider 启用、配置及凭据状态，设置或移除 API Key，并从命令面板或聊天菜单打开 Harness 官方配置文件进行新增和高级编辑。
- 支持安全删除纯用户层自定义 Provider；删除操作按 Harness 设置 revision 执行，并且仅清理由该 Provider 约定名称独占管理的凭据，避免误删共享 Key。
- 新增 `$` Skill 候选，并在 `/` 候选中同时展示 Harness Skill；选择后插入官方 `/skill-name` 调用语法。
- 修复新对话草稿态无法使用 `/mode`，以及尚未发送 prompt 时错误创建空 Session 的问题。
- 优化新对话的 Workspace 归属：可在当前 VS Code 文件夹尚无 Session 时直接建立本 Workspace 对话，也可继承当前所选 DSH Workspace 创建新对话。
- 修复第二个 VS Code 窗口无法复用随机端口 Runtime 的问题：启动者会把经过限制的 loopback URL 写入进程锁，后续窗口通过 `host.describe` 验证后连接已有 Harness，避免再次启动写进程。

## [0.4.0] - 2026-08-15

- 新增 Workspace 注册与 Session 归属：创建会话前自动注册当前工作区，避免新会话全部落入未分组状态。
- 新增按 VS Code 文件夹自动发现并恢复已有 DSH Session；打开曾在 Web 中建立过工作区的文件夹时可继续使用原会话和历史记录。
- 优化 Webview 会话选择器：按 Workspace 分组展示会话，并为历史或未关联工作区的会话提供“未分组会话”兜底分组。
- 扩展 Harness Workspace RPC 集成，支持读取工作区列表及按工作区筛选会话，为跨 Web 与 VS Code 的工作区复用提供基础。
- 增强 Trace Timeline：按可见事件的实际时间范围绘制时间轴，保留空闲间隔并改善 CSP 下的时间条定位。
- 修复跨 DSH Workspace 切换 Session 后发送消息会因 VS Code 当前目录不同而误建新会话的问题。
- 修复多窗口或多进程启动 Runtime 时的竞争：优先复用已存在的 Harness，并通过插件锁避免重复启动写入同一会话存储。
- 修复默认端口被占用时无法启动的问题：按 Harness 默认端口 `3080` 探测，未配置端口时交由操作系统分配空闲端口，并校验 `host.describe` 后才复用服务。

## [0.2.2] - 2026-08-14

本版本修复扩展图标缺失问题，并完善 DSH 的 IDE 品牌识别。

- 新增 Marketplace 扩展图标，解决扩展详情页不显示图标的问题。
- 更新 Activity Bar 图标：采用基于 DeepSeek Harness 鱼形标识的社区二次设计，并加入蓝色代码标记。
- 补充 DeepSeek Harness 图标来源与 MIT 许可说明。
- 完善 Slash Command，支持通过 `/mode` 切换 Harness 的四种 Agent Preset。
- 优化中英文 README、Marketplace 简介和自动发布流程。

## [0.2.1] - 2026-08-14

本版本重点重构了聊天界面，并补充模型选择和 Slash Command 支持。

- 使用 React 重构 Chat View，重新设计消息区、工具卡片、交互卡片、活动面板和输入区。
- 支持 Goal、队列、Subagent、Jobs 和权限状态的折叠展示。
- 新增模型选择功能。
- 新增 Slash Command 菜单，支持 `/ide`、`/new`、`/search`、`/model`、`/mode`、`/focus`、`/trace` 和 `/stop`；`/mode` 可动态选择 Harness Agent Preset。
- 更新中英文 README 和发布流程。

## [0.1.0-alpha]

- 首个社区预览版本，提供 `dsh web` Runtime 集成、侧栏聊天和 IDE 上下文附加。

[0.9.0]: https://github.com/HarcoChen/dsh-vsc-integration/compare/v0.7.0-beta.1...v0.9.0
[0.7.0-beta.1]: https://github.com/HarcoChen/dsh-vsc-integration/compare/v0.6.2...v0.7.0-beta.1
[0.6.2]: https://github.com/HarcoChen/dsh-vsc-integration/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/HarcoChen/dsh-vsc-integration/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/HarcoChen/dsh-vsc-integration/compare/v0.5.3...v0.6.0
[0.5.3]: https://github.com/HarcoChen/dsh-vsc-integration/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/HarcoChen/dsh-vsc-integration/compare/v0.5.1...v0.5.2
[0.4.1]: https://github.com/HarcoChen/dsh-vsc-integration/compare/v0.4.0...v0.4.1
[0.5.0]: https://github.com/HarcoChen/dsh-vsc-integration/compare/v0.4.1...v0.5.0
[0.5.1]: https://github.com/HarcoChen/dsh-vsc-integration/compare/v0.5.0...v0.5.1
[0.4.0]: https://github.com/HarcoChen/dsh-vsc-integration/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/HarcoChen/dsh-vsc-integration/compare/v0.3.0...v0.3.2
[0.3.0]: https://github.com/HarcoChen/dsh-vsc-integration/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/HarcoChen/dsh-vsc-integration/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/HarcoChen/dsh-vsc-integration/compare/v0.1.0-alpha...v0.2.1
[0.1.0-alpha]: https://github.com/HarcoChen/dsh-vsc-integration/releases/tag/v0.1.0-alpha
