# DSH `0.1.2-rc.1` Remote RPC 适配方案

> 历史方案：以下章节记录首次 RC Remote 迁移。当前适配目标已升级至 `0.1.5-rc.1`，增量审计、实现及验证见 [RPC_0.1.5_ADAPTATION.md](./RPC_0.1.5_ADAPTATION.md)。旧版本号不再代表当前默认值。

## 1. 目标与结论

本方案以 [`RPC_new.md`](./RPC_new.md) 的审计结果和 `deepseek-harness` 的 `dsh-v0.1.2-rc.1` 源码为依据，目标是让 dsh-ide 完整支持默认托管 Runtime `0.1.2-rc.1`，而不是只修复根路径 token/cookie 鉴权。

建议采用以下路线：

1. **把 RC+ Remote 协议作为唯一主实现**，不在同一状态机内混跑旧 `apiproxy` 和新 Typert Remote。
2. **保留 dsh-ide 自己的 UI/domain store**，实现一个轻量、严格的 Remote carrier；不直接引入上游整套 Cordis Client Runtime。后者会带入 Gateway、Typert registry、生成 contribution 和大量 workspace 包，和当前 VS Code 扩展的宿主架构不匹配。
3. **在 Runtime facade 后完成迁移**。`ChatView`、`TracePanel`、workspace actions 等继续调用 `DshRuntime` 的领域方法，不接触 endpoint、`args`、streamId 或 RemoteError wire 细节。
4. **旧 Runtime 明确拒绝并给出升级提示**。如后续产品确实要求兼容 `0.1.1`，再以独立 `LegacyApiProxyAdapter` 实现；不得在 RC store 中夹入旧 frame 分支。

默认 Runtime 已固定为 `0.1.2-rc.1`，因此先做单协议迁移能最短路径恢复完整功能，同时避免长期维护两套历史合并和重连语义。

## 2. 适配边界

### 必须完成

- unary：`/api/<namespace>/<method>`、`payload: {args: ...}`、严格顶层参数名；
- stream：单物理 WebSocket `/api/remote.mux`，承载多个 `open/cancel/item/error/end` logical stream；
- connection generation：以 `$events` 的 `ready` 为连接就绪边界；
- state：`workspace/follow`、`session/control`、按地址建立的 `session/follow`、`session/page`；
- event：普通 Remote event 和 approval/question waterfall 的应答；
- error：namespaced `RemoteError`、HTTP/auth、carrier、协议校验四类错误分层；
- feature：当前 dsh-ide 已使用的 session、workspace、preset、goal、subagent、command、feedback、settings、credentials、LLM、skills；
- diagnostics：输出协议代次、generation、logical stream 状态、已知 Runtime 版本和脱敏后的连接信息。

### 本轮不做

- 不新增单元测试，遵守仓库规则；
- 不为已经删除的 `host.describe`、`workspace.list`、`session.history` 建假兼容 endpoint；
- 不把 Remote wire frame 直接暴露给 React/webview；
- 不根据 token、401 或某一个错误码猜版本；
- 不自动支持 `0.1.3-alpha.1`。目标 tag 之后的变化需单独增量审计。

## 3. 总体架构

```text
DshRuntime（稳定的领域 facade）
├─ RemoteUnaryClient
│  └─ POST /api/<namespace>/<method> + { args }
├─ RemoteMuxClient
│  └─ WS /api/remote.mux
│     ├─ $events
│     ├─ workspace/follow
│     ├─ session/control
│     └─ session/follow × 当前订阅地址
└─ RemoteStateCoordinator
   ├─ CatalogStore       ← session/list + Remote events
   ├─ WorkspaceStore     ← workspace/follow baseline/increments
   ├─ SessionStore       ← session/follow snapshot/events + session/page
   └─ ControlStore       ← session/control baseline/replacements
                         ↓
                 ChatView / TracePanel / Actions
```

关键隔离原则：

- carrier 只理解 envelope、streamId、取消、终止和重连；
- contract 层只声明 endpoint 对应的 wire 参数和返回类型；
- coordinator 只把 Remote frame 转成领域 mutation；
- store 不再解析 WebSocket frame，也不持有 rpcId/streamId；
- UI 不判断 RemoteError code，只消费统一后的领域错误。

