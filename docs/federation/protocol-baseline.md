# SOMS 联邦协议实现基线

> **分类：Baseline（非规范性）**
>
> 本文记录 2026-08-04 仓库代码所实现的 S2S surface，供正式规范整理和差异审计使用。
> 它描述当前 SOMS 实现，不授权第三方把未说明的内部行为视为稳定协议承诺。
>
> 逐端点的参数、调用方向、恢复腿和闭环缺口见
> [api-closure-audit.md](./api-closure-audit.md)。端点出现在本基线中不等于其规范已经闭环。

## 1. 基线来源

- 路由：`src/federation/well-known.controller.ts`、`s2s-init.controller.ts`、`s2s.controller.ts`
- wire 类型：`src/federation/federation.service.ts`
- 签名与信任：`src/federation/s2s-signature.guard.ts`、`s2s-verify.service.ts`
- 双节点行为：`test/federation.e2e-spec.ts`、`test/federation-calls.e2e-spec.ts`

除 `/.well-known/soms` 外，以下路径均位于 `/api/v1` 全局前缀下。

## 2. 当前公开 surface

| Method | Path                                  | 当前鉴权                                         | 当前用途                                            | 主要验证                  |
| ------ | ------------------------------------- | ------------------------------------------------ | --------------------------------------------------- | ------------------------- |
| GET    | `/.well-known/soms`                   | 无                                               | 发布软件版本和 Ed25519 公钥列表                     | controller                |
| POST   | `/s2s/init`                           | 直接验证 RFC 9421 签名，不要求预先 trusted       | 建立或恢复 peer trust，当前实现自动接受             | controller、双节点 E2E    |
| POST   | `/s2s/invite`                         | 签名 + trusted peer                              | FRIEND 或 GROUP 邀请                                | 双节点 E2E                |
| POST   | `/s2s/invite-accept`                  | 签名 + trusted peer                              | FRIEND 接受或 GROUP 入组                            | 双节点 E2E                |
| POST   | `/s2s/invite-revoke`                  | 签名 + trusted peer                              | 撤回未完成的 FRIEND 邀请                            | controller、相关 E2E 流程 |
| POST   | `/s2s/call`                           | 签名 + trusted peer                              | 联邦 WebRTC 生命周期和 SDP/ICE relay                | calls 双节点 E2E          |
| GET    | `/s2s/users/:account`                 | 签名 + trusted peer                              | 本地用户或 `!` group identity 的完整 profile        | 双节点 E2E                |
| GET    | `/s2s/users/:account/revision`        | 签名 + trusted peer                              | profile revision probe                              | 双节点 E2E                |
| GET    | `/s2s/group/:account/roster-revision` | 签名 + trusted peer                              | group roster revision probe                         | group 双节点 E2E          |
| GET    | `/s2s/group/:account/roster`          | 签名 + trusted peer                              | origin 提供 canonical active roster                 | group 双节点 E2E          |
| GET    | `/s2s/new-msg-map`                    | 签名 + trusted peer                              | 拉取对端 outbound hint snapshot                     | message 双节点 E2E        |
| POST   | `/s2s/new-msg-map`                    | 签名 + trusted peer；`origin == signer`          | 推送 hint，202 后异步拉取消息                       | message 双节点 E2E        |
| GET    | `/s2s/messages`                       | 签名 + trusted peer；`toDomain == signer`        | P2P、group all-senders 或 group per-author 前向拉取 | message/group 双节点 E2E  |
| GET    | `/s2s/messages/before`                | 同上                                             | 三种消息形态的向后分页，SOMS 自身传输暂不消费       | 专门 E2E probe            |
| GET    | `/s2s/ping`                           | 签名 + trusted peer                              | liveness probe，更新 peer watermark                 | controller、联邦流程      |
| GET    | `/s2s/get_file`                       | 签名 + trusted peer；thread/roster/bundle 可见性 | digest 寻址媒体，支持单 Range、206 和 416           | media 双节点 E2E          |
| GET    | `/s2s/forward-bundles/:bundleId`      | 签名 + trusted peer；thread visibility           | 获取 forward manifest closure                       | forward bundle E2E        |

## 3. 当前通用行为

### 3.1 地址与身份

- wire address 是 `{ account, domain }`，不是 `account@domain` 字符串。
- P2P 没有跨服务器共享 thread id；group 使用 `!account` 作为联邦稳定身份。
- POST operation 的共同字段为 `id`、`origin`、`ts`；`(origin, id)` 用于部分持久操作去重。
- `S2SCallFrame` 不使用同一张持久去重表，由 call state machine 和 `callSid` 提供幂等后盾。

### 3.2 发现、签名和信任

- 服务位置当前按 SRV/fallback 逻辑解析，再读取 `/.well-known/soms` 中的 key。
- 普通 `/s2s/*` 请求由 `S2sSignatureGuard` 验证 RFC 9421 签名及 trusted peer 状态。
- `/s2s/init` 是例外：它通过签名中的 domain 获取对端 well-known key 并直接验签。
- 当前 `init` 验签成功后自动进入 trusted；管理员仍可 block peer。
- 当前签名只覆盖请求；S2S 响应体不签名。

### 3.3 消息与一致性

- 消息正文通过 hint + pull 传输，不通过 POST message envelope 传输。
- `originSeq` 是每个 `(thread, sender)` 的 0 起始单调序号，用于 cursor 和 dedup。
- P2P 在两端分别拥有本地 thread；group 采用 origin-hub，由 origin 维护 roster 和聚合历史。
- group per-author 拉取遇到已离开的 author 时，以 HTTP 410 和业务码
  `FEDERATION_GROUP_AUTHOR_LEFT` 通知 origin 更新 roster；该响应不应导致 peer demotion。
- unfriend 没有 S2S 删除操作，对端通过后续操作失败惰性发现关系断开。

### 3.4 媒体

- 普通聊天媒体按 SHA-256 digest 获取，并验证请求者对相关 thread/group 的访问权。
- forward bundle 资产可以用 `bundleId` 走 bundle visibility 授权。
- 当前仅实现单 byte range；不支持或无法解析的 Range 会退化为完整 200，合法但越界的
  Range 返回 416。

## 4. 当前 wire 类型入口

正式 JSON Schema 尚未建立。当前类型暂以 `federation.service.ts` 中的以下定义为审计入口：

- `S2SAddress`
- `S2SAvatar`、`S2SProfile`
- `S2SInvite`、`S2SInviteAccept`、`S2SInviteRevoke`
- `S2SCallFrame`

消息、roster、hint 和 forward bundle 的响应目前由 service 返回值及 E2E fixture 共同定义，
这是下一阶段需要消除的契约缺口。

## 5. 基线限制

本文没有把以下行为提升为稳定协议：

- 未知 JSON 字段的处理规则；
- 域名 canonicalization、IDN 和大小写规则；
- timestamp/replay window；
- 所有字段的长度、整数范围及条件必填规则；
- 统一成功 envelope 和错误响应的最终选择；
- capability negotiation 与 protocol version negotiation；
- key rotation 的发布重叠期和缓存失效要求。

这些内容必须经过明确裁决后进入正式规范，不能仅从当前实现细节推断。
