# Simple Open Chat Federation Protocol 规范

本目录发布面向独立实现者的 **Simple Open Chat Federation Protocol**（SOCFP）。规范正文只定义
节点之间可观察、可互操作的 wire contract。SOMS 是本协议的参考实现；其实现审计、内部设计和
运维说明位于 [`docs/`](../docs/)，不具有覆盖本规范的效力。

## 目录约定

```text
spec/
  README.md                 发布规则与版本索引
  RELEASE.json              机器可读版本与发布状态
  LICENSE                   可随 spec/ 独立分发的许可证
  GOVERNANCE.md             变更、决策与发布治理
  SECURITY.md               协议安全报告与支持策略
  v1/
    README.md               v1 状态和阅读顺序
    CHANGELOG.md            v1 发布候选版本变更记录
    CONFORMANCE.md          v1 合规范围与模块依赖
    protocol.md             主协议正文
    transport-security.md   发现、TLS、密钥与 HTTP Message Signature
    recognition.md          双向服务器认可与身份连续性
    state-feed.md           state-feed 完整 wire schema
    message-feed.md         message 压缩索引 feed 与 thread query
    message-tombstone-feed.md tombstone 压缩索引 feed 与 thread query
    message.md              message content type 总览与入口
    message/                message envelope 与各 content type 分主题规范
    resources.md            profile、media 与 forward bundle
    calls.md                WebRTC、通话状态机与 TURN 边界
    errors.md               稳定错误码与 caller action
    schema/                 JSON Schema、HTTP manifest 与 conformance 向量
```

十份规范性正文（主协议及九份专题规范）共同定义 v1；同版本的机器可读发布包用于自动校验。正文与 Schema、测试向量或工具
不一致时，以规范性正文为准，并应在同一发布候选版本中修复其他制品。

协议变更与发布按 [Governance](./GOVERNANCE.md) 执行；安全问题按 [Security Policy](./SECURITY.md)
处理。当前版本的 wire-level 变化见 [v1 Changelog](./v1/CHANGELOG.md)。`RELEASE.json` 提供供发布工具读取的
版本元数据，但不改变规范正文。

## 发布状态

- `DRAFT`：协议范围或模型仍可能改变，不应作为稳定互操作目标。
- `RELEASE CANDIDATE`：模型和必选功能已经闭合，允许编辑性澄清和一致性修正；冻结前发现的协议缺口
  仍可修复，但必须在发布说明中标出 wire-level 变化。
- `FINAL`：当前 major 的 wire contract 已冻结；不兼容变化只能进入新的 URL major version。
- `SUPERSEDED`：已被后续 major 取代，保留用于兼容实现和历史查阅。

当前发布是 [Simple Open Chat Federation Protocol v1.0-rc.2](./v1/README.md)。任何声称兼容本协议的
实现（包括 SOMS）都必须通过测试证明与它一致；实现代码、实现审计、Schema 和示例都不能单独改变
协议正文的含义。

本协议当前没有升级为 `FINAL` 的发布计划。维护者仍按可冻结协议的完整性、安全性、注册和互操作要求
维护每个 release candidate；满足这些要求只表示 RC 达到相应质量基线，不自动改变其发布状态。

`v1.0-rc.2` 使用协议自有的 discovery 标识 `/.well-known/socfp` 与 `_socfp._tcp`。早期 SOMS 实现使用的
`/.well-known/soms` 与 `_soms._tcp` 不属于本发布，兼容迁移必须由实现另行明确提供，不能改变本规范的
合规接口面。
