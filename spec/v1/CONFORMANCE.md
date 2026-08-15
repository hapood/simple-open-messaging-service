# SOCFP v1 Conformance

实现只有完整支持本发布包的全部必选行为，才可以声明 `SOCFP v1 conformant` 并在 discovery 的
`protocolVersions` 中发布 `1`。v1 不定义部分合规或按章节协商。

## 必选规范模块

| 模块 | 依赖 | v1 合规要求 |
| --- | --- | --- |
| Core Protocol | 无 | 必选 |
| Transport and Security | Core | 必选 |
| Peer Recognition | Core、Transport | 必选 |
| State Feed | Core、Recognition | 必选 |
| Message Feed and Query | Core、Recognition | 必选 |
| Message Tombstone Feed and Query | Core、Message | 必选 |
| Message | Core | 必选，包含全部 v1 content types |
| Resources | Core、Message | 必选 |
| Call Signaling | Core、Transport、Message | 必选 |
| Stable Error Registry | 全部 operation | 必选 |

JSON Schema、HTTP manifest 和测试向量是非规范性验证制品，但一个正式发布不能在已知与正文不一致时
发布。实现通过这些制品不自动证明满足正文中的时序、安全、授权和持久状态要求。

## 独立验证

在仓库根目录运行：

```bash
npm run federation:conformance
```

校验第三方 JSON：

```bash
npm run federation:conformance -- \
  --schema urn:socfp:v1:call \
  --file ./call.json
```

CLI 只读取 `spec/v1` 发布包，不导入 SOMS 的 `src/` 实现。实现级 route、业务码和状态机测试由各实现自行
维护，不能替代本发布包的独立验证。
