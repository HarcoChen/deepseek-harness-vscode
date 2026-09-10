# DSH 0.1.5-rc.1 适配审计

目标：`dsh-v0.1.5-rc.1@183f08e9c6dde7e36cd2318eaee70b0da08fb35e`。
比较基线：`dsh-v0.1.2-rc.1@a66e4702047846cdaa10c66c9d3df3951f5ea70d`。
本地 `deepseek-harness/` 的更晚 HEAD 仅作阅读便利，协议实现以目标 tag 为准。

## 设计与实施范围

保留现有 HTTP unary、Remote mux、领域 Store 与 React Webview。变化在协议边界解码，临时 Assistant 输出独立于持久化 seq；不新增单元测试，使用现有回归检查及真实 Runtime 集成冒烟。

1. 审计 endpoint 参数、返回类型、Remote event allowlist、follow/page/control、V3 surface 与 Assistant stream。
2. `src/assistantStream.ts` 校验和展开压缩 stream，按连接内 revision、attemptId、chunk index 验证实时帧及其持久化结算。
3. `src/remote/sessionState.ts` 转换 V3 `startSeq/endSeq`；`stateCoordinator.ts` 订阅并重建 transient baseline、拒绝丢帧，隔离旧连接的翻页结果。
4. `sessionStore.ts` 保存独立 transient state；聊天、Trace 分别投影可见回答、失败 attempt、系统消息和 PTC 事件。
5. 修正命令、子代理参数及 Goal activation，并同步版本 pin、模型 catalog 和用户文档。
6. 编译、现有测试、真实 Runtime 冒烟后审查差异并提交。

## 契约变化与对应实现

| 上游契约 | 扩展处理 |
| --- | --- |
| `/api/<namespace>/<method>`、`{args}`、`remote.mux`、`$events` 保持 | 保留 carrier 与鉴权交换 |
| `session/follow.request.assistantStream: true`；snapshot 包含 `assistantStream` | 必须接收 opening baseline；revision 连续、每 attempt 的 index 连续；断线清除 transient，重新采用 opening prefix |
| durable `assistant/message` / `assistant/attempt` 内嵌 `stream` | 展开 `chunk`、`text-chunks`、`reasoning-chunks`、`tool-call-chunks`；`dt` 逐项累加，保留 delta 边界 |
| transient `start/chunk/end`；end 引用结算 seq/type | transient 不写入 durable event store；匹配 turn/step 且 seq 晚于 start 的结算到达后隐藏 transient；end 校验引用，不重复回答 |
| surface 替换范围 `startSeq/endSeq`；新增 `system/message` | wire 层转成内部范围字段；系统消息参与模型 surface，聊天展示 append-origin 对话，Trace 可检查替换 |
| `commands/execute(agent, line, submittedAttachments)`；`input.attachments` | 图片加 `type: image` 判别字段；参数名和命令元数据同步 |
| `subagents/prompt(request)` 必填 `delivery` | 顶层 `{request}`，当前跟进动作显式 `delivery: queue` |
| Goal `activation` 可为 `armed/disarmed`；`goal/activation-changed` | 对齐目标 ID/revision 的独立实时状态，active+disarmed 时提供 Resume |
| `tool/ptc-dispatch-start` / `tool/ptc-dispatch` | Trace 按 subCallId 配对，并保留嵌套归属 |
| 上游正式 `deepseek-flash` catalog | 删除临时 expires-on-0910 模型注入，采用服务端描述 |

相关上游源码：`packages/api/session-controller/src/types.ts`、`history.ts`、`client/transport.ts`、`client/sessions/assistant-stream.ts`；`packages/core/session/src/{types,surface}.ts`；`packages/llm/llm/src/assistant-stream.ts`；`packages/interaction/commands/src/index.ts`；`packages/subagent/subagent/src/control-types.ts`；`packages/client/ui-goal/src/client/activation-source.ts`。

Workspace follow、session/control 的 queue/jobs/projection、会话 catalog/modelSelection、settings/credentials、审批及提问 waterfall 沿用相同契约。新版额外的 Web Sidebar 和文件上传界面不属于本次现有扩展能力兼容迁移。

## 发布和验证边界

- 官方 npm 已发布 `@deepseek-ai/dsh@0.1.5-rc.1`，默认包管理器启动固定该版本。
- 2026-09-10 检查 CNB `harcochen/dsh-runtime` 的 `v0.1.5-rc.1` 返回 404。默认下载版本已同步，但镜像未发布前无法验证 standalone 的五平台资产、安装和启动。使用默认 pnpm/npx 或已有实例。
- V3 迁移由 Runtime 执行，保留旧文件；扩展不重写用户的 Session 日志。旧 Runtime 不支持读取升级后的 V3 文件。
- 冒烟必须使用临时 DSH_HOME 和工作目录，不向付费模型发请求、不访问现有用户 Session。

## 已执行验证（2026-09-10）

- `npm test`：Host / Webview 类型检查、编译及现有 50 项测试全部通过；未新增或修改单元测试。
- `git diff --check`：通过。
- `scripts/verify-remote-runtime.mjs`：使用官方 npm `@deepseek-ai/dsh@0.1.5-rc.1` 实例通过真实协议联调。验证鉴权、unary / mux / events、Workspace 和 Session 创建、V3 Zstandard 历史分页、实时标题投影、断线重新订阅。
- 流式联调：观察真实 `start/chunk/end` 帧，在回答中途重连后恢复 `Hello` 前缀，最终仅保留一条 `Hello world`。两次模型请求均到进程内回环模拟服务，没有外部模型调用；本轮临时 Session 和设置已清理。
- Goal：创建、暂停、恢复、清除及 `armed/disarmed` 事件均通过；命令验证 `submittedAttachments` 参数封装，子代理跟进验证 `request.delivery` 正确到达缺失子代理的业务校验。
- 尚未实测：VS Code 中的手动 UI 交互、审批/提问完整流程、成功执行的子代理工具生命周期、实际图片附件处理，以及缺失 CNB 镜像的 standalone 安装。子代理参数冒烟不等同于完整子代理执行测试。
