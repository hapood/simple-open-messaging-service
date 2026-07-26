# SOMS C 端核心链路第一批实施计划

状态：Draft v0.1  
依赖：

- [SOMS C 端 UI 改造原则](./consumer-ui-redesign-principles.md)
- [SOMS C 端页面与状态验收矩阵](./consumer-ui-acceptance-matrix.md)
- [SOMS C 端设计 Token 草案与迁移表](./consumer-ui-token-draft.md)
- [SOMS 核心链路低保真结构方案](./consumer-ui-core-wireframes.md)

实施范围：首页、会话列表、聊天头部、消息视觉和输入区  
第一验收平台：Android Tauri  
实施原则：小批次、持续可构建、保持业务内核稳定

## 1. 实施目标

第一批改造完成后，用户应能在 Compact、Medium、Expanded 三种空间中清楚完成：

1. 从首页搜索、添加或选择会话；
2. 理解会话的未读、静音、草稿和失败状态；
3. 进入聊天并确认聊天对象；
4. 阅读文本、媒体和状态消息；
5. 使用文本、附件和语音输入；
6. 在断网、权限拒绝和发送失败时恢复操作。

本批次不追求覆盖全部低频页面。它的主要产物是核心链路和一套可以向认证、设置、资料等页面
扩展的设计实现基线。

## 2. 开工前置条件

### 2.1 工作区

- 当前功能开发由维护者整理并提交；
- 开始每个工作包前确认 `git status --short`，识别新的并行修改；
- UI 改造不覆盖或回退不属于本计划的改动；
- 每个工作包使用独立 Conventional Commit；
- 不修改已部署 Prisma migration，也不需要数据库迁移。

### 2.2 基线

实施前保存以下基线：

- `npm run build --prefix web` 成功输出；
- 相关 Angular 单元测试结果；
- VP-C1、VP-C2、VP-C3、VP-M1、VP-M2、VP-E1、VP-E2 核心页面截图；
- Android 真机冷启动、首页、聊天、软键盘、横屏和录音短录屏；
- 当前已知视觉问题列表，并标记“改造前已存在”。

如果测试环境暂时无法构造所有登录态数据，至少先准备固定开发账号和可重复的会话/消息 fixture，
避免依赖临时线上数据做视觉基线。

## 3. 总体依赖关系

```text
P0 基线与测试入口
        ↓
T0 Token 基础
        ↓
W1 三档布局骨架
        ↓
W2 首页头部与会话栏
        ↓
W3 会话行与列表状态
        ↓
W4 聊天头部
        ↓
T2/W5 消息视觉与输入区
        ↓
R1 核心链路回归与清理
```

W2 与 W3 可以在 W1 接口稳定后部分并行开发，但合并顺序仍建议 W2 → W3。W4 可以在 W1 之后
独立开发。W5 依赖 T0，并应在 W3/W4 的空间结构稳定后落地。

## 4. 建议提交边界

| 批次 | 建议提交主题 | 主要内容 |
| --- | --- | --- |
| P0 | `test(web): establish consumer UI baselines` | fixture、截图入口、缺失的核心测试 |
| T0 | `feat(web): establish consumer design tokens` | 新 token、兼容别名、Material 映射 |
| W1 | `feat(web): add medium responsive shell` | 三档布局和 aside 规则 |
| W2 | `feat(web): redesign conversation navigation` | 首页头部、新建/账户菜单、会话栏 |
| W3 | `feat(web): improve conversation list states` | 会话行语义、状态和交互 |
| W4 | `feat(web): redesign chat header actions` | 图标、资料入口、动作收纳、国际化 |
| W5a | `feat(web): apply SOMS chat visual tokens` | 时间线、气泡和消息卡 |
| W5b | `feat(web): refine composer interactions` | 输入区、录音提示、附件状态 |
| R1 | `fix(web): complete core UI accessibility` | 焦点、键盘、对比度和清理 |
| R2 | `test(web): add core UI regression coverage` | 自动截图、axe/静态检查、回归用例 |

如果某批次代码量过大，应按组件拆分，不要把 W5a 和 W5b 合成一个提交。

## 5. P0：基线与测试入口

### 5.1 目标

在结构和 token 改动前建立可重复的验证入口，使后续视觉变化可以区分“预期变化”和“功能退化”。

### 5.2 可能涉及文件

