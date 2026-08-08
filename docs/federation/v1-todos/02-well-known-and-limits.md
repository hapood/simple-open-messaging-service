# TODO 02：冻结 well-known 与 Limits

状态：`OPEN`  
依赖：TODO 01

## 目标

定义 `/.well-known/soms` 的严格 v1 schema，以及对端正确通信必须知道的运行时限制。

## 工作内容

- 冻结 `protocolVersion`、`software`、identity、root/signing key 字段。
- 只发布影响互操作的限制，不发布本地 worker/队列等实现细节。
- 审计 JSON body、page/take、feed batch、profile/avatar/roster、media、Range、bundle 限制。
- 冻结 `mediaCasExpireSeconds` 的计时起点。
- 建议语义：`-1` 永久、`0` 立即过期、正整数为秒、`< -1` 非法。
- 定义运行期缩小限制对进行中请求和已发布资源的影响。

## 交付物

well-known JSON Schema；严格 publisher/parser；配置映射；合法、缺失、版本不符和边界测试。

## 验收 Check

- [ ] 不包含 capabilities。
- [ ] 每个字段有必填性、类型、单位、范围和未知字段规则。
- [ ] 只公开影响互操作的 limits。
- [ ] CAS expire sentinel 与计时起点唯一。
- [ ] 非法/缺失 limit 不会导致无限重试。
- [ ] publisher 与 parser 有一致性验证。
- [ ] build 与相关测试通过。
- [ ] 节点总结完整且没有未登记敞口。

## 节点总结

待执行时填写。
