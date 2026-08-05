# SOMS 联邦文档已知冲突

> **分类：审计清单（非规范性）**
>
> 本文只记录差异，不在未讨论的情况下改变 wire behavior。解决一项后，应记录裁决、对应测试和
> 首次适用的协议版本，而不是直接删除历史痕迹。
>
> 会直接影响请求、响应、恢复和跨版本通信的敞口，统一在
> [api-closure-audit.md](./api-closure-audit.md) 逐端点跟踪。

## C-001：旧邀请端点仍出现在现行叙述中

- overview 已声明 `/friend-request`、`/friend-approve` 和 `/thread/invite` 被移除。
- 同一文档后续仍以 `/friend-request`、`/friend-approve` 给出 payload 示例和 endpoint 表。
- 当前代码只有统一的 `/invite`、`/invite-accept` 和 `/invite-revoke`。

**处理方向：** 正式规范只保留统一端点；旧名称移入 migration/history 文档。

## C-002：S2S API endpoint 表遗漏 call relay

- `S2sController` 实现了 `POST /s2s/call`。
- `test/federation-calls.e2e-spec.ts` 覆盖跨节点 call relay。
- 现有 S2S API 的 current endpoints 表没有该端点。

**处理方向：** 纳入现行 surface，并为每个 `op` 定义条件字段、授权、重放和错误行为。

## C-003：成功响应与错误通道描述不一致

- 现有 S2S API reference 声称 GET 返回 raw payload，错误通过 HTTP 4xx/5xx 表达。
- `S2sController` 注释说明除 binary `get_file` 外，成功数据经过全局
  `{ code, message, data }` envelope；部分 not-found 是 HTTP 200 + 非零业务码。
- `init` 和 binary 路径使用 `@Raw()`，与普通 JSON 路径行为不同。

**处理方向：** 用实际 HTTP integration probe 固化每类端点的状态码、headers 和 byte-exact body，
然后裁决 v0.1 是统一 envelope、纯 HTTP，还是明确的双层错误模型。

## C-004：`sinceSeq` 状态在同一 API 文档内冲突

- 文档开头称 GROUP invite 已携带 `sinceSeq`，新成员从邀请时刻开始。
- “Open / deferred design points” 又称该 wiring 尚未完成、默认全历史。
- E2E 已存在 “sinceSeq seeds pullUntil” 用例，当前代码类型也包含 `sinceSeq`。

**处理方向：** 以当前通过的 E2E 和实现作为 baseline，将旧 deferred 描述归档；正式规范仍需定义
`-1`、邀请时 cursor 以及并发消息的精确边界。

## C-005：allow-list 与 auto-accept 的术语容易互相矛盾

- overview 使用 “allow-list federation” 和 “explicitly trusted”。
- 当前 `/s2s/init` 对能通过 well-known key 验签的 peer 自动标记 trusted，不要求管理员预批准。
- 管理员 block 是独立的拒绝机制。

**处理方向：** 分开定义“必须完成可信握手”“管理员审批策略”和“开放注册/开放联邦”；避免把
auto-trust handshake 称为预配置 allow-list。

## C-006：多个文件同时声称或承担权威角色

- overview 自称 source of truth。
- overview 又把 Step 2/3 roadmap 称为 authoritative design。
- API 文档自称 living reference。

**处理方向：** 整理期统一从本目录进入；正式发布后只允许版本化 specification + schema 具有
规范效力，implementation 和 roadmap 不得覆盖它们。

## C-007：类型定义还不足以形成语言无关契约

- 当前 request shape 主要以 TypeScript interface 表达。
- 部分 query 参数只用 `Number()` 转换，文档所称 “integer” 与实际接受范围需要逐项验证。
- response shape、未知字段、条件字段和长度上限没有统一的机器可读定义。

**处理方向：** 先建立通用 scalar 与 error schema，再逐端点建立 JSON Schema 和反例测试。
