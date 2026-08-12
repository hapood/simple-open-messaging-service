# Federation v1 机器可读发布包

状态：`REVIEW`

本目录作为非规范性验证资源与 v1 规范正文一起发布，使用 JSON Schema Draft 2020-12。正文定义
事务、权限、签名、cursor 和状态机语义；Schema 定义可机械检查的 JSON shape。二者冲突时以正文
为准并修复发布包。

## 文件

- `common.schema.json`：identity、时间、cursor、digest、address 等 Federation 共享类型。
- `discovery.schema.json`：`/.well-known/soms`，包括多版本 `protocolVersions`。
- `identity.schema.json`：Recognize、Healthy 与 feed revision hint 的 closed JSON shape。
- `state-feed.schema.json`：完整 page 与五种 event body。
- `message-feed.schema.json`：完整 page、outer message、thread 和 asset descriptor。
- `message-content.schema.json`：二次解析后的 11 种 message content。
- `call.schema.json`：全部 call lifecycle、signal，以及每个 op 的 closed 条件字段集合。
- `profile.schema.json`、`forward-bundle.schema.json`、`error.schema.json`：其他 JSON operation。
- `http-parameters.schema.json`：规范化后的 query/path 参数对象。
- `http-manifest.json`：完整 10-operation surface、鉴权、status、media type 和 Schema 映射。
- `vectors/valid.json`、`vectors/invalid.json`：正反 JSON 向量。
- `vectors/http-message-signature.json`：通用固定 Ed25519 HTTP Message Signature 向量。
- `vectors/call-http-message-signature.json`：完整签名 `/s2s/v1/call` 向量。

## 校验

仓库根目录执行：

```bash
npm run federation:conformance
```

它会编译全部 Schema、校验正反向量、验证 message `content` 的二次解析、检查严格递增版本数组、
核对 HTTP manifest 的完整 v1 surface 与实现版本常量，严格比较错误码正文注册表、error Schema 与代码
wire enum，并验证固定签名向量。仓库单测另外把 manifest、
Schema enum、规范正文和 Nest route metadata 相互比对，防止发布制品与实现漂移。

第三方实现可以验证自己的 JSON：

```bash
npm run federation:conformance -- \
  --schema urn:soms:federation:v1:call \
  --file ./call-frame.json
```

此 CLI 是离线 conformance 工具，不参与节点运行时协商，也不需要向生产节点提供测试私钥。