- `web/src/app/pages/chatbox-playground/`
- `web/src/app/pages/chatbox-playground/http-item-source.mock.ts`
- `web/src/app/dev-tools.ts`
- `web/src/app/components/thread-list/thread-list.component.spec.ts`
- `web/src/app/services/layout.service.spec.ts`
- `web/scripts/`
- 新增的测试 fixture 或截图脚本

### 5.3 工作项

- 为会话列表准备空、普通、未读、静音、长名称和失败 fixture；
- 为聊天准备文本、媒体、文件、邀请、发送中和失败消息；
- 确保 playground 只进入开发构建，不增加生产初始 bundle；
- 为代表视口提供稳定截图入口；
- 为截图隐藏不稳定时间、随机 ID 或提供固定时钟；
- 记录 Android 原生场景仍需人工验证，避免用浏览器截图冒充真机结果。

### 5.4 测试

- fixture 数据的单元测试；
- playground/dev route 生产构建排除检查；
- 截图入口冷加载和刷新；
- `npm run build --prefix web`。

### 5.5 完成条件

- 核心视觉状态可重复打开；
- 截图不依赖手工快速点击进入瞬时状态；
- 不修改生产业务数据和 API；
- 有清晰的截图文件名与场景编号。

## 6. T0：Token 基础

### 6.1 目标

先增加新语义和兼容层，不立即大范围改变现有页面视觉。

### 6.2 涉及文件

- `web/src/app/assets/_tokens.scss`
- `web/src/styles.scss`
- `web/src/app/assets/utils.scss`
- 可选：新增 `web/src/app/assets/_typography.scss`
- 可选：新增 token 静态检查脚本

### 6.3 工作项

- 增加 `on-brand`、pressed、selected、focus、disabled 等状态 token；
- 增加四级 surface、overlay 和状态 soft container；
- 增加字体、控件尺寸、完整间距、圆角、阴影和 motion token；
- 增加 `--chat-*`，旧 `--im-*` 暂时指向兼容值；
- 正式定义当前依赖 fallback 的公共语义，随后按计划迁移；
- 扩展 Material button、form field、list、menu、dialog、snackbar 和 progress 映射；
- 保持 T0 截图与改造前基本一致，品牌气泡和 surface 新值留到对应工作包启用。

### 6.4 风险

- 全局 token 值变化会同时影响未纳入第一批的页面；
- Material 私有/MDC token 可能随版本变化；
- `@property` 注册色与运行时 Motion 插值不能被别名破坏；
- 深色表面层级调整可能导致对话框、菜单和输入框同时改变。

### 6.5 回退点

- T0 先只新增和别名，不删除旧 token；
- Material 映射按组件类型独立提交或独立代码块；
- 如果某 Material 覆盖影响范围不明确，保留旧值并在对应页面迁移时处理。

### 6.6 测试

- 浅色/深色 token 存在性；
- Material 登录表单、设置列表、菜单和 snackbar 截图；
- 连接状态 Motion 动画；
- `npm run build --prefix web`。

## 7. W1：三档响应式外壳

### 7.1 目标

将当前 `mobile/desktop` 两档升级为 `compact/medium/expanded`，不改变导航业务语义。

### 7.2 涉及文件

- `web/src/app/services/layout.service.ts`
- `web/src/app/services/layout.service.spec.ts`
- `web/src/app/components/home-shell/home-shell.component.ts`
- `web/src/app/components/home-shell/home-shell.component.html`
- `web/src/app/components/home-shell/home-shell.component.scss`
- `web/src/app/components/desktop/chat-pane/chat-pane.component.ts`
- `web/src/app/services/nav-state.service.ts`（仅在现有接口不足时）
- 对应 `*.spec.ts`

### 7.3 状态模型变化

建议：

```ts
export type LayoutMode = 'compact' | 'medium' | 'expanded';
```

派生信号：

- `isCompact`；
- `isMedium`；
- `isExpanded`；
- 输入方式继续由 `InputDeviceService` 独立负责。

不要用平台名称或 pointer 类型决定布局。

### 7.4 结构规则

- Compact：首页单栏，聊天和详情全屏滑入；
- Medium：会话栏 + 聊天双栏，详情覆盖右侧内容；
- Expanded：图标导航 + 可调会话栏 + 聊天，详情覆盖抽屉；
- Medium/Expanded 未选中会话显示聊天空状态；
- 只有 Expanded 提供可调分栏；
- aside 在 Medium/Expanded 不永久压缩聊天区；
- 跨断点时保留当前会话、aside 栈和草稿。