## 4. 文件级改造

建议新建 `src/remote/`，避免在旧协议文件里不断加入条件分支：

| 文件 | 职责 |
| --- | --- |
| `src/remote/contracts.ts` | 固定 `0.1.2-rc.1` endpoint、wire args、value、stream item 类型；文件头注明目标 tag/commit |
| `src/remote/unaryClient.ts` | HTTP envelope、超时/Abort、响应严格校验、RemoteError 恢复 |
| `src/remote/muxClient.ts` | 单 WebSocket、多 logical stream、streamId 分发、open/cancel、终止清理 |
| `src/remote/connection.ts` | physical generation、`$events ready` 握手、退避重连、generation scope |
| `src/remote/events.ts` | `emit/waterfall/cancel` 校验、订阅和 `$events/result` |
| `src/remote/sessionState.ts` | follow/page/control 编排、地址订阅和 snapshot/cursor 合并 |
| `src/remote/workspaceState.ts` | workspace baseline/increment 合并 |
| `src/remote/errors.ts` | transport/protocol/remote/domain 错误分类与 UI 文案映射 |

随后：

- `src/dshRuntime.ts` 改为调用新的领域 API，并继续作为 UI 的唯一入口；
- `src/harnessState.ts` 由旧 mux/host 协调器替换为 Remote state coordinator；
- `src/sessionStore.ts`、`src/sessionCatalog.ts` 改为接收明确的 mutation/snapshot，不再接收 `DshMuxFrame`/`DshHostFrame`；
- `src/harnessClient.ts`、`src/harnessConnection.ts`、`src/harnessProtocol.ts` 在迁移完成后删除或收缩为兼容命名的 facade；
- `src/types.ts` 移除旧 `server-request`、`DshMuxFrame`、`DshHostFrame` 类型，把 Remote DTO 按领域拆到 `src/remote/contracts.ts` 或相应 store 文件；
- `src/chatView.ts` 只需要适配 requestId、会话订阅生命周期和少量返回值变化，不应出现 `/api/` 字符串。

## 5. Wire 契约实现

### 5.1 Unary client

统一接口建议为：

```ts
call<K extends RemoteUnaryEndpoint>(
  endpoint: K,
  args: RemoteUnaryArgs<K>,
  signal?: AbortSignal,
): Promise<RemoteUnaryValue<K>>
```

请求必须满足：

```json
{
  "type": "client-request",
  "rpcId": "client-minted-id",
  "method": "session/list",
  "payload": {
    "args": {
      "request": { "cursor": "optional-cursor" }
    }
  }
}
```

这里必须纠正一个容易出错的理解：`args` 对应的是生成 descriptor 的**方法参数名**，不是把 DTO 摊平。例如：

| Host 方法签名 | 正确 wire args |
| --- | --- |
| `session.list(request, signal)` | `{request: {...}}` |
| `session.modelCatalog()` | `{}` |
| `workspace.follow(signal)` | `{}` |
| `settings.update(ns, patch, expectedRevision)` | `{ns, patch, expectedRevision}`；可选值允许按 descriptor 省略 |
| `goals.edit(agent, ref, request)` | `{agentId, ref, request}` |
| `commands.execute(agent, line, images, signal)` | `{agentId, line, images}` |

实现要求：

- endpoint 只能是规范的 `<namespace>/<method>`，内部 `$events/result` 作为显式保留项；
- URL endpoint 与 envelope `method` 必须完全一致；
- 成功响应允许 `value` 缺失，以表达 Remote 方法返回 `undefined`/`void`；是否允许缺失由 contract 声明，而不是只给某一个 endpoint 写例外集合；
- 失败响应恢复为结构化错误 `{code,message,details,isDSHRemoteError?}`，不依赖 `instanceof`；
- JSON 解析失败、rpcId 不一致、非法 envelope、非法 value 分别记为 protocol error，不伪装成业务 RemoteError；
- 401/403 是鉴权错误，404 是 method/capability 不可用，均不得自动降级为旧协议；
- 请求超时与调用方 Abort 分开报告，日志不得包含 token、Cookie、credential value 或 prompt 内容。

### 5.2 Remote mux

