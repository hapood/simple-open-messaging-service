# TODO 01：冻结 v1 Surface 与版本规则

状态：`OPEN`

## 目标

冻结 Federation v1 的完整 endpoint surface，确认协议版本与软件版本分离，并保证宣称 v1 就
实现完整 v1。

## 非目标

不设计字段 schema、错误 envelope 或 v2。

## 工作内容

- 枚举 `/.well-known/soms` 和全部 `/api/v1/s2s/*` 路由。
- 为每个 endpoint 核对 producer、consumer、测试和恢复路径。
- 裁决 `/messages/before`：补齐 SOMS consumer 或从 v1 删除。
- 将 `/identity`、`/discovery-hwm`、`/missed` 纳入基线。
- 冻结 `/v1` 为 wire major version；`software` 仅用于诊断。
- 删除 capabilities 以及 `mediaRange`、`messageBackwardPaging` 等能力位。
- 定义 v1 冻结后允许与禁止的变更。

## 交付物

唯一 endpoint 清单；单边端点裁决；版本/路由测试；更新基线和闭环审计。

## 验收 Check

- [ ] 所有 S2S 路由都被清单覆盖。
- [ ] 每个端点有 producer/consumer，或有明确合理的单向角色。
- [ ] `/messages/before` 已闭环或删除。
- [ ] 通话等端点确认处于 `/api/v1`。
- [ ] capabilities 已删除。
- [ ] 软件版本与协议版本规则有测试。
- [ ] build 与相关测试通过。
- [ ] 节点总结完整且没有未登记敞口。

## 节点总结

待执行时填写。