### 7.5 分栏无障碍

现有拖动 `div` 改为具备 separator 语义的可聚焦控件：

- `role="separator"`；
- `aria-orientation="vertical"`；
- `aria-valuemin/max/now`；
- 左右方向键按固定步长调整；
- Home/End 或明确快捷操作到最小/最大；
- 双击或上下文动作恢复默认；
- tooltip 和 accessible name 国际化。

### 7.6 测试

- 三档边界与初始同步值；
- 旋转和窗口缩放后的 mode；
- Compact chat/aside 动画状态；
- Medium/Expanded 静态主从布局；
- 跨断点保留当前会话；
- 分栏上下限、持久化和键盘调整；
- `SHELL-007`、`SHELL-008`、`HOME-018`。

### 7.7 回退点

LayoutService 和 shell 作为一个原子工作包提交。若 Medium 出现内核问题，可临时将 Medium 映射到
Compact 表现，而不是恢复全部旧代码。

## 8. W2：首页头部与会话栏

### 8.1 目标

让搜索、新建和账户成为清晰且互不混淆的一级入口。

### 8.2 涉及文件

- `web/src/app/components/home-header/home-header.component.ts`
- `web/src/app/components/home-header/home-header.component.html`
- `web/src/app/components/home-header/home-header.component.scss`
- `web/src/app/components/desktop/chat-list-pane/chat-list-pane.component.ts`
- `web/src/app/components/chat-action-menu/chat-action-menu.component.ts`
- `web/src/app/components/icon/model.ts`
- `web/src/app/components/icon/icon.component.html`
- `web/src/app/services/route.service.ts`
- `web/src/app/i18n/zh-CN.json`
- `web/src/app/i18n/en.json`
- 新增/更新组件测试

### 8.3 组件责任

`HomeHeaderComponent`：

- Compact/Medium 顶栏；
- 展示区域标题、新建触发器、账户触发器；
- 分别维护 new-menu 与 account-menu 的打开状态；
- 打开一个菜单时关闭另一个。

`ChatListPaneComponent`：

- Expanded 标题区和新建入口；
- 搜索框与搜索激活状态；
- 文件夹标签；
- 列表承载。

业务动作继续通过 `RouteService`/现有 popup 能力执行，不把弹窗创建逻辑复制到头部。

### 8.4 新建菜单

建议统一使用一份 entry factory，按平台/配置输出：

- 添加联系人；
- 发起聊天；
- 创建群聊；
- 扫一扫。

账户菜单保持：

- 资料；
- 好友请求；
- 设置；
- 主题快捷操作（若保留）。

不要把同一个动作同时放在新建菜单和账户菜单。

### 8.5 搜索

第一批继续使用当前会话本地过滤，但增加：

- 搜索图标；
- 明确 label；
- 清除按钮；
- 搜索无结果状态；
- Escape 清除/退出规则；
- 关键词与文件夹同时存在时的可理解结果。

联系人全局搜索留作后续业务增强，不在本批次虚构 API。

### 8.6 测试

- 两个菜单互斥；
- 各平台 entry 可见性；
- 好友请求角标和文字计数；
- 新建群完成后刷新会话列表；
- 搜索清除、无结果和文件夹组合；
- 中英文长文案；
- `HOME-001`、`HOME-003`、`HOME-008` 至 `HOME-013`。

## 9. W3：会话行和列表状态

### 9.1 目标

完善会话行语义与状态，让用户快速理解当前会话并支持键盘操作。

### 9.2 涉及文件

- `web/src/app/components/thread-list/thread-list.component.ts`
- `web/src/app/components/thread-list/thread-list.component.html`
- `web/src/app/components/thread-list/thread-list.component.scss`
- `web/src/app/components/thread-list/thread-list.component.spec.ts`
- `web/src/app/components/empty-state/empty-state.component.*`
- `web/src/app/services/conversation-list.service.ts`（只读评估；确有缺失字段再改）
- `web/src/app/services/model.ts`（确有业务字段时）
- i18n 文件

### 9.3 语义结构

优先使用可承载复杂行内容的原生 button。如果嵌套互动要求导致 button 不适用，则使用 CDK/ARIA
listbox 或完整 roving tabindex 模式。

每行至少暴露：

- 可访问名称：会话名称；
- 辅助描述：最新消息、时间、未读和静音；
- `aria-current` 或 selected 语义；
- Enter/Space 激活；
- 可见 focus；
- 数据 key 继续满足 FLIP 动画。