`RemoteMuxClient` 在一个 WebSocket 上维护：

- `Map<streamId, LogicalStream>`；
- 单调或 UUID streamId；
- 每个 stream 独立的 queue、AbortSignal 和 terminal state；
- socket generation id；
- 最大帧大小、JSON/字段校验和诊断计数。

打开与结束：

```json
{"type":"open","streamId":"s-1","endpoint":"session/follow","payload":{"args":{"request":{"address":{"kind":"session","sessionId":"..."}}}}}
{"type":"cancel","streamId":"s-1"}
```

```json
{"type":"item","streamId":"s-1","value":{}}
{"type":"error","streamId":"s-1","error":{"code":"session/not-found","message":"...","details":{}}}
{"type":"end","streamId":"s-1"}
```

必须定义以下竞态行为：

- Abort 只发送一次 `cancel`，并使本地 iterator 终止；
- `error` 和 `end` 都是 terminal，后续同 streamId frame 忽略并记诊断；
- 未知 streamId frame 不得创建隐式 stream；
- 物理 socket 关闭时，所有 logical stream 以 carrier error 结束；
- transport 不自行重放 open。由 connection/coordinator 在新 generation 中按固定顺序重建，避免旧 cursor 或旧 clientId 泄漏；
- Node `ws` 握手沿用当前鉴权 header，HTTP Cookie 仍按 origin/port 隔离。

### 5.3 Connection generation

每代连接按以下顺序建立：

1. 建立 `/api/remote.mux`；
2. 打开 `$events`，payload 固定 `{args:{}}`；
3. 第一项必须是 `ready`，保存本 generation 的 `clientId` 和 `host.home`；
4. 打开 `workspace/follow` 与 `session/control`，各自等待首个 baseline；
5. 执行 `session/list` baseline；
6. 重建当前 UI 真正订阅的 `session/follow`；
7. baseline 全部就绪后发布 `connected`，再向 webview 推送一致快照。

任一步出现非法首帧、Remote stream error、socket 关闭或超时，都撤销整个 generation，清空 generation-scoped `clientId`/streamId/AbortController，经过带 jitter 的指数退避后重连。旧 generation 的异步完成不得写入新 store，可用 generation token 做提交前校验。

## 6. 状态同步方案

### 6.1 Workspace

`workspace/follow` 是唯一权威源：

- 首帧 `baseline` 原子替换 workspace items 与 archivedSessionIds；
- 后续 `upsert/remove/order/archived` 按到达顺序应用；
- baseline 到达前不发布 increment；
- 重连后只接受新 generation baseline，不把旧 order 和新增量拼接；
- workspace mutation 的 unary 返回值可立即乐观更新，但 follow frame 最终校准；如两者冲突，以同 generation follow 为准。

### 6.2 Session catalog

catalog 来源拆开：

- `session/list`：连接代的完整会话列表基线；
- `$events`：`api-session/added`、`removed`、`status`、`activity`、`error` 增量；
- `session/control` projection：标题、goal/model 等需要在列表展示的投影；
- `workspace/follow`：workspace 归属、顺序和归档集合。

应给 catalog 增加 `replaceGenerationBaseline()`，一次性提交 session/workspace/control 三类 opening state。这样 webview 不会短暂看到“新 session 列表 + 旧 workspace 顺序”。

### 6.3 Session history/follow

每个可见会话使用 `SessionAddress`：

```ts
{ kind: "session", sessionId }
{ kind: "subagent", parentSessionId, childSessionId, mode }
```

普通会话与子代理共用同一套历史读取，不再保留 `subagent.history` 特例。

流程：

1. 为当前主会话/打开的子代理建立 `session/follow({request:{address,maxMessages}})`；
2. 首个 `snapshot` 原子安装 `header/cursor/records/hasMore/projections`；
3. 后续 `event` 要求 seq 连续；重复 seq 幂等忽略，前跳视为 protocol gap 并重开该 follow；
4. 向上翻页调用 `session/page({request:{address,throughSeq,beforeSeq,maxMessages}})`；
5. 同一次 pagination 的 `throughSeq` 固定为 opening snapshot 的 cursor，避免翻页过程中把新事件混入历史窗口；
6. 新实时事件继续追加到 tail，旧 page 只向 head 合并；
7. `SessionHistoryRecord` 的 `event` 与 `chunks` 两种记录先经过 normalization，再交给现有消息 projector。

