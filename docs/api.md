# API 参考

SOMS 后端监听 `http://localhost:3000`。除特别说明外，**所有接口均为 `POST`**（含查询类接口），请求体为 JSON，响应为统一格式。

## 目录

- [通用约定](#通用约定)
- [认证 API](#认证-api)
- [用户 API](#用户-api)
- [消息 API](#消息-api)
- [群组 API](#群组-api)
- [文件 API](#文件-api)
- [WebSocket 事件](#websocket-事件)

---

## 通用约定

### 响应格式

```ts
interface StandardResponse<T = any> {
  code: number;   // 0 = 成功；非 0 = 业务错误码（按域分段，见下）
  message: string;
  data?: T;
}
```

> 字段为 `code`（P1a 起由 `status` 更名）。业务结果一律 HTTP 200 + `code`；仅未认证(401)/资源不存在(404)/冲突(409)/服务器异常(500) 保留 HTTP 状态码给大类。DTO 参数校验失败也纳入业务流（200 + `10000`）。

### 业务错误码

按域前缀分段（对标 WhatsApp Cloud API），完整定义见 [`src/common/business-code.ts`](../src/common/business-code.ts) `BusinessCode` 枚举：

| 段 | 含义 | 主要码值 |
| --- | --- | --- |
| `0` | 成功 | |
| `10xxx` | 通用 | `10000` 参数校验 / `10001` 不存在 / `10002` 已存在 / `10003` 未认证 / `10005` 限流·IP封禁 / `10999` 服务器异常 |
| `20xxx` | 好友·会话状态机 | `20001` 自加好友 / `20002` 未知状态 / `20003` 无待处理请求 |
| `30xxx` | 消息域 | `30001` 空内容 / `30002` 会话未批准 / `30003` 无此会话 |
| `40xxx` | 群组域 | `40001` 非群成员 / `40002` 非好友不可邀请 / `40003` 无效邀请 token |

> 示例：登录凭据错 → `code:10003`；IP 封禁 → `code:10005` + `data.bannedUntil`（解封时间戳）；注册重复 → `code:10002`。
> 说明：HTTP 响应信封字段为 `code`（见上表）。下文仍出现 `status` 的两处为**有意保留**：① WebSocket 帧的 `status` 字段（见「消息格式」，当前实现即此）；② 好友请求内部状态机的 `status 0/1/2/3/5`（不直接体现在响应 `code`）。

### 鉴权

- 需鉴权的接口要求请求头：`Authorization: Bearer <access_token>`。
- 注册、登录、续期接口无需鉴权（前端以 `Authorization: 'public'` 标记，拦截器放行）。
- `userId` 从 JWT 的 `sub` 取得，挂在 `req.user.userId`，控制器据此识别调用者。

### 数据类型约定

- `Date` 序列化为**毫秒时间戳**（数字）。
- `msgId`（消息 ID）为 `BigInt`，以**字符串**形式返回。

---

## 认证 API

> 控制器：[src/controller/auth.controller.ts](../src/controller/auth.controller.ts)

### POST `/auth/login` — 登录

- **鉴权**：Local（body 提供 `uniqName` + `password`）
- **请求体**：`{ uniqName: string, password: string }`
- **响应 `data`**（code=0）：`{ access_token: string, refresh_token: string }`
- **错误**：凭据错 `code:10003`；IP 封禁 `code:10005`，`data.bannedUntil` 为解封时间戳
- **限流**：同 IP 累计失败 >3 次封禁 30 分钟、>6 次封禁 3 小时、>9 次封禁 24 小时

### POST `/auth/renew-access` — 刷新 access_token

- **鉴权**：无
- **请求体**：`{ refreshToken: string }`
- **响应 `data`**：`{ access_token: string }`

### POST `/auth/renew-refresh` — 同时刷新 access + refresh

- **鉴权**：无
- **请求体**：`{ refreshToken: string }`
- **响应 `data`**：`{ access_token: string, refresh_token: string }`

### POST `/auth/logout` — 登出

- **鉴权**：无（`public`，前端在 header 标记 `Authorization: 'public'`，refresh_token 在 body）
- **请求体**：`{ refreshToken: string }`
- **响应**：`{ code: 0, message: 'success' }`，成功将对应 refresh_token 置为吊销（`revokedAt`）

> ✅ P0 已修复：refresh_token 落库 `RefreshToken` 表（存 sha256 哈希），重启不失效、登出真正吊销、续期轮换。`logout` 的 refreshToken 从 body 取（原实现从 JWT payload 取，恒为 undefined）。

---

## 用户 API

> 控制器：[src/controller/user.controller.ts](../src/controller/user.controller.ts)

### POST `/user/register` — 注册

- **鉴权**：无
- **请求体**：`{ uniqName: string, password: string }`
- **校验规则**：
  - `uniqName`：`^(?=[\w.-]{1,20}$)(?:[\d_.-]*[a-zA-Z]){3}[\w.-]*$`（1–20 字符，至少含 3 个字母）
  - `password`：6–20 字符，允许字母数字与 `.@!#$%^&*()`
- **响应 `data`**：`{ id: number, uniqName: string }`
- **行为**：事务中创建 `User` + `UserExtra`（name 默认 = uniqName）+ `userNotiBox`；`isForeigner=false`，`domain=null`。

### POST `/user/my-profile` — 当前用户资料

- **鉴权**：JWT
- **响应 `data`**：当前用户信息（不含密码哈希）

### POST `/user/query-thread/valid` — 有效会话列表

- **鉴权**：JWT
- **请求体**：`{ skip: number, take: number, lastId?: number, toObjType?: 'P2P'|'GROUP' }`
- **响应 `data`**：当前用户所有 `APPROVED` 会话；P2P 附带对方用户信息，GROUP 附带群组信息

### POST `/user/query-thread/to-pending` — 待处理好友请求

- **鉴权**：JWT
- **请求体**：`{ beforeDate: number, take: number, skip: number }`
- **响应 `data`**：当前用户收到的、`TO_PENDING` 状态的好友请求列表

### POST `/user/send-friend-request` — 发送好友请求

- **鉴权**：JWT
- **请求体**：`{ userId: number }`（目标用户）
- **响应 `code`**：`0` 请求已发送（涵盖首次发送 / 已是好友 / 重新发起 / 对方已先请求直接建立 / 不再打扰）；`20002` 好友状态机未知状态（不应发生）
- **内部状态机**：`makeFriendRequest` 返回 status `0/1/2/3/5` 驱动上述行为，不直接体现在响应 `code`
- **详见**：[architecture.md → 好友请求状态机](./architecture.md#好友请求状态机)

### POST `/user/approve-friend-request` — 接受好友请求

- **鉴权**：JWT
- **请求体**：`{ userId: number }`（请求发起方）
- **行为**：建立 P2P 会话（首次创建 `MessageThread`），双方状态置为 `APPROVED`

### POST `/user/query` — 批量查询用户

- **鉴权**：JWT
- **请求体**：`{ userIds: number[] }`（最多 100 个）
- **响应 `data`**：用户信息数组（`isDeleted=false`）

### POST `/user/by-uniq-name` — 按用户名查询

- **鉴权**：JWT
- **请求体**：`{ uniqName: string }`
- **响应 `data`**：单个用户信息

### POST `/user/thread-info` — 会话线程详情

- **鉴权**：JWT
- **请求体**：`{ userThreadId: number }`
- **响应 `data`**：线程详情，附带对应用户（P2P）或群组（GROUP）信息

---

## 消息 API

> 控制器：[src/controller/message.controller.ts](../src/controller/message.controller.ts)

### POST `/send-message` — 发送消息

- **鉴权**：JWT
- **请求体**：`{ userThreadId: number, content: string }`
- **行为**：校验发送者会话为 `APPROVED`（P2P 还需对方 `APPROVED`），写入 `Message(PURE_TEXT)`，并通过 WebSocket 向对方/群成员推送 `NEW_MESSAGE`
- **响应 `data`**：包含新消息的 `msgId`（字符串）

### POST `/query-messages` — 分页查询历史消息

- **鉴权**：JWT
- **请求体**：`{ userThreadId: number, skip: number, take: number, lastId?: number, orderBy: 'desc'|'asc' }`
- **行为**：基于 `MessageThread` 的**游标分页**（`lastId` + `skip` + `take`），支持正序/倒序
- **响应 `data`**：消息数组（`id` 为字符串、`createdAt` 为时间戳）

### POST `/thread/by-user-id` — 查询与某用户的 P2P 会话

- **鉴权**：JWT
- **请求体**：`{ userId: number }`
- **响应 `data`**：对应的 `UserMessageThread`（若存在）

---

## 群组 API

> 控制器：[src/controller/group.controller.ts](../src/controller/group.controller.ts)

### POST `/group/create` — 创建群组

- **鉴权**：JWT
- **请求体**：`{ groupName: string }`（最长 31 字符）
- **行为**：事务中创建 `MessageThread(GROUP)` → `Group`（owner、threadId）→ 创建者的 `UserMessageThread(APPROVED)` + `GroupMember`
- **响应 `data`**：`{ threadId: number, groupId: number }`

### POST `/group/invite` — 邀请好友入群

- **鉴权**：JWT
- **请求体**：`{ userId: number, groupId: number }`
- **前置校验**：邀请人是群成员、被邀请人是好友（双方 `APPROVED`）
- **行为**：在两人 P2P 会话写入一条 `INVITE` 消息，内容为 JSON：
  ```json
  {
    "type": "GROUP_INVITE",
    "fromUserId": 1,
    "groupName": "群名",
    "expiryDate": 1719000000000,
    "token": "<JWT, sub=被邀请人, gid=群组, 有效期 3 天>"
  }
  ```

### POST `/group/join` — 通过邀请 token 入群

- **鉴权**：JWT
- **请求体**：`{ token: string }`
- **行为**：解码邀请 token（校验 `sub` = 当前用户、未过期）→ 创建 `GroupMember` + `UserMessageThread(APPROVED)`

### POST `/group/info` — 群组信息

- **鉴权**：JWT
- **请求体**：`{ groupId: number }`
- **响应 `data`**：群组信息

---

## 文件 API

🚧 **未实现**：原 `file.controller.ts` / `src/file/*` 为未完成的死代码（未注册、handler 仅 `console.log`、`send-video` 路由重复、类名误写），已于 P1b 清理删除。文件上传计划在 **P3** 基于下述设计意图重新实现。

设计意图（P3 参考）：

| 路径 | 字段名 | 允许的 MIME |
| --- | --- | --- |
| `POST /file/send-image` | `file` | jpg / jpeg / png / webp |
| `POST /file/send-video` | `file` | mp4 / webm / ogg |
| `POST /file/send-audio` | `file` | mp3 / wav / acc |
| `POST /file/send-general-file` | `file` | 任意 |

请求为 `multipart/form-data`，使用 `FileInterceptor('file')` + `FileTypeValidator` 校验；按会话计算存储路径，落库到 `Message` 并返回可访问 URL。

---

## WebSocket 事件

> 网关：[src/gateway/event.gateway.ts](../src/gateway/event.gateway.ts) · 协议：原生 `ws`，与 HTTP 同端口 3000

### 连接与鉴权

```
const ws = new WebSocket('ws://<host>:3000', [accessToken])
```

- access_token 通过**子协议**（`Sec-WebSocket-Protocol`）传入。
- 鉴权失败：服务端发送 `AUTH` 事件后关闭连接。
- 客户端断线后应自动重连（前端默认 10 秒重连）。

### 消息格式

```ts
interface StandardMessage<T = any> {
  event: string;
  status: number;     // 0 = 成功
  message: string;
  data?: T;
}
```

### 事件列表（后端 → 前端）

| 事件 | 触发时机 | `data` | 客户端处理 |
| --- | --- | --- | --- |
| `AUTH` | 连接鉴权结果 | – | `status:0` 通过；`status:1` token 过期 → 续期；`status:2` 无效 |
| `NEW_MESSAGE` | 对方/群成员发送了新消息 | `{ threadId: number, msgId: string }` | 匹配当前会话则增量拉取并渲染 |

### 客户端 → 服务端

当前 `@SubscribeMessage` 未启用，**客户端不通过 WebSocket 发送业务消息**。所有写入（发消息、邀请等）走 HTTP。