### 9.4 状态数据

先确认 `ConversationItem` 已有字段，再决定是否呈现：

- unread；
- muted；
- pinned；
- draft；
- last send pending/failed；
- mention。

第一批不得为了视觉稿伪造后端不存在的状态。缺失状态在文档中记录为后续能力，不阻塞已有状态改造。

### 9.5 视觉状态

- default、hover、pressed、selected、focus；
- unread 文字权重与数字角标；
- muted 图标与降低强调后的未读；
- 错误状态使用图标和文字；
- 长名称、域名、时间和 `99+` 不互相挤压；
- 骨架与真实行保持同一几何结构。

### 9.6 测试

- 空、失败、加载、搜索无结果；
- 点击、Enter、Space；
- selected 与当前 threadId 同步；
- 99+、长名称、群组和联邦标识；
- prefers-reduced-motion 下 FLIP；
- `HOME-003` 至 `HOME-018`。

### 9.7 回退点

模板语义、视觉 token 和新状态展示分成可审查的小提交。若复杂 button 语义影响当前点击行为，
优先保留功能并单独修复 ARIA 模式，不退回全部视觉改造。

## 10. W4：聊天头部

### 10.1 目标

统一正式图标、资料入口、动作优先级和窄屏收纳。

### 10.2 涉及文件

- `web/src/app/components/message-header/message-header.component.ts`
- `web/src/app/components/message-header/message-header.component.html`
- `web/src/app/components/message-header/message-header.component.scss`
- `web/src/app/components/message-header/message-header.component.spec.ts`（新增或扩展）
- `web/src/app/components/message-search/message-search.component.ts`
- `web/src/app/components/icon/model.ts`
- `web/src/app/components/icon/icon.component.html`
- i18n 文件

### 10.3 结构变化

- 返回按钮只在 Compact 显示；
- 头像、标题和副标题合并为一个资料 button；
- 音频通话为可用单聊的优先直接动作；
- 视频通话在 Compact 空间不足时进入更多菜单；
- 搜索和聊天管理动作进入统一更多菜单；
- 消息搜索 takeover 保持头部高度不变；
- 删除所有硬编码英文 `aria-label`；
- 使用统一线性 SVG 音频/视频图标。

### 10.4 动作收纳策略

不要只用 CSS 隐藏后保留重复可访问节点。根据 mode/可用能力生成唯一动作入口：

| 模式 | 直接动作 | 菜单动作 |
| --- | --- | --- |
| Compact | 返回、资料、音频通话、更多 | 视频、搜索、会话管理 |
| Medium | 资料、音频、视频、更多 | 搜索和管理；空间不足可收纳视频 |
| Expanded | 资料、搜索、音频、视频、更多 | 低频管理 |

是否采用实时容器宽度判断应谨慎。第一批优先按 mode 给出稳定规则，避免 ResizeObserver 导致动作跳动。

### 10.5 测试

- 单聊/群聊、可通话/不可通话；
- Compact/Medium/Expanded 动作集合；
- 长标题、副标题和联邦标识；
- 点击与键盘进入资料；
- 搜索打开/关闭焦点恢复；
- 菜单 action 不重复；
- 中英文 accessible name；
- `CHAT-H-001` 至 `CHAT-H-010`。

## 11. W5a：消息视觉迁移

### 11.1 目标

启用 SOMS `--chat-*` 视觉，统一文本、媒体、文件、邀请和状态消息。

### 11.2 涉及文件

- `web/src/app/assets/_tokens.scss`
- `web/src/app/lib/chat-box/_cb.scss`
- `web/src/app/lib/chat-box/_cb-skeleton.scss`
- `web/src/app/components/message-thread/friend-message.component.scss`
- `web/src/app/components/message-cards/_row-base.scss`
- `web/src/app/components/message-cards/**`
- `web/src/app/components/user-avatar/**`（仅头像色板需要时）

### 11.3 工作项

- `--im-*` 使用迁移为 `--chat-*`；
- outgoing 使用品牌蓝弱容器，incoming 使用中性表面；
- 对齐正文、时间和发送状态对比度；
- 统一日期胶囊和 sticky date；
- 统一文本、链接、文件、媒体、邀请和通话卡片；
- 壁纸同时制作极弱纹理/纯色样板，确认后只保留一版；
- 失败重试具备清晰按压、focus 和 accessible name；
- 保持消息测量高度为整数像素的现有约束；
- 不改动虚拟列表滚动协议和消息分组算法。

