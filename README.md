# SOMS · Simple Open Chat Service

一个简洁的即时通讯（IM）服务，提供用户体系、好友/群组会话、实时消息推送与文件上传能力，设计目标是「易于被第三方应用接入」。

- **后端**：NestJS 11 + Prisma 7 + PostgreSQL + 原生 WebSocket (`ws`) + Passport (Local + JWT)
- **前端**：Angular 18（Standalone + Signal + 实验性 Zoneless），自研 Material 风格组件库

> 应用代号 **SOMS**（Simple Open Message Service）。仓库内同时包含后端服务（根目录）与 Angular 前端（`web/`）。

---

## 目录

- [功能概览](#功能概览)
- [技术栈](#技术栈)
- [项目结构](#项目结构)
- [快速开始](#快速开始)
- [配置说明](#配置说明)
- [架构与设计](#架构与设计)
- [API 与 WebSocket 速查](#api-与-websocket-速查)
- [开发命令](#开发命令)
- [项目状态](#项目状态)
- [更多文档](#更多文档)

---

## 功能概览

| 模块 | 能力 |
| --- | --- |
| 账户 | 注册、登录、登出、JWT 双 Token（access + refresh）自动续期、登录失败 IP 限流封禁 |
| 用户 | 个人资料、按用户名搜索、批量查询 |
| 好友 | 发送/接受好友请求（基于 `UserMessageThread` 状态机）、待处理请求列表 |
| 会话 | P2P 会话、群组会话，统一的 `MessageThread` 抽象 |
| 消息 | 纯文本消息发送、游标分页历史查询、WebSocket 实时推送 |
| 群组 | 创建群组、通过 JWT 邀请链接邀请好友加入 |
| 文件 | 图片/视频/音频/通用文件上传（🚧 见 [项目状态](#项目状态)） |
| 通知 | 通知表与通知盒子已建模（🚧 模块尚未接入） |

## 技术栈

**后端**

| 类别 | 选型 |
| --- | --- |
| 框架 | NestJS 11 |
| 数据库 | PostgreSQL（Prisma 7 ORM，Rust-free 客户端 + `@prisma/adapter-pg` driver adapter） |
| 实时通信 | `@nestjs/platform-ws` + `@nestjs/websockets`（原生 WebSocket） |
| 认证 | Passport `local` + `jwt`，`@nestjs/jwt`，`argon2` 密码哈希 |
| 工具 | `dayjs` 时间、`jsonwebtoken` 群组邀请 token |

**前端**

| 类别 | 选型 |
| --- | --- |
| 框架 | Angular 18（Standalone Components，无 NgModule） |
| 变更检测 | `provideExperimentalZonelessChangeDetection()`（无 zone.js） |
| 状态 | Angular Signal + RxJS |
| UI | 自研 Material Design 风格组件（无 Angular Material 依赖） |
| 实时通信 | 浏览器原生 `WebSocket` API |

## 项目结构

```
simple-open-chat-service/
├── src/                      # 后端 NestJS 服务
│   ├── main.ts               # 应用入口，监听 3000 端口，启用 CORS + WsAdapter
│   ├── app.module.ts         # 根模块
│   ├── config.ts             # 全局配置（域名）
│   ├── prisma.service.ts     # PrismaClient 封装
│   ├── auth/                 # 认证：local/jwt 策略、guard、token 管理
│   ├── controller/           # HTTP 控制器：auth/user/message/group/file
│   ├── message/              # 消息与好友请求状态机
│   ├── user/                 # 用户查询与注册
│   ├── group/                # 群组与邀请 token
│   ├── gateway/              # WebSocket 网关（消息推送）
│   ├── notify/               # 通知（🚧 尚未接入）
│   ├── user-manage/          # 用户管理（🚧 尚未接入）
│   └── file/                 # 文件上传（🚧 尚未接入）
├── prisma/
│   ├── schema.prisma         # 数据模型定义
│   └── migrations/           # 数据库迁移
├── test/                     # e2e 测试
├── web/                      # Angular 前端
│   └── src/app/
│       ├── app.config.ts     # 全局 providers（zoneless / router / http / 拦截器）
│       ├── app.routes.ts     # 路由
│       ├── services/         # HTTP 服务、WebSocket 服务、路由/弹窗服务
│       ├── pages/            # 页面组件（home / login / register / ...）
│       └── components/       # 业务组件 + 自研 Material 组件
├── config.ts
└── package.json
```

## 快速开始

### 前置要求

- Node.js ≥ 18（开发环境为 Node 24）
- 一个可访问的 **PostgreSQL** 实例

### 1. 准备数据库连接

```bash
cp .env.example .env
# 编辑 .env，填入你的 PostgreSQL 连接串：
# DATABASE_URL="postgresql://用户名:密码@主机:5432/数据库名?schema=public"
```

### 2. 安装依赖

```bash
# 后端
npm install

# 前端
npm install --prefix web
```

### 3. 初始化数据库

```bash
# 生成 Prisma Client
npx prisma generate

# 应用数据库迁移（建表）
npx prisma migrate deploy
# 或在开发期使用：npx prisma migrate dev
```

### 4. 启动服务

```bash
# 后端（监听 http://localhost:3000）
npm run start:dev

# 前端（另开终端，默认 http://localhost:4200）
npm start --prefix web
```

前端默认通过 `//<当前主机名>:3000` 访问后端（见 [配置说明](#配置说明)）。

## 配置说明

| 位置 | 配置项 | 说明 |
| --- | --- | --- |
| `.env` → `DATABASE_URL` | PostgreSQL 连接串 | Prisma 读取，必填 |
| `.env` → `APP_DOMAIN` | 服务域名 | 建议参考，实际由 `config.ts` 的 `server.domain` 使用 |
| `.env` → `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | JWT access/refresh 签名密钥 | 必填，缺失则启动报错（P0 已外置，原硬编码已移除） |
| `.env` → `GROUP_INVITE_SECRET` | 群组邀请 token 密钥 | 必填，缺失则启动报错（P0 已外置） |
| `.env` → `CORS_ORIGIN` | 允许的前端 origin（逗号分隔） | 未设置时回退开发默认 `http://localhost:4200`；生产必须显式配置 |
| `web/src/app/services/constants.ts` | `apiPrefix` | 前端访问后端的地址前缀，默认 `//${location.hostname}:3000` |

## 架构与设计

详见 [docs/architecture.md](docs/architecture.md)。核心要点：

- **统一响应格式**：所有 HTTP 接口返回 `{ status, message, data? }`，`status: 0` 表示成功。
- **会话抽象**：P2P 与群组都抽象为 `MessageThread`；每个用户对每个会话持有一条 `UserMessageThread` 记录，其 `status` 字段驱动会话生命周期（待处理 / 已建立 / 屏蔽 / 删除）。
- **HTTP 负责「写与查」，WebSocket 负责「推」**：消息发送走 HTTP，服务端通过 WebSocket 单向推送新消息通知。WebSocket 鉴权使用子协议（`Sec-WebSocket-Protocol`）传递 access_token。
- **双 Token 认证**：access_token（15 分钟，内存）+ refresh_token（14 天，存储），前端自动续期。

## API 与 WebSocket 速查

完整文档见 [docs/api.md](docs/api.md)。所有写/读接口均为 `POST`。

**HTTP（部分）**

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| POST | `/auth/login` | Local | 登录，返回双 token |
| POST | `/auth/renew-access` | – | 刷新 access_token |
| POST | `/auth/renew-refresh` | – | 同时刷新 access + refresh |
| POST | `/auth/logout` | JWT | 登出 |
| POST | `/user/register` | – | 注册 |
| POST | `/user/my-profile` | JWT | 当前用户资料 |
| POST | `/user/send-friend-request` | JWT | 发送好友请求 |
| POST | `/user/approve-friend-request` | JWT | 接受好友请求 |
| POST | `/user/query-thread/valid` | JWT | 有效会话列表 |
| POST | `/user/query-thread/to-pending` | JWT | 待处理好友请求 |
| POST | `/send-message` | JWT | 发送消息 |
| POST | `/query-messages` | JWT | 分页查询历史消息 |
| POST | `/group/create` | JWT | 创建群组 |
| POST | `/group/invite` | JWT | 邀请好友入群 |
| POST | `/group/join` | JWT | 通过 token 入群 |

**WebSocket 事件（后端 → 前端）**

| 事件 | 说明 |
| --- | --- |
| `AUTH` | 连接鉴权结果（`status: 0` 成功，`1` token 过期，`2` 无效） |
| `NEW_MESSAGE` | 新消息通知，`data: { threadId, msgId }` |

## 开发命令

**后端**

```bash
npm run start           # 启动
npm run start:dev       # 热重载
npm run build           # 构建
npm run lint            # ESLint
npm run format          # Prettier 格式化
npm test                # 单元测试
npm run test:e2e        # e2e 测试
npx prisma studio       # 可视化查看数据
```

**前端**

```bash
npm start --prefix web          # 开发服务器 (ng serve)
npm run build --prefix web      # 生产构建
npm test --prefix web           # Karma 测试
```

## 项目状态

本项目核心链路（注册登录、好友、P2P/群组会话、消息收发与实时推送）已可用。以下部分仍在开发中，接入前请注意：

- 🚧 **文件上传**：原 `file` 域死代码已在 P1b 整域删除（`src/controller/file.controller.ts` 不复存在）；功能重新实现留待 P3（落库到 Message + 返回可访问 URL）。
- 🚧 **通知系统**（`src/notify`）：`NotifyModule` 已编写但未导入 `AppModule`；Prisma 已建模 `Notify` / `userNotiBox`，代码尚未消费。
- 🚧 **用户管理**（`src/user-manage`）：服务已有 `getUserList`，但模块未接入、无控制器端点。
- ✅ **密钥硬编码**（P0 已修复）：JWT access/refresh 与群组邀请 secret 已外置至环境变量（`JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` / `GROUP_INVITE_SECRET`），缺失则启动 fail-fast。
- ✅ **前端路由守卫**：`authGuard` / `guestGuard` 已挂载到路由（home/nav 走 authGuard，login/register 走 guestGuard）。

## 更多文档

- [docs/architecture.md](docs/architecture.md) — 系统架构、模块职责、认证流程、WebSocket、核心业务流程
- [docs/api.md](docs/api.md) — 完整 HTTP API 与 WebSocket 事件参考
- [docs/database.md](docs/database.md) — 数据模型与关系图
- [docs/protocol-plan.md](docs/protocol-plan.md) — 后端接口与前后端交互协议栈规划（分层目标契约、错误码、WS 事件目录、P0–P3 路线图）
- [docs/chat-message-list-design.md](docs/chat-message-list-design.md) — 移动端 1v1 聊天消息列表设计规范（WhatsApp 风：气泡/头像/名字/尾尖/分组/明暗主题/尺寸）
