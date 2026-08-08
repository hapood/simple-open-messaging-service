# TODO 99：生成并验收 Federation v1 正式规范

状态：`BLOCKED`  
依赖：TODO 01–08 全部 `FROZEN`

## 目标

将已冻结且通过实现验证的结论整合为唯一、完整、可供第三方实现的 Federation v1 规范和
conformance suite。本任务不得临时补做协议设计。

## 硬性入口条件

- [ ] TODO 01–08 均为 `FROZEN`
- [ ] 所有遗留问题已关闭或明确排除在 v1 外

任一条件未满足时必须停止并报告依赖。

## 生成内容

- overview、术语、角色和安全模型；
- discovery、身份和 RFC 9421 signature profile；
- 完整 endpoint 与输入/输出 schema；
- error registry 和 caller-action matrix；
- lifecycle、delivery、cursor、identity/reset 状态机；
- limits、retention、timeout、retry；
- OpenAPI 3.1 / JSON Schema artifacts；
- 正反 conformance vectors；
- 部署安全要求以及 v1 冻结/v2 演进规则。

## 整体 Check

- [ ] endpoint 与 Nest 路由自动比对一致。
- [ ] producer/consumer 使用相同 schema。
- [ ] 每个参数只有一个名称、类型、单位和范围。
- [ ] 每个错误只有一个含义和 caller action。
- [ ] 每个副作用有幂等、重放、失败与恢复规则。
- [ ] 每个 cursor 有起点、推进、持久化和 gap 规则。
- [ ] 每个授权有授予、验证、撤销和 reset 规则。
- [ ] 重启、单向丢包、重复、乱序均有确定结果。
- [ ] 不存在 capabilities 或 v1 可选实现分支。
- [ ] 旧文档已更新分类、链接或归档，不再形成多套真相。

## 最终验证

- [ ] `npm run build`
- [ ] `npm test`
- [ ] `npm run test:e2e`
- [ ] schema/conformance tests
- [ ] 文档格式和链接检查
- [ ] `git diff --check`

## 最终逐端点 Check

每个 endpoint 单独检查 producer、request、identity binding、receiver transaction、success、
errors、idempotency、retry、recovery、limits、正反例和双节点 E2E。任一未通过，v1 不得完成。

## 节点总结

待执行时填写最终证据、关闭的敞口和明确排除在 v1 外的内容。