### 11.4 风险

- 字号、行高、padding 或 border 变化会影响虚拟列表测量；
- 气泡角点和媒体网格变化可能产生小数高度；
- 图片 placeholder 与加载完成的尺寸差异会影响锚点；
- 深色气泡和链接颜色可能不满足对比度；
- 同时迁移全部 message card 容易遗漏特殊状态。

### 11.5 控制方式

- 先新增视觉 token，再逐类消息迁移；
- 每迁移一种消息卡执行其单元测试和 playground 截图；
- 不在同一提交修改虚拟滚动算法；
- 对测量敏感样式保留现有整数尺寸；
- 文本、媒体、文件、邀请可按独立提交拆分。

### 11.6 测试

- 消息卡现有单元测试；
- 长文本、连续字符串、相册布局、文件名和失败状态；
- 浅色/深色；
- 聊天底部锚点、历史加载和切换会话；
- reduced motion；
- `MSG-001` 至 `MSG-019`。

## 12. W5b：输入区交互优化

### 12.1 目标

在不重写发送、附件和录音业务逻辑的情况下，提高触控尺寸、手势可发现性和失败恢复。

### 12.2 涉及文件

- `web/src/app/lib/chat-input/chat-input.component.ts`
- `web/src/app/lib/chat-input/chat-input.component.html`
- `web/src/app/lib/chat-input/chat-input.component.scss`
- `web/src/app/components/chat-editor/**`
- `web/src/app/components/chat-action-menu/chat-action-menu.component.ts`
- `web/src/app/directives/kbd-offset.directive.ts`（原则上不改）
- `web/src/app/services/keyboard-inset.service.ts`（原则上不改）
- i18n 文件
- 新增/更新输入区测试

### 12.3 工作项

- emoji、附件和发送/录音目标达到推荐触控尺寸；
- 保持编辑器有效宽度，Compact 极窄时合理收纳次操作；
- 第一次使用录音时显示轻量“按住说话”提示；
- 麦克风权限请求前说明用途；
- 拒绝或永久拒绝时提供恢复路径；
- 录音、滑动取消和自动达到上限使用图标、文字与颜色共同反馈；
- 发送/上传中按真实并发规则禁用，而不是无条件冻结；
- emoji、附件、链接预览和录音状态互斥明确；
- 保持 IME composition、Enter/Shift+Enter 和草稿行为。

### 12.4 不改动

- 当前 Android `--kbd-lift-effective` 公式；
- reflow freeze/thaw；
- 虚拟键盘 native→JS inset 注入；
- 录音媒体格式和上传 API；
- 链接预览 API；
- Tiptap 编辑器业务扩展。

### 12.5 测试

- 文本发送、换行和 composition；
- emoji 打开/关闭与焦点；
- 附件菜单与文件 input；
- 录音开始、取消、发送、超时和组件销毁；
- 权限允许/拒绝；
- Android 真机软键盘、手势区和横屏；
- `INPUT-001` 至 `INPUT-017`。

## 13. R1：无障碍、国际化和静态清理

### 13.1 工作项

- 检查所有新图标按钮的本地化 accessible name；
- 清除核心链路硬编码英文 `aria-label`、`title`；
- 检查原生元素语义与 Tab 顺序；
- 检查 dialog/menu/drawer 焦点进入和返回；
- 为自有交互控件统一 `focus-visible`；
- 清理已迁移组件的 hex/rgb、shadow、font-size 和 duration；
- 不清理调试工具、媒体黑白遮罩等明确白名单；
- 检查浅色/深色对比度；
- 检查中文、英文、大字体和长名称。

### 13.2 完成条件

- 核心链路无未解释的自定义可点击 `div/span`；
- 新增正式文案全部进入 i18n；
- 不使用颜色作为唯一状态表达；
- 200% 文本下主要操作可到达；
- reduced motion 下无阻碍任务的动画。

## 14. R2：测试与自动化

### 14.1 建议新增

- LayoutService 三档断点测试；
- shell 跨 mode 状态保持测试；
- HomeHeader 双菜单互斥测试；
- ChatListPane 搜索/清除测试；
- ThreadList 键盘和状态测试；
- MessageHeader 动作收纳与 i18n 测试；
- ChatInput 录音提示、权限和互斥状态测试；
- token 使用静态报告；
- 核心页面自动截图；
- axe 或等价基础无障碍检查。

### 14.2 命令