订阅策略建议只跟随：当前会话、打开的 trace 会话和正在查看的 subagent。不要为整个历史 catalog 永久打开 follow stream；全局 queue/job/projection 已由 `session/control` 提供。

### 6.4 Control

`session/control` 首帧是完整 baseline，后续是按 session 的 replacement：

- `queue` 整组替换指定会话队列；
- `jobs` 整组替换指定会话 jobs；
- `projection` 按 key + seq 更新；
- baseline 中缺失的 session 视为空，不沿用上一代值；
- control 与 follow 的 projection 按 seq 合并，旧 seq 不覆盖新 seq。

### 6.5 Prompt 幂等

发送 prompt 前生成并持久保留一个 `requestId`：

- 一次用户提交、超时重试和重连对账复用同一个 requestId；
- 用户明确再次发送才生成新 requestId；
- optimistic message 以 requestId 为键；
- control queue item 的 `rpcId` 或 durable user message source 命中 requestId 时，退休 optimistic echo；
- `accepted:true` 只表示进入 Agent inbox，不表示 durable message 已经可见，不能立即删除 optimistic 状态；
- mode、content、clientTimeZone 放在 `args.request` 内完整发送。

## 7. Remote event 与交互

`$events` 既是 Host event downlink，也是 generation readiness barrier。

普通 `emit`：

- 按 allowlist 事件名严格校验 args 的最小结构；
- 未消费但合法的事件可忽略并记录低级别诊断；
- catalog/settings/model/preset 的失效事件触发对应 refresh 或 mutation；
- 正确性依赖恢复的状态不得只靠 emit，必须有 baseline/query。

`waterfall`（approval、question）：

- 以 `eventId` 建立 pending interaction，并用 `agentId` 关联 session；
- UI 回答通过 unary `POST /api/$events/result`，wire 为 `{args:{clientId,eventId,outcome}}`；
- `clientId` 必须来自同一 generation；重连后旧回答拒绝发送；
- Host `cancel` 到达时立即撤销 UI 交互；
- 支持 `result`、`next`、`rejected` 三种 outcome；用户取消与处理器异常不能混为一类；
- 同一个 eventId 最多提交一次，提交中禁用重复操作。

这部分替换旧 `/api/respond`、host stream 和 `rpcId` receipt 逻辑。

## 8. Endpoint 迁移批次

### 批次 A：启动和核心会话（阻塞发布）

| 领域调用 | RC endpoint | args 外形 |
| --- | --- | --- |
| list/search/create/rename/fork/prompt/attachment/updateQueue/cancel | `session/<method>` | 通常 `{request:{...}}` |
| models | `session/modelCatalog` | `{}`；不再按 session 请求 |
| select model | `session/selectModel` | `{request:{sessionId,...}}` |
| history | `session/follow` + `session/page` | `{request:{address,...}}` |
| queue/jobs/projections | `session/control` | `{}` |
| workspace state | `workspace/follow` | `{}` |
| workspace mutations | `workspace/<method>` | `{request:{...}}` |
| host facts/events | `$events` | `{}`；ready 提供 `clientId`、`host.home` |

完成该批次后，扩展必须能启动、列出/创建/选择会话、收发消息、重连、翻页、取消和管理 workspace。

### 批次 B：交互和子代理（阻塞发布）

- approval/question：`$events` waterfall + `$events/result`；
- commands：`commands/list|execute`，wire 为 `agentId` 加方法参数；
- subagents：`subagents/list|prompt|interruptByParent`；历史统一走 `session/page|follow` 的 subagent address；
- skills：`skills/list`；
- message feedback：`messageFeedback/list|put|delete`。

### 批次 C：配置与扩展功能（发布前完成或明确 capability 降级）

- presets：`agentPresets/list|select|read|copy|deletePreset`；打开目录改为 `settings/openAgentPresetDirectory`；
- goals：`goals/create|edit|pause|resume|complete|clear`，全部携带 `agentId`，并按 `ref.revision` 处理 conflict；
- LLM：`llm/listProviders|listConfigurableProviders|discoverModels`；
- settings：`settings/describe|update|replace|mutate|openSettingsDocument`；
- credentials：`credentials/describe|set|unset`；
- path：`session/canOpenWorkspacePath|openWorkspacePath` 或 `directoryPicker/*` capability。

