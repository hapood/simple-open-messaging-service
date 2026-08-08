# TODO 06：冻结系统事件与生命周期收敛

状态：`OPEN`  
依赖：TODO 04、05

## 目标

冻结通过 durable system message 传播的关系和群组生命周期，使双方在丢包、乱序、重复和重启
后仍收敛。

## 覆盖范围

unfriend、group leave、kick/ban/unban（若属于 v1）、group dissolve、user deletion/disable、
profile/roster tombstone，以及其他授权撤销事件。

## 工作内容

- 建立 system-event tagged union、稳定 event ID 和唯一权威 origin。
- 防止普通用户消息伪造系统事件。
- 冻结 duplicate/late/out-of-order/冲突优先级和 tombstone retention。
- 确保事件进入 `/missed`、消息分页和 revision。
- 明确授权撤销生效点与历史读取策略。

## 验收 Check

- [ ] 每种跨域生命周期变化都有权威 durable event。
- [ ] 每种事件有严格 schema、权限和幂等规则。
- [ ] 系统事件不能被普通 payload 伪造。
- [ ] 丢 push 后可由 durable feed 恢复。
- [ ] 乱序和重复后的最终状态唯一。
- [ ] 授权撤销与历史保留一致。
- [ ] 双节点乱序/重启测试和 build 通过。
- [ ] 节点总结完整且没有未登记敞口。

## 节点总结

待执行时填写。
