# 数据模型

SOMS 使用 PostgreSQL，通过 Prisma 7（Rust-free 客户端 + `@prisma/adapter-pg` driver adapter；`relationJoins` 已 GA）定义数据模型。Schema 源文件：[prisma/schema.prisma](../prisma/schema.prisma)，CLI 配置见 [prisma.config.ts](../prisma.config.ts)。

## 目录

- [关系总览](#关系总览)
- [模型详解](#模型详解)
- [枚举](#枚举)
- [唯一约束](#唯一约束)
- [设计要点](#设计要点)

---

## 关系总览

```
                         ┌──────────────┐
                         │   UserExtra  │  1:1
                 ┌──────▶│  name, avatar│◀──────┐
                 │       └──────────────┘       │
                 │ 1:1                           │
          ┌──────┴──────┐                ┌───────┴───────┐
          │     User    │───────────────▶│  userNotiBox  │
          │  (账户/密码) │  1:1           │ hasUrFriendReq │
          └──────┬──────┘                └───────────────┘
                 │
       ┌─────────┼──────────────────────────────┐
       │ 1:N     │ 1:N                            │ 1:N
       ▼         ▼                                ▼
 ┌──────────┐  ┌────────────────────┐      ┌───────────┐
 │  Group   │  │  UserMessageThread │      │GroupMember│
 │ (owner)  │  │  (用户↔会话 多态)   │      │ groupId,  │
 └────┬─────┘  └─────────┬──────────┘      │  userId   │
   1:1│  1:N         N:1 │                     └─────┬─────┘
      │   ┌─────────────┘ 0..1                     │  N:1
      ▼   ▼                                        ▼
  ┌─────────────────┐                         (Group / User)
  │  MessageThread  │  ◀──── Message  1:N ──── (contentType,
  │  type: P2P|GROUP│        BigInt id          content,
  └─────────────────┘                         creator)

  独立表:  Notify (userId, type, content: Json)
```

## 模型详解

### User — 用户账户

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | Int (PK, 自增) | 用户 ID |
| `account` | VarChar(31), unique | 登录账户名 |
| `hashPwd` | VarChar(127) | argon2 密码哈希 |
| `isForeigner` | Boolean | 是否外部（跨域）用户 |
| `domain` | VarChar(63)? | 所属域 |
| `createdAt` / `updatedAt` | DateTime | 创建/更新时间 |
| `isDeleted` | Boolean | 软删除标记 |
| `userExtraId` | Int (unique, FK→UserExtra) | 1:1 档案 |
| `userNotiBoxId` | Int (unique, FK→userNotiBox) | 1:1 通知盒 |

联合唯一：`(account, domain)` —— 同一域内账户名唯一，支持跨域隔离。

### UserExtra — 用户档案

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | Int (PK) | |
| `name` | String | 昵称（注册时默认 = account） |
| `avatar` | String | 头像（URL 或标识，初始为空串） |
| `createdAt` / `updatedAt` | DateTime | |

### userNotiBox — 用户通知盒

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | Int (PK) | |
| `hasUrFriendReq` | Boolean | 是否有待处理好友请求（未消费） |

> Prisma 已建模，但当前代码未读写此表（NotifyModule 未接入）。

### Group — 群组

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | Int (PK) | |
| `name` | String | 群名（≤31 字符） |
| `ownerId` | Int (FK→User) | 群主 |
| `avatar` | String | 群头像 |
| `threadId` | Int (FK→MessageThread) | 群消息线程（1:1） |
| `createdAt` / `updatedAt` | DateTime | |

### GroupMember — 群成员

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | Int (PK) | |
| `groupId` | Int (FK→Group) | |
| `userId` | Int (FK→User) | |

联合唯一：`(groupId, userId)` —— 防止重复入群。

### UserMessageThread — 用户↔会话关联（核心）

这是多态关联表，连接用户与其参与的会话（P2P 或 GROUP），是会话生命周期的核心。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | Int (PK) | |
| `userId` | Int (FK→User) | 归属用户 |
| `status` | UserMessageThreadStatus | 会话状态（见下） |
| `toObjType` | MessageThreadType | 目标类型 `P2P` / `GROUP` |
| `toObjId` | Int | 目标 ID（用户 ID 或群组 ID） |
| `reqMessage` | String | 好友请求附言 |
| `threadId` | Int? (FK→MessageThread) | 关联的消息线程（批准好友后绑定） |
| `lastRead` | BigInt? | 已读位点（消息 ID） |
| `isDeleted` | Boolean | |
| `createdAt` / `updatedAt` | DateTime | |

**P2P 语义**：A、B 互为好友时各有 1 条记录，`toObjType=P2P`、`toObjId` 指向对方；批准后两条记录共享同一个 `threadId`。

### MessageThread — 消息线程

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | Int (PK) | |
| `type` | MessageThreadType | `P2P` / `GROUP` |
| `isDeleted` | Boolean | |
| `createdAt` / `updatedAt` | DateTime | |

被 `UserMessageThread.threadId`、`Message.threadId`、`Group.threadId` 引用。

### Message — 消息

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | **BigInt** (PK, 自增) | 消息 ID（需转字符串传输） |
| `contentType` | ContentType | 消息类型 |
| `content` | String | 文本内容或 JSON（INVITE 类型为 JSON） |
| `threadId` | Int (FK→MessageThread) | 所属线程 |
| `creator` | Int | 发送者 userId |
| `isDeleted` | Boolean | |
| `createdAt` / `updatedAt` | DateTime | |

### Notify — 通知（独立表，未消费）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | BigInt (PK) | |
| `userId` | Int | 接收者 |
| `type` | NotifyType | 当前仅 `FRIEND_REQUEST` |
| `content` | Json | 通知载荷 |

## 枚举

```prisma
enum MessageThreadType {
  P2P      // 点对点会话
  GROUP    // 群组会话
}

enum UserMessageThreadStatus {
  FROM_PENDING   // 我发出、待对方处理
  TO_PENDING     // 我收到、待我处理
  APPROVED       // 已建立
  BLOCKED        // 已屏蔽
  DELETED        // 已删除
}

enum ContentType {
  PURE_TEXT   // 纯文本
  INVITE      // 群组邀请（content 为 JSON）
  IMAGE
  VIDEO
  FILE
  AUDIO
}

enum NotifyType {
  FRIEND_REQUEST
}
```

## 唯一约束

| 表 | 约束 | 含义 |
| --- | --- | --- |
| `User` | `(account, domain)` | 同域账户名唯一 |
| `GroupMember` | `(groupId, userId)` | 同一用户在同一群组唯一 |
| `UserMessageThread` | `(userId, toObjType, toObjId)` | 一个用户对同一目标只有一条记录 |
| `UserMessageThread` | `(userId, threadId)` | 一个用户在同一会话中只有一条记录 |
| `User` / `UserExtra` / `userNotiBox` | 1:1（`userExtraId` / `userNotiBoxId` unique） | 一对一关系 |

## 设计要点

1. **多态会话关联**：`UserMessageThread` 用 `(toObjType, toObjId)` 同时表达「与某用户的 P2P 会话」和「与某群组的会话」，避免分别建表。
2. **状态驱动生命周期**：会话的建立/屏蔽/删除全部由 `UserMessageThread.status` 表达，好友请求即是一次状态迁移（详见 [architecture.md → 好友请求状态机](./architecture.md#好友请求状态机)）。
3. **延迟绑定线程**：好友请求阶段 `threadId` 为空，仅在 `approveFriendRequest` 时才创建 `MessageThread` 并回填，避免产生无意义空线程。
4. **BigInt 消息 ID**：`Message.id` / `Notify.id` / `UserMessageThread.lastRead` 用 BigInt，由全局 `SerializeInterceptor` 统一序列化为字符串（见 [architecture.md → 统一响应格式](./architecture.md#统一响应格式)）。
5. **群组 = 线程**：每个群组与一个 `MessageThread(GROUP)` 一对一，群消息直接写入该线程；成员资格同时体现在 `GroupMember` 与 `UserMessageThread` 两处。