每迁移一个领域，就删除对应旧 endpoint 类型和 fallback；不能让一个领域同时调用点号与斜杠两套方法。

## 9. Capability 与版本策略

### 托管/扩展启动的 Runtime

- 以配置的 `runtimeVersion` 作为版本事实；
- 只接受方案验证过的 `0.1.2-rc.1` 协议代次；
- 更旧版本在启动前提示“不支持旧 ApiProxy 协议”；
- 更高版本不能只按 semver 假定兼容。若仍允许选择，应显示“未验证版本”，并在 Remote 握手/contract 失败时给出升级适配诊断。

### `dsh.serverUrl` 附加 Runtime

附加地址没有可靠版本字段，使用一次无副作用的 Remote capability probe：

1. 完成现有 token/cookie 鉴权；
2. 请求 `session/list`，payload 必须是 `{args:{request:{}}}`；
3. 合法 `server-response`（成功或结构合法 RemoteError）证明是 Remote v1；
4. 401/403 报鉴权错误；404 或非 Remote envelope 报“不支持的 RPC 协议”；
5. 结果绑定到 base URL + auth generation，端口、origin 或 token 变化后重新探测。

不采用“先旧后新”自动回退，避免把权限、descriptor 和部署缺包问题误判成版本差异。

## 10. 错误与用户提示

错误分四层：

| 层 | 示例 | 行为 |
| --- | --- | --- |
| auth/http | 401、403、TLS、代理失败 | 停止重试或按网络策略重试，提示连接/凭据问题 |
| carrier | WebSocket 关闭、超时、Abort | generation 重连；用户主动 Abort 不弹错误 |
| protocol | 非法 frame、rpcId/streamId 不匹配、首帧非 baseline | 撤销 generation，记录可诊断详情，提示 Runtime/扩展不兼容 |
| Remote/domain | `session/not-found`、`settings/conflict` | 按 code 执行业务恢复或展示文案 |

RemoteError 映射规则：

- 使用字符串 code，不使用 `instanceof`；
- 只对需要业务动作的 code 明确分支，例如 not-found 返回选择器、conflict 刷新 revision、agent-busy 保留提交；
- `gateway/arguments-invalid` 和 `gateway/result-invalid` 一律视为扩展与 Runtime 契约不匹配，不能显示成普通“请求错误”；
- 未知 namespaced code 显示服务端 message，日志记录 code 和脱敏 details；
- 不再维护 exhaustive 的旧 kebab-case union。

## 11. 实施顺序与提交边界

建议按以下可审查提交推进，每个提交都保持 TypeScript 可编译：

1. `refactor(remote): add rc contract and unary carrier`
   - 新 contract、unary client、RemoteError；暂不切换 UI。
2. `refactor(remote): add multiplexed stream generations`
   - mux、`$events ready`、取消/终止、认证 header、重连。
3. `refactor(state): migrate workspace and session control baselines`
   - workspace/control opening baseline 和 catalog 原子提交。
4. `refactor(state): migrate session follow and paging`
   - address、snapshot/cursor、page、chunks normalization、订阅生命周期。
5. `feat(remote): migrate prompts and interactive events`
   - requestId、approval/question、`$events/result`、commands/subagents。
6. `feat(remote): migrate settings presets goals llm and feedback`
   - 剩余业务 Remote 与 capability 降级。
7. `refactor(remote): remove legacy apiproxy protocol`
   - 删除旧 endpoint/frame/respond 路径，补诊断与本地化。
8. `release: validate dsh 0.1.2-rc.1 integration`
   - 完成 smoke checklist、变更说明和版本发布准备。

若某一步需要临时桥接，只允许 bridge 位于 `DshRuntime` facade 内，并在同一批次末移除；不向 store 或 UI 扩散双协议类型。

## 12. 验收方案

遵守“不新增单元测试”规则，使用现有检查、真实 Runtime smoke 和故障注入完成验收。

### 静态检查

