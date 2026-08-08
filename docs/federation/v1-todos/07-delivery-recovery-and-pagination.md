# TODO 07：冻结投递恢复、Cursor 与分页

状态：`OPEN`  
依赖：TODO 01、04、05

## 目标

验证 durable `/missed`、HWM、消息拉取和分页构成恢复闭环，并裁决旧 hint map 与 backward
paging 的 v1 地位。

## 工作内容

- 审计 `/init` 双方 `startChangeId` floor。
- 审计 discovery HWM、changeId 分配、事务、空洞、分页、cursor 和崩溃恢复。
- 冻结 feed event 到 messages/profile/roster/system event 拉取的映射。
- 删除旧 `/new-msg-map`，或明确其不可替代的 v1 职责。
- 补齐或删除 `/messages/before` consumer。
- 定义 cursor 起点/包含性/推进、并发 snapshot、部分成功、毒事件、quota pause、retention gap。

## 验收 Check

- [ ] 任意 committed change 最终可被目标 peer 发现。
- [ ] cursor 仅在本地副作用安全提交后推进。
- [ ] 重复页不会重复产生副作用。
- [ ] 永久坏事件不会无限阻塞或静默跳过。
- [ ] retention gap 有确定恢复结果。
- [ ] hint map 与 `/messages/before` 均已裁决。
- [ ] crash/restart 双节点测试和 build 通过。
- [ ] 节点总结完整且没有未登记敞口。

## 节点总结

待执行时填写。
