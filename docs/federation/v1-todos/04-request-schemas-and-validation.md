# TODO 04：冻结请求 Schema 与参数校验

状态：`OPEN`  
依赖：TODO 01

## 目标

为每个 v1 endpoint 的 path、query、headers、body 建立机器可验证的严格契约，消除隐式参数
组合和宽松 TypeScript cast。

## 工作内容

- 使用 OpenAPI 3.1 / JSON Schema 2020-12 表达 wire schema。
- union 使用显式 discriminant；消息 query 建议使用 `mode`，不靠字段存在性猜测。
- 冻结未知字段处理，v1 建议 `additionalProperties: false`。
- 冻结 domain、account、ID、digest、timestamp、decimal bigint grammar。
- 定义 URL 编码、重复 query key、空值/缺失值、数字范围和字符串长度口径。
- 定义同 operation ID 同 payload/异 payload 的结果。
- 覆盖 init/identity、feed、invite、call、profile/roster、messages、media/bundle。

## 交付物

逐端点 schema；runtime validator；schema/type 漂移检查；每个分支正例与半组合/额外字段反例。

## 验收 Check

- [ ] 所有输入参数均有机器 schema。
- [ ] 所有 union 有唯一 discriminant。
- [ ] 不再用 `req.body as Type` 代替运行时验证。
- [ ] signer/origin/recipient/resource 有语义绑定。
- [ ] bigint 不经过不安全 JSON number。
- [ ] 非法参数得到 TODO 05 定义的确定错误。
- [ ] contract、unit、双节点测试和 build 通过。
- [ ] 节点总结完整且没有未登记敞口。

## 节点总结

待执行时填写。