- `npm run check`；
- `npm run compile`；
- `rg` 确认生产代码不存在：`events.mux`、`events.host`、`/api/respond`、`session.history`、`workspace.list`、旧点号 endpoint；
- 所有 `/api/` 字符串只存在于 remote carrier/runtime 启动模块；
- contract 文件标注 `dsh-v0.1.2-rc.1` 与 commit `a66e4702047846cdaa10c66c9d3df3951f5ea70d`。

### 真实 Runtime smoke

1. 托管 Runtime 首次安装、启动、token 鉴权和 Web UI 打开；
2. session 列表/search/create/rename/fork；
3. 新 prompt、queue、steer、cancel，重复/超时重试不产生重复 user message；
4. 历史首屏与多页向上加载，流式 assistant chunk 正确合并；
5. 切换会话和 trace 时只保留必要 follow stream；
6. workspace create/rename/order/session order/archive/delete；
7. model、preset、goal、command、feedback、settings、credential、skills；
8. continuable/one-shot subagent 展示、历史、prompt、interrupt；
9. approval 与 question 的 result、next、取消、重复点击保护；
10. 中途重启 Runtime/断开 WebSocket，恢复后无重复消息、无旧 queue/job、无 workspace 顺序回滚。

### 故障场景

- 无 token、错误 token、远程 HTTP、端口变更和不同 origin Cookie；
- endpoint 404、`gateway/arguments-invalid`、未知 RemoteError；
- logical stream 在 baseline 前 end/error；
- 非法 JSON、未知 streamId、重复 terminal frame；
- page `hasMore` 但 beforeSeq 不前进；
- 旧 generation unary/stream 结果延迟到新 generation；
- `$events` cancel 到达时 UI 正在提交 interaction outcome。

### 完成定义

只有同时满足以下条件才算适配完成：

- 默认 `0.1.2-rc.1` Runtime 的所有现有 UI 能力均走 RC Remote；
- 启动、重连、历史、workspace 和交互有明确 baseline/generation 语义；
- 生产代码不再依赖旧 ApiProxy endpoint、旧双 WebSocket 或 `/api/respond`；
- 未知 Runtime/RemoteError 能安全失败并给出可操作诊断；
- 静态检查、编译和完整真实 Runtime smoke 全部通过；
- 适配实现和文档在同一 PR 中注明目标 tag，未来升级先做 tag 增量审计。

## 13. 主要风险与控制

| 风险 | 控制措施 |
| --- | --- |
| 把 DTO 摊平进 `args` 导致全量 `arguments-invalid` | contract 以 Host 方法顶层参数名建模；审查 wire 样例 |
| 重连后旧异步任务污染新状态 | generation token + generation-scoped AbortController + 原子 baseline |
| 为所有 session 打开 follow 导致 logical stream 膨胀 | 订阅引用计数，只跟随当前会话/trace/subagent |
| optimistic prompt 重复 | client-minted requestId 持久到 durable 对账完成 |
| approval/question 回答串代 | outcome 强制携带同 generation clientId/eventId |
| 手抄类型随上游漂移 | contract 文件固定 tag/commit；每次 Runtime 升级先 diff generated descriptor/纯类型出口 |
| 直接引入上游 Client Runtime造成依赖与生命周期冲突 | 只复用协议定义和 DTO 语义，carrier 与 store 保持 dsh-ide 原生 |
| 为兼容旧版引入双状态机 | 当前明确 fail-fast；若确有需求，另建完整 Legacy adapter，不共享 wire/store reducer |

## 14. 后续升级门禁

每次修改默认 `dsh.runtimeVersion` 前必须：

1. 对上一个已支持 tag 与目标 tag 做 endpoint/descriptor/DTO/Remote event allowlist diff；
2. 核对 `stream-protocol.ts`、session follow/page/control、workspace follow 和 RemoteError；
3. 更新 `contracts.ts` 的目标 commit；
4. 重跑第 12 节的 smoke checklist；
5. 若目标是 alpha/master，禁止沿用“rc.1 大概率兼容”的假设。

这条门禁把协议升级从运行时猜测变为发布时验证，也能避免再次出现“鉴权已修复但 RPC 实际仍不可用”的假完成状态。
