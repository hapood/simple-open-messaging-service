# 架构设计

本文档描述 SOMS 的系统架构、模块职责、认证机制、实时通信与核心业务流程。

## 目录

- [总体架构](#总体架构)
- [后端模块职责](#后端模块职责)
- [前端结构](#前端结构)
- [统一响应格式](#统一响应格式)
- [认证机制](#认证机制)
- [实时通信（SSE 下行）](#实时通信sse-下行)
- [核心业务流程](#核心业务流程)
- [已知问题与改进点](#已知问题与改进点)

---

## 总体架构

```
┌─────────────────────────┐        HTTP (POST)          ┌──────────────────────────────┐
│   Angular 18 前端 (web)  │ ───────────────────────────▶ │      NestJS 后端 (:3000)      │
│  - Standalone + Signal  │ ◀─────────────────────────── │  - Controllers (HTTP)         │
│  - 自研 Material 组件    │        HTTP 响应             │  - Services (业务)            │
│  - SSE 客户端            │                              │  - Gateway (SSE 下行)         │
└─────────────────────────┘                              └──────────────┬───────────────┘
        │                                                                │
        │   SSE (GET /api/v1/events, Authorization: Bearer JWT)          │ Prisma
        └──────────────────────────────────────────────────────────────▶│
                                                                         ▼
                                                              ┌──────────────────┐
                                                              │   PostgreSQL     │
                                                              └──────────────────┘
```

**职责划分原则**

- **HTTP 负责「写与查」**：注册、登录、发消息、查历史、建群、邀请等全部通过 HTTP `POST`。
- **SSE 负责「推」**：服务端通过 SSE（`GET /api/v1/events`）单向推送**完整消息体**，客户端收到即渲染、无需二次拉取。SSE 是下行专用通道，客户端→服务端的业务上行（发消息、未来的已读/typing）一律走 HTTP。

## 后端模块职责

应用根模块 [src/app.module.ts](../src/app.module.ts) 导入 `EventEmitterModule`、`RedisModule`、`AuthModule`、`UserModule`、`GatewayModule`、`MessageModule`、`GroupModule`、`UploadModule`、`AdminModule`；控制器在各自模块内声明（根模块直接注册 `MessageController` / `AuthController` / `UserController` / `GroupController`）。

| 模块 | 关键文件 | 职责 |
| --- | --- | --- |
| **AuthModule** | [src/auth/](../src/auth/) | Passport `local` + `jwt` 策略、JWT 双 Token 生成与校验、密码 argon2 哈希、登录失败 IP 封禁 |
| **UserModule** | [src/user/](../src/user/) | 用户注册（事务创建 User + UserExtra + userNotiBox）、用户查询、会话线程查询 |
| **MessageModule** | [src/message/](../src/message/) | 消息写入与分页查询、**好友请求状态机**（`makeFriendRequest` / `approveFriendRequest`） |
| **GroupModule** | [src/group/](../src/group/) | 群组 CRUD、成员管理、群组邀请 JWT token 的签发与解码 |
| **GatewayModule** | [src/gateway/](../src/gateway/) | SSE 下行推送（`EventsController` + `SseService`）：连接注册、心跳、新消息推送、强制下线、在线连接快照 |
| **UploadModule** | [src/upload/](../src/upload/) | 聊天图片上传（`/upload`，magic number 校验）、头像 `sharp` 多档 webp 重写 |
| **AdminModule** | [src/admin/](../src/admin/) | 独立 admin 账户体系（`Admin` / `AdminRefreshToken`）+ 用户/会话/封禁/重用告警管理端点 |
| **RedisModule** | [src/redis/](../src/redis/) | Redis 客户端封装（access jti 黑名单等） |
| **PrismaService** | [src/prisma.service.ts](../src/prisma.service.ts) | `PrismaClient` 封装，`onModuleInit` 自动连接 |

> 未接入模块：仅 `NotifyModule` 尚未导入 `AppModule`（`UserManageModule` 已由 `AdminModule` 激活供 `admin/users` 使用；`UploadModule` 已接入，图片 / 头像上传可用）。见 [已知问题](#已知问题与改进点)。

### 控制器一览

| 控制器 | 文件 | 端点前缀 |
| --- | --- | --- |
| AuthController | [src/controller/auth.controller.ts](../src/controller/auth.controller.ts) | `/auth/*` |
| UserController | [src/controller/user.controller.ts](../src/controller/user.controller.ts) | `/user/*` |
| MessageController | [src/controller/message.controller.ts](../src/controller/message.controller.ts) | `/send-message`、`/query-messages`、`/thread/by-user-id` |
| GroupController | [src/controller/group.controller.ts](../src/controller/group.controller.ts) | `/group/*` |
| UploadController | [src/upload/upload.controller.ts](../src/upload/upload.controller.ts) | `/upload`（图片）、`/user/update-avatar`（头像） |
| AdminController | [src/admin/admin.controller.ts](../src/admin/admin.controller.ts) | `/admin/*`（独立 admin JWT，`AdminAuthGuard`） |
| EventsController | [src/gateway/events.controller.ts](../src/gateway/events.controller.ts) | `GET /events`（SSE 下行流，复用 `JwtAuthGuard`） |

## 前端结构

前端为 Angular 18 standalone 应用，使用实验性 Zoneless 变更检测 + Signal 驱动。

**启动与全局配置** [web/src/app/app.config.ts](../web/src/app/app.config.ts)

- `provideExperimentalZonelessChangeDetection()` — 无 zone.js
- `AuthInterceptor` — HTTP 拦截器，自动注入 `Bearer <access_token>`，401 时自动续期
- `provideRouter(routes, withComponentInputBinding())`
- `provideHttpClient(withInterceptorsFromDi())`

**服务层** [web/src/app/services/](../web/src/app/services/)

| 服务 | 职责 |
| --- | --- |
| `AuthService` | 登录/登出、token 存储与自动续期；access_token 在内存（BehaviorSubject），refresh_token 在 storage |
| `WebsocketService` | SSE 下行通道（`@microsoft/fetch-event-source`，文件名保留）：建流 / 指数退避重连 / 401 续期重开 / 收 `NEW_MESSAGE`·`FORCE_LOGOUT` 转发；断线后发 `reconnect$` 触发游标补拉 |
| `UserService` | 注册、资料、好友请求、会话线程查询 |
| `MsgService` | 发送消息、查询历史 |
| `GroupService` | 创建/邀请/加入群组 |
| `RouteService` | 页面导航 + 弹窗栈（弹窗压入浏览器历史，后退即可关闭） |

**组件层** 共 25 个 standalone 组件：6 个页面组件（home / login / register / forbidden / 404 / navigator）+ 19 个业务/UI 组件。亮点是 `MsgGroupFactory`——一套消息分组 + 按需加载 + 高度预计算 + 滚动位置维持的虚拟滚动引擎。UI 完全自研 Material 风格组件（按钮/输入/复选框/对话框/菜单/进度条/图标/头像），未依赖 Angular Material。

## 统一响应格式

所有 HTTP 接口返回 `ApiResult` 信封（P1a 起 `status` 字段已更名为 `code`，定义见 [src/common/api-result.ts](../src/common/api-result.ts)）：

```ts
interface ApiResult<T = any> {
  code: number;      // 0 = 成功；非 0 = 业务错误码（按域分段）
  message: string;
  data?: T;
  hasMore?: boolean; // 分页接口填充
}
```

业务结果一律 HTTP 200 + `code`；仅未认证(401) / 不存在(404) / 冲突(409) / 服务器异常(500) 保留 HTTP 状态码给大类（DTO 参数校验失败也纳入业务流，200 + `10000`）。**业务码按域分段**（`10xxx` 通用 / `20xxx` 好友·状态机 / `30xxx` 消息 / `40xxx` 群组），完整码表见 [api.md → 业务错误码](./api.md#业务错误码)。

> 序列化由全局 `SerializeInterceptor`（[src/common/serialize.interceptor.ts](../src/common/serialize.interceptor.ts)）统一处理：`Date → 毫秒时间戳`、`BigInt → string`。P1 已移除曾经的 `Date.prototype.toJSON` 全局 hack 与手动 `convertBigIntId()`。

## 认证机制

### 双 Token 模型

| Token | Payload | 有效期 | 签名密钥 | 前端存储 |
| --- | --- | --- | --- | --- |
| access_token | `{ sub, jti, tokenVersion, device }` | 15 分钟 | `JWT_ACCESS_SECRET` | 内存（BehaviorSubject，刷新即失） |
| refresh_token | 家族化（familyId + 轮换 + 重用检测） | 14 天 | `JWT_REFRESH_SECRET`（与 access 分离） | `sessionStorage`（不保持登录）/ `localStorage`（保持登录） |

> ✅ P0 已落库：refresh_token 以 sha256 哈希存入 `RefreshToken` 表（`userId / tokenHash / device / expiresAt / revokedAt`），重启不失效、可吊销、续期轮换；access 与 refresh 使用分离的 secret（`JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET`）。

### 登录流程（Local 策略）

1. `POST /auth/login`（body: `uniqName`, `password`）→ `LocalAuthGuard` → `LocalStrategy.validate()`。
2. **IP 封禁检查**：查内存 `_ipBlackDict[ip]`，未解封则直接拒绝。
3. `AuthService.validateUser()`：查用户后用 `argon2.verify` 校验密码。
4. **失败计数与封禁**（[src/auth/local.strategy.ts](../src/auth/local.strategy.ts)）：累计失败 `>3` 封禁 30 分钟、`>6` 封禁 3 小时、`>9` 封禁 24 小时；每 24 小时清理超过 2 天的记录。
5. 成功返回 access + refresh；凭据错返回 `code:10003`；IP 封禁返回 `code:10005` + `data.bannedUntil`。

### JWT 校验（Jwt 策略）

- `JwtStrategy` 从 `Authorization: Bearer <token>` 提取，解码后将 `{ userId: payload.sub }` 挂到 `req.user`。
- 控制器通过 `@Req() req` 取 `req.user.userId`。

### 续期与登出

- `POST /auth/renew-access` / `POST /auth/renew-refresh`：两者同义——用 refresh_token 做**家族化完整轮换**（旧 refresh 置 `rotated`，签发新 access + 新 refresh），命中重用则 `code:10006` 连根吊销。前端统一只调 `renew-access`。
- `POST /auth/logout`（public，refresh 在 body）：置 refresh `revokeReason='logout'`；可选传 `accessJti` 把当前 access 即时入 jti 黑名单。
- `POST /auth/logout-all` / `change-password` / admin 踢下线：`invalidateAllSessions` bump `tokenVersion`（所有 access 即时失效）+ 吊销全部 refresh，并经 `auth.sessions-invalidated` 事件断开该用户所有 SSE 连接。

### 前端协同

- `AuthInterceptor`：非公开请求注入 `Bearer` 头（公开路径由 URL 白名单判定，原 `Authorization:'public'` 标记已废）；无 token 时主动驱动 `renewAccessToken()`（有确定终点、不永挂）；遇 401 单飞 renew + 重试 1 次（上限，不递归）。
- 续期：`AuthService.renewAccessToken()` 单飞（`shareReplay` bufferSize:1 + refCount + finalize），并发共享同一在飞请求；成功换新 access + 轮换 refresh，失败（`10006` / `10003`）→ `redoLoginAuth` 强制重登。已删除旧的 7 天定时器 / `renewRefreshToken` 机制。

## 实时通信（SSE 下行）

**端点** [src/gateway/events.controller.ts](../src/gateway/events.controller.ts) + [src/gateway/sse.service.ts](../src/gateway/sse.service.ts)：`GET /api/v1/events`（`text/event-stream`，与 HTTP 同端口 3000）。SSE 是单向下行通道——只推不收，客户端所有业务上行（发消息、未来的已读/typing）走 HTTP。

### 连接鉴权

鉴权复用与普通受保护路由同一套 `JwtAuthGuard`（验签 + 过期 + jti 黑名单 + `tokenVersion` 撤销感知），token 走 `Authorization: Bearer <access_token>` 头，**不进 URL**：

1. `EventsController.stream()` 取 `req.user.userId`，调用 `SseService.register(userId, res)`。
2. `register`：写出流式响应头（`X-Accel-Buffering: no` 防 Nginx 攒批）→ 首帧 `: connected` 注释冲头 → 计入 `clients[userId]`（数组，一个用户可多连接）→ 启动心跳。
3. 鉴权失败：`JwtAuthGuard` 直接抛 401（**无 `AUTH` 帧**），前端 `onopen` 收到后 renew + 重开。

### 心跳与判死

服务端每 25s 写 `: ping` 注释帧（< Nginx `proxy_read_timeout` 60s）。SSE 单向无 pong，靠 `res.write` 返回 `false`（对端已断 / 背压）感知断开 → `res.end()` → `close` 回调清理连接与心跳。判死窗口 ≤ 25s，`res.on('close')` 兜底清理。

### 推送事件

`SseService.onNewMessage(userId, data)` 向目标用户的所有连接推**完整消息体**（`serializeBody({ threadId, ...message })`，BigInt→string / Date→ms，与 HTTP 响应同口径）：

```
event: NEW_MESSAGE
id: <msgId>
data: {"threadId":1,"id":"123","content":"...","createdAt":1719000000000,...}
```

前端收到即可直接渲染，**无需二次 `query-messages`**。由 `MessageController`（P2P 推双方 / 群推全体成员）在写入消息后调用。

`FORCE_LOGOUT`：`SseService` 监听 `auth.sessions-invalidated` 事件（全设备登出 / 改密 / admin 踢下线触发），向该用户所有连接推 `FORCE_LOGOUT` 后立即断开。

### 顺序、完整性与断线续传

- **存活期间**：单条 SSE 连接上消息严格有序、完整到达——由底层 TCP 保证（服务端 `write` 顺序即客户端收到顺序）。SSE 层无需自加 `seq`。
- **断线期间**：SSE 流不回放历史（服务端不消费 `Last-Event-ID`）。重连成功后前端发 `reconnect$`，各会话按 `newestMsgId` 游标走 HTTP 增量补拉（`refillNewer`）漏掉的消息。
- **多连接**：同一用户的多条连接各自有序，跨连接不保证。

### 前端处理（[websocket.service.ts](../web/src/app/services/websocket.service.ts)，内部 `@microsoft/fetch-event-source`）

- `onopen` 收到 401：抛 `AuthNeededError` → 外层循环单飞 `renewAccessToken()`，成功则立即重开（不计退避），失败则 `redoLoginAuth`。
- 收 `NEW_MESSAGE`：转发给会话组件，直接渲染（载荷已是完整消息体）。
- 收 `FORCE_LOGOUT`：`disconnect` + `redoLoginAuth`，不再重连。
- 网络/服务端错误：指数退避 + 全抖动（`random(0, min(1000·2^attempt, 30000))`），成功连上归零。

## 核心业务流程

### 会话抽象（关键设计）

所有会话统一抽象为 `MessageThread`（类型 `P2P` 或 `GROUP`）。每个用户对每个会话持有一条 `UserMessageThread`，其 `status` 驱动会话生命周期：

```
UserMessageThreadStatus:
  FROM_PENDING  → 我发出的请求，待对方处理
  TO_PENDING    → 我收到的请求，待我处理
  APPROVED      → 已建立会话
  BLOCKED       → 已屏蔽
  DELETED       → 已删除
```

- **P2P**：两个用户各持一条 `UserMessageThread`，`toObjType=P2P`、`toObjId=对方用户ID`；批准好友后共享同一条 `MessageThread`。
- **GROUP**：每个成员持一条 `UserMessageThread`，`toObjType=GROUP`、`toObjId=群组ID`。

### 好友请求状态机

`MessageService.makeFriendRequest(from, to)`（[src/message/message.service.ts](../src/message/message.service.ts)）在事务中根据对方 `UserMessageThread` 的当前状态分支处理：

```
对方当前状态          行为                                返回 status
─────────────────────────────────────────────────────────────────
不存在               新建双方记录（FROM_PENDING/TO_PENDING）   0
APPROVED             已是好友                                  1
DELETED             重置为待处理                              2
FROM_PENDING         对方已先请求 → 直接建立好友                 3
TO_PENDING/BLOCKED   不再打扰                                  5
```

`approveFriendRequest(from, to)`：校验状态为 `FROM_PENDING`，首次批准时创建 `MessageThread(P2P)`，将双方状态置为 `APPROVED` 并绑定 `threadId`。

### 消息发送

`POST /send-message`（body: `userThreadId`, `content`）→ `MessageService.writeMsgToThread()`：

1. 校验发送者 `UserMessageThread` 为 `APPROVED`。
2. P2P：额外校验对方也为 `APPROVED`；写入 `Message(PURE_TEXT)`；SSE 推送双方。
3. GROUP：写入 `Message`；SSE 推送群组全体成员。
4. 推送完整消息体（`{ threadId, ...message }`，已序列化），前端收到即可直接渲染、无需二次拉取。

### 群组创建与邀请

- **创建**（`POST /group/create`）：事务中创建 `MessageThread(GROUP)` → `Group`（owner、关联 thread）→ 创建者的 `UserMessageThread(APPROVED)` + `GroupMember`。
- **邀请**（`POST /group/invite`）：校验邀请人是成员、被邀请人是好友（双方 `APPROVED`）；在两人 P2P 会话写入一条 `ContentType.INVITE` 消息，内容为 JSON：`{ type: 'GROUP_INVITE', fromUserId, groupName, expiryDate, token }`。`token` 是独立密钥签发的 JWT（`{ sub: toUserId, exp, gid: groupId }`，3 天有效）。
- **加入**（`POST /group/join`）：解码邀请 token → 创建 `GroupMember` + `UserMessageThread(APPROVED)`。

## 已知问题与改进点

> 列出代码审查中发现的、对接入与部署有影响的事项。

1. ~~**密钥硬编码**~~ ✅ 已修复（P0）：JWT access/refresh secret、群组邀请 secret 已外置至 `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` / `GROUP_INVITE_SECRET`，缺失则启动 fail-fast（`src/common/env.ts`）。
2. ~~**refresh_token 仅存内存**~~ ✅ 已修复（P0）：refresh_token 落库到 `RefreshToken` 表（存 sha256 哈希），重启不失效、可吊销（`revokedAt`）、续期轮换；顺带修了三个 bug——`logout`（从 body 取 refresh，不再从 JWT payload 取恒为 undefined 的值，并改为 public 端点）、`renew-access`（不再误删 refresh，否则 7 天定时续期会失效）、`renew-refresh`（先判空再吊销，修空指针 500）。
3. **`NotifyModule` 未接入**：尚未导入 `AppModule`（Prisma 已建模 `Notify` / `userNotiBox`，代码未消费）。`UserManageModule` 已由 `AdminModule` 激活（`admin/users`），`UploadModule` 已接入（图片 / 头像上传可用）。
4. ~~**文件上传**~~ ✅ 已实现：`UploadModule`（[src/upload/](../src/upload/)）提供 `/upload`（聊天图片，magic number 校验 + 10MB 限）与 `/user/update-avatar`（`sharp` 多档 webp 重写）。生产换对象存储时仅改写入目标，接口契约不变。
5. ~~**前端 authGuard 未生效**~~ ✅ 已修复：`authGuard` / `guestGuard` 已挂载到路由（home/nav 走 authGuard，login/register 走 guestGuard）。
6. **`/user/query` 隐私**：可批量查询任意未删除用户信息，无关系级可见性隔离。
7. ~~**`Date.prototype.toJSON` 全局覆盖**~~ ✅ 已移除（P1）：改由全局 `SerializeInterceptor` 统一 `Date → ms` / `BigInt → string`，不再污染原型。