根据当前项目脚本：

```bash
npm test --prefix web -- --watch=false
npm run build --prefix web
```

如果全量 Angular 浏览器测试耗时较长，开发中可以运行相关 spec，但每个工作包完成时执行全量测试。

### 14.3 真机保留项

以下项目不应仅靠浏览器自动化判定通过：

- Android 状态栏和手势区；
- 软键盘 lift、输入法切换和 composition；
- 系统返回；
- 麦克风、相机和通知权限；
- 扫码/视频透明层；
- 后台恢复和弱网；
- 触觉反馈和实际触控误触率。

## 15. 风险登记

| 风险 | 影响 | 预防/缓解 |
| --- | --- | --- |
| 工作区并行功能修改 | 覆盖或混合用户改动 | 每包开工检查状态，缩小文件范围 |
| 三档布局破坏当前导航动画 | 返回或会话状态异常 | W1 原子提交，保持 NavState 模型 |
| token 全局改值影响低频页面 | 大范围视觉退化 | T0 只新增，按组件启用新值 |
| 消息尺寸变化破坏滚动锚点 | 跳动、错位 | 不改内核，保持整数尺寸，逐卡片验证 |
| Material token 覆盖过宽 | 表单/菜单意外变化 | 统一映射但按组件类型截图 |
| Medium 宽度不足 | 双栏不可用 | 通过真实内容调整断点，允许退化 Compact |
| 动作收纳产生重复入口 | 键盘/读屏重复 | 结构条件渲染，不只 CSS 隐藏 |
| 录音提示干扰熟练用户 | 高频噪音 | 只首次或有限次数显示 |
| Android WebView 与浏览器差异 | 模拟通过、真机失败 | 每个相关包保留真机门 |
| 截图数据不稳定 | 无法可靠比较 | 固定 fixture、时钟和资源 |

## 16. 回退策略

- 每个工作包独立提交，禁止一次提交跨越 W1–W5；
- 新旧 token 在迁移期通过别名共存；
- 三档布局出现问题时可以将 Medium 暂时映射为 Compact；
- 新菜单入口复用原业务 action，视觉层失败时可恢复旧触发器；
- 消息视觉按卡片类型迁移，可单独回退某一类型；
- 不把数据库/API 变化与 UI 工作包绑定；
- 回退视觉不应回退已经验证正确的无障碍修复。

## 17. 每个工作包的验收模板

```text
工作包：
提交：

实现范围：
- 

明确未改：
- 

自动验证：
- [ ] 相关单元测试
- [ ] Web 全量测试
- [ ] 生产构建
- [ ] 静态检查

视觉验证：
- [ ] VP-C1
- [ ] VP-C2
- [ ] VP-C3
- [ ] VP-M1
- [ ] VP-M2
- [ ] VP-E1
- [ ] VP-E2
- [ ] 浅色
- [ ] 深色
- [ ] 中文
- [ ] 英文
- [ ] reduced motion

真机验证：
- [ ] Android 安全区
- [ ] 系统返回
- [ ] 软键盘
- [ ] 横屏
- [ ] 本工作包涉及的权限/原生能力

对应场景编号：
- 

已知问题：
- 
```

## 18. 第一批总体完成定义

第一批核心链路只有同时满足以下条件才完成：

- T0、W1、W2、W3、W4、W5a、W5b、R1、R2 均有独立可审查结果；
- Compact、Medium、Expanded 核心结构符合低保真方案；
- 新建和账户入口分离，搜索和空状态清楚；
- 会话行具备完整语义与交互状态；
- 聊天头部无 emoji 正式图标和硬编码英文辅助文本；
- 消息视觉已统一到 SOMS `--chat-*`；
- 输入区通过 Android 软键盘、录音、附件和横屏验证；
- 相关 P0 验收场景全部通过；
- P1 没有阻断主任务的问题；
- Web 全量测试与生产构建通过；
- 代表视口、主题和语言截图已归档；
- 已知问题均带场景编号和后续归属；
- 旧 token 兼容层有明确剩余引用和删除计划。

## 19. 推荐开工顺序

文档确认后按以下顺序正式进入代码：

1. 检查维护者已经整理好的工作区；
2. 执行 P0 基线；
3. 实施 T0 token 基础；
4. 实施 W1 三档布局；
5. 依次推进 W2–W5；
6. 完成 R1/R2 和全量验收。

第一个代码工作包应是 P0/T0，不直接从大面积页面改色开始。
