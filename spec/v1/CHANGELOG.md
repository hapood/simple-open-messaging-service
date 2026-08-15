# Simple Open Chat Federation Protocol v1 Changelog

## v1.0-rc.2

状态：`RELEASE CANDIDATE`

本版本将协议身份从 SOMS 参考实现中分离。URL major 仍为 `/s2s/v1`，但下列标识发生不兼容变化：

- 协议名称改为 **Simple Open Chat Federation Protocol**（SOCFP）；
- discovery path 从 `/.well-known/soms` 改为 `/.well-known/socfp`；
- DNS SRV owner 从 `_soms._tcp` 改为 `_socfp._tcp`；
- JSON Schema ID namespace 从 `urn:soms:federation:v1:*` 改为 `urn:socfp:v1:*`；
- signing certificate `usage` 从 `soms-http-message-signature` 改为
  `socfp-http-message-signature`；
- message entity URI scheme 从 `soms://` 改为 `socfp://`，并移除没有参与协商的冗余 `?v=1` query。

RC.2 不把旧标识定义为别名，也不允许通过 discovery 协商这些旧标识。需要迁移既有 SOMS 部署的实现可以
临时提供双栈入口，但该行为不属于 SOCFP v1 合规接口面，且不能降级已经发现为 SOCFP 的 peer。

Conformance CLI 已与 SOMS 源码常量和服务类解耦；发布包可以独立校验 Schema、HTTP manifest、错误注册表
和签名向量。

## v1.0-rc.1

状态：`RELEASE CANDIDATE`（历史工作版本）

首个闭合 v1 模型的发布候选版本，仍使用 SOMS 品牌的 wire identifiers。它已被 rc.2 取代，不应作为新的
互操作目标。
