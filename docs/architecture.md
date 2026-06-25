# 架构设计

本文档描述 SOMS 的系统架构、模块职责、认证机制、实时通信与核心业务流程。

## 目录

- [总体架构](#总体架构)
- [后端模块职责](#后端模块职责)
- [前端结构](#前端结构)
- [统一响应格式](#统一响应格式)
- [认证机制](#认证机制)
- [实时通信（WebSocket）](#实时通信websocket)
- [核心业务流程](#核心业务流程)
- [已知问题与改进点](#已知问题与改进点)

---

## 总体架构

```
┌─────────────────────────┐        HTTP (POST)          ┌──────────────────────────────┐
│   Angular 18 前端 (web)  │ ───────────────────────────▶ │      NestJS 后端 (:3000)      │
│  - Standalone + Signal  │ ◀─────────────────────────── │  - Controllers (HTTP)         │
│  - 自研 Material 组件    │        HTTP 响应             │  - Services (业务)            │
│  - WebSocket 客户端      │                              │  - Gateway (WebSocket)        │
└─────────────────────────┘                              └──────────────┬───────────────┘
        │                                                                │
        │   WebSocket (ws://, 子协议携带 JWT)                            │ Prisma
        └──────────────────────────────────────────────────────────────▶│
                                                                         ▼
                                                              ┌──────────────────┐
                                                              │   PostgreSQL     │
                                                              └──────────────────┘
```

**职责划分原则**

- **HTTP 负责「写与查」**：注册、登录、发消息、查历史、建群、邀请等全部通过 HTTP `POST`。
- **WebSocket 负责「推」**：服务端只在有新消息时通过 WebSocket 单向推送通知，客户端不通过 WebSocket 发送业务消息（`@SubscribeMessage` 当前未启用）。

## 后端模块职责

应用根模块 [src/app.module.ts](../src/app.module.ts) 导入了 `AuthModule`、`UserModule`、`GatewayModule`、`MessageModule`、`GroupModule`，并注册了对应的 4 个控制器。

| 模块 | 关键文件 | 职责 |
| --- | --- | --- |
| **AuthModule** | [src/auth/](../src/auth/) | Passport `local` + `jwt` 策略、JWT 双 Token 生成与校验、密码 argon2 哈希、登录失败 IP 封禁 |
| **UserModule** | [src/user/](../src/user/) | 用户注册（事务创建 User + UserExtra + userNotiBox）、用户查询、会话线程查询 |
| **MessageModule** | [src/message/](../src/message/) | 消息写入与分页查询、**好友请求状态机**（`makeFriendRequest` / `approveFriendRequest`） |
| **GroupModule** | [src/group/](../src/group/) | 群组 CRUD、成员管理、群组邀请 JWT token 的签发与解码 |
| **GatewayModule** | [src/gateway/](../src/gateway/) | WebSocket 连接管理、连接鉴权、新消息推送 |
| **PrismaService** | [src/prisma.service.ts](../src/prisma.service.ts) | `PrismaClient` 封装，`onModuleInit` 自动连接 |

> 未接入模块：`NotifyModule`、`UserManageModule`、`FileModule` 已存在源码但未导入 `AppModule`，功能未生效（见 [已知问题](#已知问题与改进点)）。

### 控制器一览

| 控制器 | 文件 | 端点前缀 |
| --- | --- | --- |
| AuthController | [src/controller/auth.controller.ts](../src/controller/auth.controller.ts) | `/auth/*` |
| UserController | [src/controller/user.controller.ts](../src/controller/user.controller.ts) | `/user/*` |
| MessageController | [src/controller/message.controller.ts](../src/controller/message.controller.ts) | `/send-message`、`/query-messages`、`/thread/by-user-id` |
| GroupController | [src/controller/group.controller.ts](../src/controller/group.controller.ts) | `/group/*` |

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
| `WebsocketService` | 建立/重连 WebSocket（token 走子协议），接收事件并转发 |
| `UserService` | 注册、资料、好友请求、会话线程查询 |
| `MsgService` | 发送消息、查询历史 |
| `GroupService` | 创建/邀请/加入群组 |
| `RouteService` | 页面导航 + 弹窗栈（弹窗压入浏览器历史，后退即可关闭） |

**组件层** 共 25 个 standalone 组件：6 个页面组件（home / login / register / forbidden / 404 / navigator）+ 19 个业务/UI 组件。亮点是 `MsgGroupFactory`——一套消息分组 + 按需加载 + 高度预计算 + 滚动位置维持的虚拟滚动引擎。UI 完全自研 Material 风格组件（按钮/输入/复选框/对话框/菜单/进度条/图标/头像），未依赖 Angular Material。

## 统一响应格式

所有 HTTP 接口返回 `StandardResponse`（定义于 [src/controller/utils.ts](../src/controller/utils.ts)）：

```ts
interface StandardResponse<T = any> {
  status: number;   // 0 = 成功，其余为各类错误
  message: string;
  data?: T;
}
```

特定场景的 status 约定：

- **登录**：`0` 成功；`1` 用户名/密码错误；`2` IP 被封禁（`data.bannedUntil` 为解封时间戳）。
- **好友请求**：`0` 首次发送；`1` 已是好友；`2` 之前删除过、重新发起；`3` 对方已先发来请求、直接建立好友；`5` 对方已处于待处理/屏蔽，不再打扰。

> 注意 [src/main.ts](../src/main.ts) 覆盖了 `Date.prototype.toJSON`，所有 `Date` 在 JSON 序列化时变为毫秒时间戳（数字）。`Message.id` 为 `BigInt`，需经 `convertBigIntId()` 转字符串后再序列化。

## 认证机制

### 双 Token 模型

| Token | Payload | 有效期 | 签名密钥 | 前端存储 |
| --- | --- | --- | --- | --- |
| access_token | `{ sub: userId }` | 15 分钟 | `jwtConstants.secret` | 内存（BehaviorSubject） |
| refresh_token | `{ sub: userId }` | 14 天 | 同上 | `sessionStorage`（不保持登录）/ `localStorage`（保持登录） |

> ✅ P0 已落库：refresh_token 以 sha256 哈希存入 `RefreshToken` 表（`userId / tokenHash / device / expiresAt / revokedAt`），重启不失效、可吊销、续期轮换；access 与 refresh 使用分离的 secret（`JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET`）。

### 登录流程（Local 策略）

1. `POST /auth/login`（body: `uniqName`, `password`）→ `LocalAuthGuard` → `LocalStrategy.validate()`。
2. **IP 封禁检查**：查内存 `_ipBlackDict[ip]`，未解封则直接拒绝。
3. `AuthService.validateUser()`：查用户后用 `argon2.verify` 校验密码。
4. **失败计数与封禁**（[src/auth/local.strategy.ts](../src/auth/local.strategy.ts)）：累计失败 `>3` 封禁 30 分钟、`>6` 封禁 3 小时、`>9` 封禁 24 小时；每 24 小时清理超过 2 天的记录。
5. 成功返回 access + refresh；失败返回 `status:1`；被封禁返回 `status:2` + `bannedUntil`。

### JWT 校验（Jwt 策略）

- `JwtStrategy` 从 `Authorization: Bearer <token>` 提取，解码后将 `{ userId: payload.sub }` 挂到 `req.user`。
- 控制器通过 `@Req() req` 取 `req.user.userId`。

### 续期与登出

- `POST /auth/renew-access`：用 refresh_token 换新 access_token。
- `POST /auth/renew-refresh`：同时换新 access + refresh。
- `POST /auth/logout`（需 JWT）：从内存字典移除 refresh_token。

### 前端协同

- `AuthInterceptor`：非 `public` 请求等待有效 access_token 后注入 `Bearer` 头；遇 401 自动调用 `renewAccessToken()` 续期并重试；请求排队期间若 token 已更新，则丢弃过期请求（`'obsolete http request'`）。
- 自动续期：`AuthService` 在构造时根据 refresh_token 创建时间设定 7 天定时续期。

## 实时通信（WebSocket）

**网关** [src/gateway/event.gateway.ts](../src/gateway/event.gateway.ts)，使用 `@WebSocketGateway()` + `WsAdapter`（与 HTTP 同端口 3000，原生 `ws`）。

### 连接鉴权

鉴权信息通过 **WebSocket 子协议**（`Sec-WebSocket-Protocol`）传递，而非 HTTP header：

1. 服务端从 `client.protocol` 取 JWT，`jwtService.verify()` 校验并检查 `exp`。
2. 通过：把连接加入 `wsClientDict[userId]`（一个用户可有多个连接）。
3. 失败：发送 `{ event: 'AUTH', status: 1|2, message }` 后关闭连接。

> 这是一种非标准的鉴权传递方式，客户端必须用 `new WebSocket(url, [accessToken])` 将 token 作为子协议传入（前端 [websocket.service.ts](../web/src/app/services/websocket.service.ts) 正是如此）。

### 推送事件

`EventGateway.onNewMessage(userId, { threadId, msgId })` 向目标用户的所有连接推送：

```json
{ "event": "NEW_MESSAGE", "status": 0, "message": "new message", "data": { "threadId": 1, "msgId": "123" } }
```

由 `MessageController`（P2P 推送双方 / 群组推送全体成员）与 `GroupController`（邀请消息）在写入消息后调用。

### 前端处理

- 收到 `AUTH` 且 `status===1`：触发 `renewAccessToken()`。
- 收到 `NEW_MESSAGE`：转发给 `MessageThreadComponent`，匹配当前会话 `threadId` 后触发 UI 增量渲染。
- 断线 10 秒自动重连。

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
2. P2P：额外校验对方也为 `APPROVED`；写入 `Message(PURE_TEXT)`；WebSocket 推送双方。
3. GROUP：写入 `Message`；WebSocket 推送群组全体成员。
4. 推送载荷 `{ threadId, msgId }`，前端据此增量拉取并渲染。

### 群组创建与邀请

- **创建**（`POST /group/create`）：事务中创建 `MessageThread(GROUP)` → `Group`（owner、关联 thread）→ 创建者的 `UserMessageThread(APPROVED)` + `GroupMember`。
- **邀请**（`POST /group/invite`）：校验邀请人是成员、被邀请人是好友（双方 `APPROVED`）；在两人 P2P 会话写入一条 `ContentType.INVITE` 消息，内容为 JSON：`{ type: 'GROUP_INVITE', fromUserId, groupName, expiryDate, token }`。`token` 是独立密钥签发的 JWT（`{ sub: toUserId, exp, gid: groupId }`，3 天有效）。
- **加入**（`POST /group/join`）：解码邀请 token → 创建 `GroupMember` + `UserMessageThread(APPROVED)`。

## 已知问题与改进点

> 列出代码审查中发现的、对接入与部署有影响的事项。

1. ~~**密钥硬编码**~~ ✅ 已修复（P0）：JWT access/refresh secret、群组邀请 secret 已外置至 `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` / `GROUP_INVITE_SECRET`，缺失则启动 fail-fast（`src/common/env.ts`）。
2. ~~**refresh_token 仅存内存**~~ ✅ 已修复（P0）：refresh_token 落库到 `RefreshToken` 表（存 sha256 哈希），重启不失效、可吊销（`revokedAt`）、续期轮换；顺带修了三个 bug——`logout`（从 body 取 refresh，不再从 JWT payload 取恒为 undefined 的值，并改为 public 端点）、`renew-access`（不再误删 refresh，否则 7 天定时续期会失效）、`renew-refresh`（先判空再吊销，修空指针 500）。
3. **两个模块未接入**：`NotifyModule`、`UserManageModule` 未导入 `AppModule`（原 `FileModule` 为空壳死代码，P1b 已删除，P3 重新实现）。
4. ~~**文件上传未完成**~~ ✅ 死代码已清理（P1b）：原 `file.controller.ts` / `src/file/*` 未注册且实现残缺（`console.log`、`send-video` 路由重复、空壳 module/service），已整域删除；文件上传留 P3 基于 [api.md](./api.md) 设计意图重新实现。
5. **前端 authGuard 未生效**：未挂载到路由，且检查的 `localStorage('token')` 与实际 `refresh_token` key 不一致。
6. **`/user/query` 隐私**：可批量查询任意未删除用户信息，无关系级可见性隔离。
7. **`Date.prototype.toJSON` 全局覆盖**：影响整个进程的 JSON 序列化行为，跨项目复用需注意。
