# SOMS Federation v1

状态：`REVIEW`

本目录是 Federation v1 的规范发布制品。规范描述独立实现必须遵守的 protocol contract；SOMS 的表、
worker、队列、UI 和本地产品限制只可作为明确标注的非规范性实现说明。

## 阅读顺序

1. [主协议](./protocol.md)：角色、版本、HTTP surface、共享类型、响应、持久状态和演进规则。
2. [传输与安全](./transport-security.md)：well-known、root/signing key、SRV、TLS、authority、digest 和 HTTP Message Signature。
3. [服务器认可](./recognition.md)：双向 Recognize、root public key pin、Healthy 可用性查询、降级状态、时序和失败处理。
4. [State Feed](./state-feed.md)：完整 page、五种 state event 与字段级合并语义。
5. [Message Feed](./message-feed.md)：完整 page、10 种联邦消息类型、媒体和转发。
6. [语音与视频通话](./calls.md)：WebRTC 标准栈、S2S frame、状态机与 AUDIO→VIDEO 升级。
7. [错误码注册表](./errors.md)：稳定错误码、HTTP status、重试与 identity action。
8. [机器可读发布包](./schema/README.md)：JSON Schema、HTTP manifest、正反向量与 conformance CLI。

同目录的 JSON Schema、HTTP manifest、正反向量和 conformance CLI 与规范性正文一起发布，作为
非规范性验证资源。它们不是节点运行时协商的一部分，也不能改变规范性正文；发现阶段只通过
`protocolVersions` 选择共同 major。
