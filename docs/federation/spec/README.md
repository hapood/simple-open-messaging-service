# SOMS Federation 规范发布区

本目录只存放已经定稿、面向独立实现者的联邦规范。实现审计和设计背景留在上级目录，不能覆盖
这里的 wire contract；已完成的 Federation 工作清单已经删除。

## 目录约定

```text
spec/
  README.md                 发布规则与版本索引
  v1/
    README.md               v1 状态和阅读顺序
    protocol.md             主协议正文
    state-feed.md           state-feed 完整 wire schema
    message-feed.md         message-feed 与所有消息类型
    calls.md                WebRTC、通话状态机与 TURN 边界
    errors.md               稳定错误码与 caller action
    schema/                 JSON Schema、HTTP manifest 与 conformance 向量
```

五份正文共同定义 v1；同版本机器可读发布包用于自动校验。发生冲突时以当前版本的规范正文为准，
并立即修复 Schema、向量或工具。

## 状态与权威性

- `FINAL`：当前 major 的 wire contract 已冻结；不兼容变化只能进入新的 URL major version。

当前版本是 [Federation v1](./v1/README.md)。SOMS 实现必须通过测试证明与它一致；实现审计文档不能
覆盖协议正文。
