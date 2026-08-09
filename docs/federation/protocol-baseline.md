# SOMS 联邦协议实现基线

> 当前仓库 `/api/v1` 实现基线，更新于 2026-08-09。URL 前缀是协议版本；body 不重复携带
> version。详细字段见 [S2S API](../api/federation-s2s-api.md)。

## 公开 surface

| Method     | Path                             | 鉴权与用途                                                             |
| ---------- | -------------------------------- | ---------------------------------------------------------------------- |
| `GET`      | `/.well-known/soms`              | 公开服务器身份、公钥和能力发现。                                       |
| `POST`     | `/s2s/ignite`                    | 首次建立并固定 peer identity；不要求预先 trusted。                     |
| `GET`      | `/s2s/identity`                  | nonce-bound 身份连续性证明。                                           |
| `GET`      | `/s2s/ping`                      | 原 pinned key 签名的恢复/存活证明；demoted peer 仅可使用该数据面端点。 |
| `POST/GET` | `/s2s/feed-rev`                  | 轻量 revision wake-up / 当前 state 与 message source revision。        |
| `GET`      | `/s2s/state-feed-rev`            | 当前 per-peer state feed revision。                                    |
| `GET`      | `/s2s/state-feed`                | PROFILE、好友方向事实、群方向事实和 origin 群快照。                    |
| `GET`      | `/s2s/message-feed`              | durable message discovery feed。                                       |
| `POST`     | `/s2s/call`                      | 临时 WebRTC 生命周期和 SDP/ICE relay。                                 |
| `GET`      | `/s2s/users/:account`            | 首次用户查询所需的完整公开 profile。                                   |
| `GET`      | `/s2s/get_file`                  | 有授权的 CAS Range 下载。                                              |
| `GET`      | `/s2s/forward-bundles/:bundleId` | 有授权的不可变转发 closure。                                           |

旧 `/init`、S2S invite/accept/revoke、thread-access、profile/meta revision probe、new-msg-map、
thread-level messages、miss-feed 均不兼容保留。

## 身份与信任

- wire identity 固定为 `{ account, domain }`，不传数据库 id。
- P2P 两端各有本地 thread；group 以 origin 的 `!account` 为稳定身份，每个成员服务器持有本地镜像。
- `trusted` 可正常交换数据；`demoted` 仅表示临时不可用，保留 pinned identity。
- 重启恢复顺序是 identity → signed ping → state feed → message feed。
- fingerprint、root key 或 identity epoch 冲突进入 `identity_lost`，只能管理员 reset，不能重新
  ignite 静默换身份。
- 迟到的旧网络失败不能覆盖较新的成功心跳。

## 状态一致性

- 好友由两条有向 `FriendRequest` 事实和一个无向 `FriendPair` 锁组成。
- `REQUESTED` 只是一封有期限的申请；只有本地方向和从对端 state feed 收到的方向都明确为
  `FRIEND`，才允许创建/恢复 P2P thread 和发送消息。
- 群成员由 origin 的 INVITE 和 member 的 JOIN 两个方向组成，origin `GROUP_META` 是 roster
  的最终权威。
- `PROFILE` 独立带 revision；群 meta JSON 不嵌头像。群成员服务器可直接应用 origin relay 的
  成员 PROFILE。
- 相同或更旧业务 revision 是完整 no-op：不写业务行、不刷新 `updatedAt`、不写投影、不生成
  feed、不触发下游。
- per-peer feed 按 key 压缩，只保留最高业务 revision。feed revision/cursor 使用 bigint，业务
  revision 使用 int。
- feed page 与 receiver cursor 同事务提交；任一非法 item 回滚整页。

## 消息与媒体

- wake-up 不携正文；receiver 永远先拉 state，再拉 message feed。
- message discovery change 与 message/audience 原子提交。
- SYSTEM 正文只含结构化事件和稳定 identity，自然语言由客户端按 locale 与时间渲染。
- 退群先写 `GROUP_LEFT`、分配 changeId、固定 creator audience 交付边界，再关闭成员关系。
- 同服务器仍有其他群成员时，共享镜像继续保存消息，退群者重新加入后可查看期间历史；最后一个
  成员离开时冻结 peer audience，重新加入复用镜像并恢复后续消息，但不补无人订阅期间的历史。
- 媒体正文提交与文件下载解耦；pending 下载可跨重启恢复。quota pause 保持可恢复状态，管理员
  加配额后自动唤醒。
- CAS 和 forward bundle 下载均验证消息可见性和 digest/bundle 绑定。

## 当前限制

- 尚未发布独立 JSON Schema/capability negotiation 文档。
- 完整删除、媒体并发/墓碑/GC 反例矩阵仍按
  [重构验收清单](./refactor-followup-checklist.md)推进。
