# SOMS Federation 协议规范

本目录发布面向独立实现者的 SOMS Federation 协议。规范正文只定义节点之间可观察、可互操作的
wire contract；SOMS 的实现审计、内部设计和运维说明位于 [`docs/`](../docs/)，不具有覆盖本规范的效力。

## 目录约定

```text
spec/
  README.md                 发布规则与版本索引
  v1/
    README.md               v1 状态和阅读顺序
    protocol.md             主协议正文
    transport-security.md   发现、TLS、密钥与 HTTP Message Signature
    recognition.md          双向服务器认可与身份连续性
    state-feed.md           state-feed 完整 wire schema
    message-feed.md         message 压缩索引 feed 与 thread query
    message-tombstone-feed.md tombstone 压缩索引 feed 与 thread query
    message.md              message、content 与资源引用规则
    resources.md            profile、media 与 forward bundle
    calls.md                WebRTC、通话状态机与 TURN 边界
    errors.md               稳定错误码与 caller action
    schema/                 JSON Schema、HTTP manifest 与 conformance 向量
```

十份规范性正文（主协议及九份专题规范）共同定义 v1；同版本的机器可读发布包用于自动校验。正文与 Schema、测试向量或工具
不一致时，以规范性正文为准，并应在同一发布候选版本中修复其他制品。

## 发布状态

- `DRAFT`：协议范围或模型仍可能改变，不应作为稳定互操作目标。
- `RELEASE CANDIDATE`：模型和必选功能已经闭合，允许编辑性澄清和一致性修正；冻结前发现的协议缺口
  仍可修复，但必须在发布说明中标出 wire-level 变化。
- `FINAL`：当前 major 的 wire contract 已冻结；不兼容变化只能进入新的 URL major version。
- `SUPERSEDED`：已被后续 major 取代，保留用于兼容实现和历史查阅。

当前发布是 [Federation Protocol v1.0-rc.1](./v1/README.md)。SOMS 实现必须通过测试证明与它一致；
实现代码、实现审计、Schema 和示例都不能单独改变协议正文的含义。
