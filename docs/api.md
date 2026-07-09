# API 参考

SOMS 后端监听 `http://localhost:3000`，全局前缀 `/api/v1`。除特别说明外，**所有接口均为 `POST`**（含查询类接口），请求体为 JSON，响应为统一格式。文件上传类接口为 `multipart/form-data`。

## 目录

- [通用约定](#通用约定)
- [认证 API](#认证-api)
- [用户 API](#用户-api)
- [消息 API](#消息-api)
- [群组 API](#群组-api)
- [文件 API](#文件-api)
- [Admin API](#admin-api)
- [SSE 事件](#sse-事件)

---

## 通用约定

### 响应格式

```ts
interface StandardResponse<T = any> {
  code: number;        // 0 = 成功；非 0 = 业务错误码（按域分段，见下）
  message: string;
  data?: T;
  hasMore?: boolean;   // 分页接口填充：是否还有更多数据
}
```

> 字段为 `code`（P1a 起由 `status` 更名）。业务结果一律 HTTP 200 + `code`；仅未认证(401)/资源不存在(404)/冲突(409)/服务器异常(500) 保留 HTTP 状态码给大类。DTO 参数校验失败也纳入业务流（200 + `10000`）。

### 业务错误码

按域前缀分段（对标 WhatsApp Cloud API），完整定义见 [`src/common/business-code.ts`](../src/common/business-code.ts) `BusinessCode` 枚举：

| 段 | 含义 | 主要码值 |
| --- | --- | --- |
| `0` | 成功 | |
| `10xxx` | 通用 | `10000` 参数校验 / `10001` 不存在 / `10002` 已存在 / `10003` 未认证 / `10004` 无权限 / `10005` 限流·IP封禁 / `10006` refresh 重用→强制重登 / `10007` 会话已吊销 / `10999` 服务器异常 |
| `20xxx` | 好友·会话状态机 | `20001` 自加好友 / `20002` 未知状态 / `20003` 无待处理请求 |
| `30xxx` | 消息域 | `30001` 空内容 / `30002` 会话未批准 / `30003` 无此会话 |
| `40xxx` | 群组域 | `40001` 非群成员 / `40002` 非好友不可邀请 / `40003` 无效邀请 token |

> 示例：登录凭据错 → `code:10003`；IP 封禁 → `code:10005` + `data.bannedUntil`（解封时间戳）；注册重复 → `code:10002`；refresh token 重用 → `code:10006`（家族已连根吊销，前端强制重登）。
> 说明：HTTP 响应信封字段为 `code`（见上表）。下文 `status` 仍出现在好友请求内部状态机的 `status 0/1/2/3/5`（`makeFriendRequest` 返回值，不直接体现在响应 `code`）。

### 鉴权

- 需鉴权的接口要求请求头：`Authorization: Bearer <access_token>`。
- 注册、登录、续期接口无需鉴权（前端以 `Authorization: 'public'` 标记，拦截器放行）。
- `userId` 从 JWT 的 `sub` 取得，挂在 `req.user.userId`，控制器据此识别调用者。
- **Admin 接口**使用独立 JWT（独立 `adminSecret` + `scope: 'admin'` claim），由 `AdminAuthGuard` 守卫，与用户体系物理隔离、互不通用。

### 数据类型约定

- `Date` 序列化为**毫秒时间戳**（数字）。
- `msgId`（消息 ID）为 `BigInt`，以**字符串**形式返回。

---

## 认证 API

> 控制器：[src/controller/auth.controller.ts](../src/controller/auth.controller.ts)

### POST `/auth/login` — 登录

- **鉴权**：Local（body 提供 `account` + `password`）
- **请求体**：`{ account: string, password: string, device?: string }`（`device` 为前端生成的设备标识，用于多端会话区分）
- **响应 `data`**（code=0）：`{ access_token: string, refresh_token: string }`
- **错误**：凭据错 `code:10003`；IP 封禁 `code:10005`，`data.bannedUntil` 为解封时间戳
- **限流**：同 IP 累计失败 >3 次封禁 30 分钟、>6 次封禁 3 小时、>9 次封禁 24 小时

### POST `/auth/renew-access` — 用 refresh token 轮换（家族化 + 重用检测）

- **鉴权**：无（`public`）
- **请求体**：`{ refreshToken: string, device?: string }`
- **响应 `data`**：`{ access_token: string, refresh_token: string }`（**完整轮换**：旧 refresh 置为吊销 `rotated`，签发新 access + 新 refresh）
- **错误**：`code:10006` 重用检测命中（家族已连根吊销，前端须强制重登）；`code:10003` refresh 无效/过期
- **限流**：`@Throttle(30, 60)`

> 命名是历史遗留——尽管叫 `renew-access`，实际做的是 access + refresh 的完整轮换（与 `renew-refresh` 实现相同，保留双名仅为兼容）。

### POST `/auth/renew-refresh` — refresh 轮换（`renew-access` 的别名）

- **鉴权**：无（`public`）
- **请求体 / 响应 / 行为**：与 `renew-access` 完全一致（同一 `rotateRefreshToken` 实现），保留双端点仅为向后兼容。

### POST `/auth/logout` — 登出

- **鉴权**：无（`public`，前端在 header 标记 `Authorization: 'public'`，refresh_token 在 body）
- **请求体**：`{ refreshToken: string, accessJti?: string }`
- **行为**：将对应 refresh_token 置为吊销（`revokeReason='logout'`）；若传 `accessJti`，**立即**把当前 access token 加入 jti 黑名单（TTL = access 剩余寿命），实现即时踢下线。
- **响应**：`{ code: 0, message: 'success' }`
- **限流**：`@Throttle(30, 60)`

### POST `/auth/logout-all` — 全设备登出

- **鉴权**：JWT
- **行为**：`invalidateAllSessions(userId, 'all_devices')` —— bump `User.tokenVersion`（令该用户所有 access token 即时失效）+ 吊销其全部 refresh token + 清 access jti 缓存，并通过 `auth.sessions-invalidated` 事件强制断开其全部 SSE 连接。
- **响应**：`{ code: 0, message: 'success' }`

### POST `/auth/change-password` — 修改密码

- **鉴权**：JWT
- **请求体**：`{ oldPassword: string, newPassword: string }`（`newPassword` 沿用 6–20 位允许字符集规则）
- **行为**：校验旧密 → 改密 → 吊销该用户**其他所有**会话（当前设备重发一对新 token）
- **响应**：成功 `data: { access_token, refresh_token }`；旧密错 `code:10000`（`VALIDATION_FAILED`，message=`old password wrong`）
- **限流**：`@Throttle(10, 60)`

### POST `/auth/sessions` — 列当前用户活跃会话

- **鉴权**：JWT
- **响应 `data`**：当前用户的活跃会话列表（每条含 `device` / `userAgent` / `ip` / `createdAt` / `expiresAt` 等）

### POST `/auth/revoke-session` — 吊销单个会话

- **鉴权**：JWT
- **请求体**：`{ jti: string, accessJti?: string }`（`jti` 须属于当前用户）
- **行为**：吊销指定 refresh（按 `jti`）；若传 `accessJti`，同时把当前 access 入黑名单。

> 会话加固细节（access 可撤销、tokenVersion、家族化 refresh + 重用检测、进程内 KV、WS 联动）见 [architecture.md → 认证机制](./architecture.md#认证机制)。

---

## 用户 API

> 控制器：[src/controller/user.controller.ts](../src/controller/user.controller.ts)

### POST `/user/register` — 注册

- **鉴权**：无
- **请求体**：`{ account: string, password: string }`
- **校验规则**：
  - `account`：`^(?=[\w.-]{1,20}$)(?:[\d_.-]*[a-zA-Z]){3}[\w.-]*$`（1–20 字符，至少含 3 个字母）
  - `password`：6–20 字符，允许字母数字与 `.@!#$%^&*()`
- **响应 `data`**：`{ id: number, account: string }`
- **行为**：事务中创建 `User` + `UserExtra`（name 默认 = account）+ `userNotiBox`；`isForeigner=false`，`domain=null`。

### POST `/user/my-profile` — 当前用户资料

- **鉴权**：JWT
- **响应 `data`**：当前用户信息（不含密码哈希）

### POST `/user/update-avatar` — 更新头像

- **鉴权**：JWT
- **请求体**：`multipart/form-data`，字段 `file` = 图片二进制
- **允许格式**：jpg / png / gif / webp（magic number 二次校验）
- **行为**：经 `sharp` 重写为 32/64/128/256/512 多档 webp（按 EXIF 正向、cover 裁剪、剥离 EXIF/恶意 chunk、像素上限防解压炸弹）；落盘新档 → 写库 → 删旧档。
- **响应 `data`**：`{ avatar: string }`（最大档 512px 的完整 URL，其余档由前端派生）
- **错误**：无文件 / 非图片 → `code:10000`

### POST `/user/update-profile` — 更新昵称 / 简介

- **鉴权**：JWT
- **请求体**：`{ name?: string, bio?: string }`（`account`/handle 不可改；`bio` ≤ 120 字符）
- **响应 `data`**：更新后的用户信息（不含密码哈希）

### POST `/user/query-thread/valid` — 有效会话列表

- **鉴权**：JWT
- **请求体**：`{ skip: number, take: number, lastId?: number, toObjType?: 'P2P'|'GROUP' }`
- **响应 `data`**：当前用户所有 `APPROVED` 会话；P2P 附带对方用户信息，GROUP 附带群组信息

### POST `/user/query-thread/to-pending` — 收到的待处理好友请求

- **鉴权**：JWT
- **请求体**：`{ beforeDate: number, take: number, skip: number }`
- **响应 `data`**：当前用户收到的、`TO_PENDING` 状态的好友请求列表

### POST `/user/query-thread/from-pending` — 我发出的待处理好友请求

- **鉴权**：JWT
- **请求体**：`{ beforeDate: number, take: number, skip: number }`
- **响应 `data`**：当前用户发出的、`FROM_PENDING` 状态的好友请求列表

### POST `/user/send-friend-request` — 发送好友请求

- **鉴权**：JWT
- **请求体**：`{ userId: number }`（目标用户）
- **响应 `code`**：`0` 请求已发送（涵盖首次发送 / 已是好友 / 重新发起 / 对方已先请求直接建立 / 不再打扰）；`20001` 自加好友；`20002` 状态机未知状态
- **内部状态机**：`makeFriendRequest` 返回 status `0/1/2/3/5` 驱动上述行为，不直接体现在响应 `code`
- **详见**：[architecture.md → 好友请求状态机](./architecture.md#好友请求状态机)

### POST `/user/approve-friend-request` — 接受好友请求

- **鉴权**：JWT
- **请求体**：`{ userId: number }`（请求发起方）
- **行为**：建立 P2P 会话（首次创建 `MessageThread`），双方状态置为 `APPROVED`
- **错误**：`20003` 无该用户发来的待处理请求

### POST `/user/decline-friend-request` — 拒绝好友请求

- **鉴权**：JWT
- **请求体**：`{ userId: number }`（请求发起方）
- **行为**：拒绝对方发来的待处理请求
- **错误**：`20003` 无该用户发来的待处理请求

### POST `/user/cancel-friend-request` — 撤回我发出的好友请求

- **鉴权**：JWT
- **请求体**：`{ userId: number }`（目标用户）
- **行为**：撤回当前用户已发出的待处理请求
- **错误**：`20003` 当前用户对该目标无待处理请求

### POST `/user/query` — 批量查询用户

- **鉴权**：JWT
- **请求体**：`{ userIds: number[] }`（最多 100 个，`@ArrayMaxSize(100)`）
- **响应 `data`**：用户信息数组（`isDeleted=false`）

### POST `/user/by-uniq-name` — 按账户名查询

- **鉴权**：JWT
- **请求体**：`{ account: string }`
- **响应 `data`**：单个用户信息；不存在 `code:10001`

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
- **行为**：校验发送者会话为 `APPROVED`（P2P 还需对方 `APPROVED`），写入 `Message(PURE_TEXT)`，并通过 **SSE** 向对方/群成员推送 `NEW_MESSAGE`（载荷为完整消息体，前端收到即渲染）
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

> 控制器：[src/upload/upload.controller.ts](../src/upload/upload.controller.ts) · 服务：[src/upload/upload.service.ts](../src/upload/upload.service.ts)

### POST `/upload` — 上传图片（聊天相册）

- **鉴权**：JWT
- **请求体**：`multipart/form-data`，字段 `file` = 图片二进制；另带表单字段 `w` / `h`（前端 `createImageBitmap` 读出的宽高，后端原样保留不解析图片内容）
- **允许格式**：jpg / jpeg / png / gif / webp（multer `fileFilter` mimetype 粗筛 + `isImage` 读文件头 magic number 防伪造）
- **大小限制**：10MB
- **行为**：`multer` memoryStorage → magic number 校验 → 落盘 `process.cwd()/uploads/<ts>-<rand>.<ext>` → 返回可访问 URL
- **响应 `data`**：`{ url: string, w: number, h: number }`（`url` 形如 `/uploads/...`，由 `main.ts` 的 `useStaticAssets` 静态服务）
- **错误**：无文件 `code:10000` message=`no file`；非真实图片 `code:10000` message=`invalid image`

> 头像上传不在此端点，走 [`/user/update-avatar`](#post-userupdate-avatar--更新头像)（`sharp` 服务端重写为多档 webp）。
> 生产换对象存储（S3/OSS/MinIO）时，仅改 `save()` / `saveAvatars()` 的写入目标与 url 生成，接口契约不变。

---

## Admin API

> 控制器：[src/admin/admin.controller.ts](../src/admin/admin.controller.ts) · 服务：[src/admin/admin-auth.service.ts](../src/admin/admin-auth.service.ts)

Admin auth uses a **separate JWT system** (its own `adminSecret` + `scope: 'admin'` claim, guarded by
`AdminAuthGuard`) — admin sessions/tokens stay physically isolated from user sessions. Identity,
however, is shared: an admin is a **linked profile** on a `User` row (`Admin.userId → User.id`); the
account name and password live on the `User`, and `/admin/login` verifies `User.hashPwd` then issues
an admin session. One account namespace → a user and an admin can never share an account. All admin
endpoints except `admin/login` / `admin/renew-access` require `Authorization: Bearer <admin_access_token>`.

### 鉴权

#### POST `/admin/login` — 管理员登录

- **鉴权**：无
- **请求体**：`{ account: string, password: string }`
- **响应 `data`**（code=0）：`{ access_token: string, refresh_token: string }`；同时更新 `Admin.lastLoginAt` / `lastLoginIp`
- **错误**：凭据错 / 账户禁用 → `code:10003` message=`invalid credentials`

#### POST `/admin/renew-access` — 管理员 refresh 轮换

- **鉴权**：无
- **请求体**：`{ refreshToken: string }`
- **响应 `data`**：`{ access_token: string, refresh_token: string }`（家族化轮换 + 重用检测）
- **错误**：`code:10006` 重用（家族连根吊销）；`code:10003` 无效

#### POST `/admin/logout` — 管理员登出

- **鉴权**：AdminJWT
- **请求体**：`{ refreshToken: string }`
- **行为**：吊销该 refresh（`revokeReason='logout'`）

### 用户管理

#### POST `/admin/users` — 用户列表

- **请求体**：`{ skip?: number, take?: number, search?: string }`（`search` 对 `account` 不分大小写模糊匹配）
- **响应 `data`**：`{ list: User[], total: number }`（按 `createdAt desc`，已剔除 `hashPwd`）

#### POST `/admin/users/:id/disable` — 封禁用户

- **行为**：软删除（`isDeleted=true`）+ `invalidateAllSessions(id, 'admin_disabled')` 强制下线

#### POST `/admin/users/:id/enable` — 解禁用户

- **行为**：`isDeleted=false`

#### POST `/admin/users/:id/force-logout` — 强制下线

- **行为**：`invalidateAllSessions(id, 'admin_force_logout')`（吊销该用户所有会话）

#### POST `/admin/users/:id/sessions` — 查指定用户活跃会话

- **响应 `data`**：该用户的活跃会话列表

#### POST `/admin/users/:id/reset-password` — 重置密码

- **请求体**：`{ newPassword: string }`（6–20 位允许字符集）
- **行为**：改密 + `invalidateAllSessions(id, 'admin_reset_password')`（吊销所有会话，强制重登）

### 封禁管理

> 登录封禁（IP / 账户）存在 `LocalStrategy` 进程内字典，**无独立数据表**。

#### POST `/admin/bans` — 列当前登录封禁

- **响应 `data`**：当前生效的 IP / 账户封禁列表

#### POST `/admin/bans/unban` — 解封

- **请求体**：`{ ip?: string, account?: string }`（至少传一个）

### 审计

#### POST `/admin/reuse-alerts` — refresh token 重用告警

- **请求体**：`{ take?: number }`（默认 50）
- **响应 `data`**：`RefreshToken` 中 `revokeReason='reuse'` 的记录（`userId` / `familyId` / `jti` / `ip` / `userAgent` / `revokedAt`，按 `revokedAt desc`）

#### POST `/admin/sessions` — 全系统活跃用户会话总览

- **请求体**：`{ skip?: number, take?: number, userId?: number, ip?: string }`（`ip` 模糊匹配）
- **响应 `data`**：`{ list, total }`，每条含 `userId` / `jti` / `device` / `userAgent` / `ip` / `createdAt` / `expiresAt` / `user{id,account}`（仅未吊销且未过期）

> 该总览只查用户会话表 `RefreshToken`；管理员自身的活跃会话在独立的 `AdminRefreshToken` 表，不在此列。

#### POST `/admin/sessions/purge` — 一键清理所有活跃会话

- **行为**：找出所有仍有活跃会话的用户，逐个 `invalidateAllSessions(userId, 'admin_purge')`（全部强制重登、access 即时失效）
- **响应 `data`**：`{ purgedUsers: number }`

---

## SSE 事件

> 端点：[src/gateway/events.controller.ts](../src/gateway/events.controller.ts) + [src/gateway/sse.service.ts](../src/gateway/sse.service.ts) · `GET /api/v1/events`（`text/event-stream`，与 HTTP 同端口 3000）

### 连接与鉴权

```
// 浏览器原生 EventSource 不支持自定义 header，故前端用 @microsoft/fetch-event-source
fetchEventSource(`${apiPrefix}/events`, { headers: { Authorization: 'Bearer <access_token>' } })
```

- access_token 通过 `Authorization: Bearer` 头传入（**不进 URL**）。鉴权复用与 HTTP 同一套 `JwtAuthGuard`（验签 + 过期 + jti 黑名单 + `tokenVersion`）。
- 鉴权失败：`JwtAuthGuard` 直接返回 HTTP 401（**无 `AUTH` 帧**），前端 `onopen` 收到后续期 + 重开。
- 全设备登出 / 改密 / admin 踢下线触发 `auth.sessions-invalidated` 事件 → `SseService` 推 `FORCE_LOGOUT` 后断开该用户全部连接。
- 心跳：服务端每 25s 发 `: ping` 注释帧；断线由前端指数退避（全抖动，封顶 30s）重连，重连后按 `newestMsgId` 游标补拉漏掉的消息。

### 消息格式（SSE 文本帧）

```
event: <EVENT_NAME>
id: <msgId>          # 仅 NEW_MESSAGE 带
data: <json>         # JSON 字符串
```

> 鉴权不在帧内（走 HTTP 401），故无 WS 时代的 `AUTH` 帧。`: connected` / `: ping` 为注释行，不计为事件。

### 事件列表（后端 → 前端）

| 事件 | 触发时机 | `data` | 客户端处理 |
| --- | --- | --- | --- |
| `NEW_MESSAGE` | 对方/群成员发送了新消息 | 完整消息体 `{ threadId, id, content, contentType, createdAt, ... }`（已序列化） | 直接渲染（无需二次拉取） |
| `FORCE_LOGOUT` | 全设备登出 / 改密 / admin 踢下线 | `{ event:'FORCE_LOGOUT', status:0, message:<reason> }` | 断开 + 强制重登 |

> 顺序与完整性：单条连接存活期间由 TCP 保证严格有序、完整；断线期间的消息靠重连后游标补拉。

### 客户端 → 服务端

SSE 单向，**客户端不通过 SSE 发送业务消息**。所有写入（发消息、邀请、未来的 typing）走 HTTP `POST`。
