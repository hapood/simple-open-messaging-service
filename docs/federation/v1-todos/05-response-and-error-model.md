# TODO 05：冻结响应与错误模型

状态：`OPEN`  
依赖：TODO 01

## 目标

让调用方仅依据 HTTP status、稳定 business code 和 schema，即可唯一决定成功、重试、停止、
demote、reset 或状态收敛。

## 工作内容

- 冻结 JSON success/error envelope。
- 划分 HTTP status 与 business code 的职责。
- 明确 `202` 是内存接收、持久接受还是副作用完成。
- 裁决 lookup not-found 表达。
- 定义 binary/Range 的 `200/206/416` 和错误 JSON。
- 为 protocol/security/application/quota/liveness/identity 错误指定唯一动作：
  RETRY、NO_RETRY、CONVERGE、DEMOTE、IDENTITY_LOCK。
- 定义退避、`Retry-After` 和 cursor 推进规则。

## 交付物

响应 schema；business-code registry；endpoint × error × caller-action 矩阵；client/server 对称测试。

## 验收 Check

- [ ] 每条成功路径有 status、headers、body。
- [ ] 每个预期失败有唯一 status/code/action。
- [ ] 4xx/5xx 不会错误清 cursor 或继承授权。
- [ ] 网络、业务拒绝和身份错误不会互相误判。
- [ ] raw binary 错误可机器解析。
- [ ] retry 不制造重复副作用。
- [ ] contract、unit、双节点测试和 build 通过。
- [ ] 节点总结完整且没有未登记敞口。

## 节点总结

待执行时填写。
