# Simple Open Chat Federation Protocol v1 Changelog

## v1.0.0-rc.0

状态：`RELEASE CANDIDATE`（尚未公开发布）

本版本将协议身份从 SOMS 参考实现中分离。URL major 仍为 `/s2s/v1`，但下列标识发生不兼容变化：

- 协议名称改为 **Simple Open Chat Federation Protocol**（SOCFP）；
- discovery path 从 `/.well-known/soms` 改为 `/.well-known/socfp`；
- DNS SRV owner 从 `_soms._tcp` 改为 `_socfp._tcp`；
- JSON Schema ID namespace 从 `urn:soms:federation:v1:*` 改为 `urn:socfp:v1:*`；
- signing certificate `usage` 从 `soms-http-message-signature` 改为
  `socfp-http-message-signature`；
- message entity URI scheme 从 `soms://` 改为 `socfp://`，并移除没有参与协商的冗余 `?v=1` query。
- `UserAccount` 允许 1–30 个字符；单字符账号在 wire 上是合法身份。

RC.0 不把旧标识定义为别名，也不允许通过 discovery 协商这些旧标识。需要迁移既有 SOMS 部署的实现可以
临时提供双栈入口，但该行为不属于 SOCFP v1 合规接口面，且不能降级已经发现为 SOCFP 的 peer。

Conformance CLI 已与 SOMS 源码常量和服务类解耦；发布包可以独立校验 Schema、HTTP manifest、错误注册表
和签名向量。

当前未发布候选还包含以下 message wire 收紧：

- 从通用 `FederatedMessage` 移除实现来源不明确且不参与消息 identity 的 `clientMessageId`；
- CALL record 在自己的 content 中使用必填 `callSid`；
- media content 和 GALLERY item 不再重复携带 `size`，共享 `BlobDescriptor.bytes` 是资源的唯一声明长度；
- LINK 的 `url`、`title`、`description` 和 `siteName` 均为必填字符串，后三者允许为空字符串。

RC.0 还增加受控、非核心 extension 机制：

- `/s2s/v1/discover` 的 `extensions[]` 是单向接收能力声明；Health 报告当前 peer 已实际启用的子集；
- `/s2s/v1/discover` 同时返回本方能力并提供异步、可合并的反向 capability refresh hint；
- `PROFILE`、`MEMBER_PROFILE` 和 `feed-heads` 可以携带受限 `extensions` object；核心 object 仍为 closed；
- extension message 使用 namespaced `contentType`。未知类型不持久化、不下载 asset、不生成 receipt，但允许
  message query cursor 前进；
- `socfp.*` 由协议保留，第三方 ID 使用反向域名前缀；不兼容修改必须分配新的 `.vN` ID。
