# SOMS C 端设计 Token 草案与迁移表

状态：Draft v0.1  
依赖：

- [SOMS C 端 UI 改造原则](./consumer-ui-redesign-principles.md)
- [SOMS C 端页面与状态验收矩阵](./consumer-ui-acceptance-matrix.md)

范围：`web/src/app/assets/_tokens.scss`、`web/src/styles.scss` 及 C 端组件样式

## 1. 目标

本草案在不更换 Angular Material/CDK、不一次性重写全部组件的前提下，建立 SOMS 自有的
视觉语言和可渐进迁移的 token 体系。

目标包括：

- 保留现有蓝色品牌资产，去除蓝色品牌与 WhatsApp 绿色聊天风格的竞争；
- 统一页面、列表、聊天、设置和认证的颜色与层级；
- 为字体、间距、圆角、阴影、交互状态和动效建立明确 token；
- 清理组件中的未定义 fallback、近似色值和重复阴影；
- 让浅色、深色和 Angular Material 组件使用同一语义来源；
- 支持分批迁移，每一批都可构建、可验证、可回退。

本文中的色值是视觉稿和对比度验证的输入，不是未经验证即可直接发布的最终值。

## 2. 现状盘点

### 2.1 已有基础

当前 `_tokens.scss` 已经具备：

- 品牌、文本、表面、边框和交互填充；
- 成功、警告、危险状态；
- 四级圆角和四级间距；
- 浅色/深色主题；
- Tauri/浏览器安全区；
- 聊天气泡、聊天背景、日期和媒体专属 token；
- Material 主按钮和危险按钮的品牌色绑定。

高频使用的现有 token：

| Token | 约使用次数 | 结论 |
| --- | ---: | --- |
| `--app-brand` | 81 | 保留并作为主色核心 |
| `--app-text-muted` | 77 | 保留，收紧语义 |
| `--app-text` | 76 | 保留 |
| `--app-surface` | 74 | 保留 |
| `--app-border` | 56 | 保留 |
| `--app-danger` | 31 | 保留 |
| `--app-radius-sm` | 30 | 保留但调整分工 |
| `--app-hover` | 30 | 保留并补齐 pressed/focus |
| `--app-radius-pill` | 28 | 保留 |
| `--app-radius-md` | 25 | 保留 |

这说明现有命名已经形成较大使用面。新版不应为了形式统一而大规模重命名这些核心 token。

### 2.2 主要问题

静态盘点发现以下问题：

- 生产组件中仍约有 235 处硬编码颜色表达式；
- 有约 26 处组件级 `box-shadow`；
- 有约 216 处组件级 `font-size`；
- 有约 206 个动效/过渡时间值；
- `--app-bg` 与 `--app-bg-muted` 在浅色主题取值相同，层级含义不清；
- `--app-surface` 与暗色 `--app-bg-muted` 取值相同，导航、输入栏和面板容易融为一层；
- 同时存在通用 `--app-bubble-*` 与 WhatsApp 风格 `--im-bubble-*` 两套消息语义；
- `--im-*` 使用 WhatsApp 绿色、米色壁纸和绿色头像，与 SOMS 蓝色品牌身份竞争；
- 多处使用未定义 token 加 fallback，例如 `--app-primary`、`--app-accent`、
  `--app-info-bg`、`--app-danger-bg`、`--app-success-bg`、`--app-text-secondary`；
- 同一含义存在 `soft`、`muted`、`faint`、`secondary` 等多种近似命名；
- 正式界面、媒体遮罩、调试工具和开发 playground 的硬编码色没有分类边界；
- Material 映射目前主要覆盖按钮，表单、列表、对话框、菜单和状态层仍可能与自有组件漂移。

### 2.3 允许保留的硬编码

以下类型可以在注释说明后保留，不强制 token 化：

- 相册/视频查看器的纯黑媒体舞台和白色媒体控件；
- QR 码必须使用的黑白前景；
- SVG 品牌资产内部的固定品牌色；
- 调试日志面板等仅开发/诊断使用的独立高对比配色；
- 图片/视频遮罩的黑白透明色；
- 原生通话视频上的黑色舞台和白色控制层。

允许保留不代表可以无限复制。相同媒体遮罩仍应优先复用局部组件 token。

## 3. 命名和分层策略

新版继续使用 `--app-*` 作为公共语义命名空间，不引入第二套 `--soms-color-*` 重复体系。

### 3.1 三层结构

```text
原始色阶/数值（Sass 私有）
        ↓
全局语义 token（--app-*）
        ↓
组件局部 token（--chat-* / --composer-* / --dialog-*）
```

- 原始色阶仅在 `_tokens.scss` 内使用；
- 业务组件默认只使用全局语义 token；
- 复杂组件可以定义局部 token，但局部 token 的默认值必须引用全局语义 token；
- 局部 token 不能成为跨组件共享的隐式公共 API。

### 3.2 语义规则

- `bg`：页面最底层背景；
- `surface`：承载内容的实体表面；
- `elevated`：菜单、弹窗等浮层；
- `text`：文字和图标前景；
- `soft`：低强调容器色，不表示透明度；
- `hover`、`pressed`、`selected`：明确的交互状态；
- `self/other` 迁移为 `outgoing/incoming`，避免将视觉方向和用户身份耦合；
- 颜色 token 不包含具体组件名，除非属于聊天等明确的领域语义。

## 4. 色彩 Token 草案

### 4.1 品牌与前景

| Token | 浅色草案 | 深色草案 | 用途 |
| --- | --- | --- | --- |
| `--app-brand` | `#2196f3` | `#64b5f6` | 品牌主色、链接、选中强调 |
| `--app-brand-hover` | `#1976d2` | `#90caf9` | fine pointer hover |
| `--app-brand-pressed` | `#1565c0` | `#42a5f5` | 按压状态 |
| `--app-brand-soft` | `#e3f2fd` | `#16384f` | 品牌弱容器、选中弱背景 |
| `--app-on-brand` | `#ffffff` | `#071a28` | 品牌实色容器上的内容 |
| `--app-on-brand-soft` | `#0d4770` | `#b9e1fb` | 品牌弱容器上的内容 |
| `--app-focus-ring` | `#0b74c5` | `#90caf9` | 全局可见焦点 |

说明：

- 现有品牌标志继续使用 `#2196f3`；
- 深色主题可使用更亮的品牌前景以保证对比度，品牌资产本身不必变色；
- 所有品牌实色按钮使用 `--app-on-brand`，不再到处硬编码 `#fff`；
- `--app-brand-accent` 暂时只保留为认证页装饰兼容别名，后续不用于交互。

### 4.2 页面和表面

| Token | 浅色草案 | 深色草案 | 用途 |
| --- | --- | --- | --- |
| `--app-bg` | `#f4f6f8` | `#0f171d` | App 最底层背景 |
| `--app-surface` | `#ffffff` | `#182229` | 主面板、列表、卡片 |
| `--app-surface-subtle` | `#f7f9fa` | `#1d2931` | 导航、输入栏、次级区域 |
| `--app-surface-elevated` | `#ffffff` | `#24323b` | 菜单、弹窗、浮层 |
| `--app-surface-sunken` | `#eef2f5` | `#0b1318` | 输入内部、媒体占位、凹陷区域 |
| `--app-overlay` | `rgba(15, 23, 42, 0.40)` | `rgba(0, 0, 0, 0.62)` | 普通遮罩 |
| `--app-overlay-strong` | `rgba(0, 0, 0, 0.72)` | `rgba(0, 0, 0, 0.82)` | 媒体/阻断遮罩 |

迁移原则：

- `--app-bg-muted` 先别名到 `--app-surface-subtle`，完成迁移后废弃；
- 页面背景、面板表面、输入栏不能再共享完全相同的值；
- 认证页面的大背景、聊天列表表面和设置表面使用同一层级规则。

### 4.3 文本与图标

| Token | 浅色草案 | 深色草案 | 用途 |
| --- | --- | --- | --- |
| `--app-text` | `#17212b` | `#eef3f5` | 主标题、正文 |
| `--app-text-muted` | `#5f6b76` | `#a6b3ba` | 摘要、说明、次要图标 |
| `--app-text-faint` | `#7b8792` | `#83929a` | 时间戳、占位符 |
| `--app-text-disabled` | `#a6afb7` | `#66747c` | 禁用内容 |
| `--app-text-inverse` | `#ffffff` | `#10181e` | 深色/高亮容器上的内容 |

规则：

- `--app-text-secondary` → `--app-text-muted`；
- `--app-text-soft` → 根据语境迁移为 `muted` 或 `faint`；
- `muted` 用于仍需要阅读的信息，`faint` 只用于元数据和占位符；
- 禁用状态使用专用 token，不通过任意 opacity 叠加制造。

### 4.4 边框和交互状态

| Token | 浅色草案 | 深色草案 | 用途 |
| --- | --- | --- | --- |
| `--app-border` | `#e1e6ea` | `#2b3942` | 普通分割线 |
| `--app-border-strong` | `#c9d1d8` | `#42515a` | 输入、可交互轮廓 |
| `--app-hover` | `rgba(23, 33, 43, 0.06)` | `rgba(238, 243, 245, 0.07)` | hover |
| `--app-pressed` | `rgba(23, 33, 43, 0.11)` | `rgba(238, 243, 245, 0.12)` | pressed |
| `--app-selected` | `var(--app-brand-soft)` | `var(--app-brand-soft)` | 普通选中 |
| `--app-selected-strong` | `#d4ebfb` | `#204864` | 会话等持续选中 |
| `--app-disabled-opacity` | `0.44` | `0.44` | 仅用于复合图形整体禁用 |

迁移原则：

- `--app-active` → `--app-selected-strong`；
- 所有自定义按钮补齐 `hover`、`pressed` 和 `focus-visible`；
- touch 设备的主要反馈来自 pressed，不依赖 hover；
- 焦点使用 outline/ring，不通过 hover 背景代替。

### 4.5 状态颜色

| Token | 浅色草案 | 深色草案 | 用途 |
| --- | --- | --- | --- |
| `--app-success` | `#16834a` | `#54d38a` | 成功前景 |
| `--app-success-soft` | `#e8f7ef` | `#173c2a` | 成功容器 |
| `--app-warning` | `#9a5b00` | `#f4bd62` | 警告前景 |
| `--app-warning-soft` | `#fff3dc` | `#46341b` | 警告容器 |
| `--app-danger` | `#c93636` | `#ff7b7b` | 危险前景 |
| `--app-danger-soft` | `#fdecec` | `#4b2427` | 危险容器 |
| `--app-info` | `var(--app-brand)` | `var(--app-brand)` | 信息前景 |
| `--app-info-soft` | `var(--app-brand-soft)` | `var(--app-brand-soft)` | 信息容器 |
| `--app-on-status` | `#ffffff` | `#0e171c` | 状态实色容器内容 |

迁移原则：

- `--app-success-bg` → `--app-success-soft`；
- `--app-danger-bg` → `--app-danger-soft`；
- `--app-info-bg` → `--app-info-soft`；
- 警告和危险不再由组件自行选取 amber/red 色阶；
- 状态不能仅依赖颜色，必须配合图标或文字。

## 5. 聊天领域 Token 草案

### 5.1 聊天背景与气泡

为了形成 SOMS 自有视觉，聊天区从 WhatsApp 米色/绿色迁移到品牌蓝与中性表面：

| 新 Token | 浅色草案 | 深色草案 | 用途 |
| --- | --- | --- | --- |
| `--chat-bg` | `#edf3f7` | `#0d171d` | 消息时间线背景 |
| `--chat-pattern` | 低对比 SOMS 图形或 `none` | 对应暗色版本或 `none` | 可选背景纹理 |
| `--chat-bubble-outgoing` | `#dff1fc` | `#173e57` | 自己发送的消息 |
| `--chat-bubble-incoming` | `#ffffff` | `#1d2a32` | 收到的消息 |
| `--chat-text` | `#17212b` | `#eef3f5` | 消息正文 |
| `--chat-meta` | `#66737d` | `#9dabb2` | 时间、状态 |
| `--chat-meta-on-media` | `#ffffff` | `#ffffff` | 媒体遮罩上的元数据 |
| `--chat-date-bg` | `rgba(255,255,255,0.88)` | `rgba(36,50,59,0.94)` | 日期胶囊 |
| `--chat-date-text` | `var(--app-text-muted)` | `var(--app-text-muted)` | 日期文字 |
| `--chat-media-meta-bg` | `rgba(0,0,0,0.52)` | `rgba(0,0,0,0.58)` | 媒体元数据遮罩 |
| `--chat-message-shadow` | `0 1px 2px rgba(15,23,42,0.10)` | `0 1px 2px rgba(0,0,0,0.28)` | 必要时的气泡分离 |

设计意图：

- outgoing 使用品牌蓝的浅容器色，不使用高饱和实色，长文本更易读；
- incoming 使用中性表面；
- 两侧正文均使用高对比深/浅文字，不依赖白字；
- 背景纹理默认降到极低对比，视觉验证后可以直接取消；
- 头像不再使用 WhatsApp 绿色，统一走头像组件自己的确定性色板。

### 5.2 旧 IM Token 迁移

| 旧 Token | 新 Token | 策略 |
| --- | --- | --- |
| `--im-chat-bg` | `--chat-bg` | 旧名先作为别名 |
| `--im-chat-pattern` | `--chat-pattern` | 视觉确认后迁移 |
| `--im-bubble-self` | `--chat-bubble-outgoing` | 重命名并改品牌蓝容器 |
| `--im-bubble-other` | `--chat-bubble-incoming` | 重命名 |
| `--im-bubble-text` | `--chat-text` | 重命名 |
| `--im-time` | `--chat-meta` | 重命名 |
| `--im-meta-bg` | `--chat-media-meta-bg` | 重新定义为媒体遮罩语义 |
| `--im-date-pill-bg` | `--chat-date-bg` | 重命名 |
| `--im-date-pill-text` | `--chat-date-text` | 重命名 |
| `--im-sticky-date-bg` | `--chat-date-bg` | 合并；浮动态通过阴影表达 |
| `--im-date-pill-shadow` | `--app-shadow-1` | 使用全局 elevation |
| `--im-avatar-self` | 无 | 删除，交给头像组件 |
| `--im-avatar-other` | 无 | 删除，交给头像组件 |
| `--im-media-gap` | `--app-space-0-5` | 仅相册网格需要时保留局部 token |
| `--im-media-radius` | `--app-radius-md` | 直接引用全局 |
| `--invite-bg` | `--app-info-soft` 或卡片局部 token | 由邀请卡视觉方案决定 |

迁移期可在 `_tokens.scss` 中使用：

```scss
--im-chat-bg: var(--chat-bg);
--im-bubble-self: var(--chat-bubble-outgoing);
--im-bubble-other: var(--chat-bubble-incoming);
```

别名只用于过渡，完成消息组件迁移后删除。

## 6. 字体 Token 草案

系统字体栈继续由 Angular Material 主题提供。组件不自行声明字体家族。

| Token | 字号/行高 | 字重 | 用途 |
| --- | --- | ---: | --- |
| `--app-type-page-title` | `24px / 32px` | 650 | 登录、独立页面标题 |
| `--app-type-section-title` | `20px / 28px` | 650 | 页面区域标题 |
| `--app-type-nav-title` | `18px / 24px` | 650 | 顶栏、主要导航标题 |
| `--app-type-list-title` | `16px / 22px` | 600 | 会话名、设置项标题 |
| `--app-type-body` | `15px / 22px` | 400 | 消息和普通正文 |
| `--app-type-body-small` | `14px / 20px` | 400 | 列表预览、说明 |
| `--app-type-caption` | `12px / 16px` | 400 | 时间戳、状态 |
| `--app-type-label` | `13px / 18px` | 600 | 按钮、标签 |

CSS 自定义属性不能直接包含多个声明，建议实现为独立 size、line-height、weight token，或使用
Sass mixin 输出。例如：

```scss
--app-font-size-body: 15px;
--app-line-height-body: 22px;
--app-font-weight-regular: 400;
```

首批迁移不要求一次性替换 216 处字号。先覆盖顶栏、会话列表、消息和输入区，再迁移其他页面。

## 7. 间距与尺寸 Token 草案

现有 4/8/12/16 不足以覆盖小缝隙、大区域和触控尺寸。

| Token | 值 | 用途 |
| --- | ---: | --- |
| `--app-space-0-5` | `2px` | 媒体网格、微小光学修正 |
| `--app-space-1` | `4px` | 紧凑内部间距 |
| `--app-space-2` | `8px` | 图标与文字、小组件 |
| `--app-space-3` | `12px` | 列表内部、按钮组 |
| `--app-space-4` | `16px` | 页面标准水平边距 |
| `--app-space-5` | `20px` | 卡片内部 |
| `--app-space-6` | `24px` | 区域间距 |
| `--app-space-8` | `32px` | 大区块 |
| `--app-space-10` | `40px` | 认证等宽松布局 |

尺寸 token：

| Token | 值 | 用途 |
| --- | ---: | --- |
| `--app-control-sm` | `32px` | 桌面紧凑次要控件 |
| `--app-control-md` | `40px` | 常规控件 |
| `--app-control-lg` | `48px` | 移动端主控件 |
| `--app-touch-target` | `44px` | 最小推荐触控区域 |
| `--app-header-compact` | `56px` | Compact 顶栏内容高度 |
| `--app-header-expanded` | `64px` | Expanded 主顶栏上限 |
| `--app-content-max` | `720px` | 表单/设置正文最大宽度参考 |

安全区 token `--soms-safe-top`、`--soms-safe-bottom` 原名保留，它们是原生壳与 Web 之间的接口，
不参与视觉命名迁移。

## 8. 圆角与阴影 Token 草案

### 8.1 圆角

| Token | 值 | 用途 |
| --- | ---: | --- |
| `--app-radius-xs` | `4px` | 微型标签、媒体小元素 |
| `--app-radius-sm` | `8px` | 按钮、输入、小卡片 |
| `--app-radius-md` | `12px` | 菜单、卡片、媒体 |
| `--app-radius-lg` | `16px` | 弹窗、认证卡片 |
| `--app-radius-xl` | `24px` | 大型底部面板 |
| `--app-radius-pill` | `9999px` | 胶囊、头像和圆形按钮 |

现有 `sm=6px`、`md=10px` 可在首批组件改造时切换，不单独做全局突变，避免未检查页面同时变化。

消息气泡需要方向性角点，应使用聊天组件局部 token 或 mixin，不新增 `radius-message-self-*`
一类全局 token。

### 8.2 阴影

| Token | 浅色草案 | 用途 |
| --- | --- | --- |
| `--app-shadow-0` | `none` | 默认表面 |
| `--app-shadow-1` | `0 1px 3px rgba(15,23,42,0.12)` | 日期胶囊、轻浮层 |
| `--app-shadow-2` | `0 6px 20px rgba(15,23,42,0.16)` | 菜单、popover |
| `--app-shadow-3` | `0 16px 48px rgba(15,23,42,0.22)` | 弹窗、抽屉 |

深色主题可以提高黑色 alpha，但不能新增等级。`--app-shadow-float` 迁移为 `--app-shadow-2`
兼容别名。

## 9. 动效 Token 草案

| Token | 值 | 用途 |
| --- | ---: | --- |
| `--app-motion-instant` | `80ms` | 按压、颜色反馈 |
| `--app-motion-fast` | `140ms` | hover、菜单微交互 |
| `--app-motion-medium` | `220ms` | 页面、抽屉、弹窗 |
| `--app-motion-slow` | `320ms` | 有空间关系的复杂切换 |
| `--app-ease-standard` | `cubic-bezier(0.2, 0, 0, 1)` | 常规状态变化 |
| `--app-ease-enter` | `cubic-bezier(0, 0, 0, 1)` | 元素进入 |
| `--app-ease-exit` | `cubic-bezier(0.3, 0, 1, 1)` | 元素退出 |

规则：

- 颜色和按压反馈使用 instant/fast；
- 页面级滑入不超过 medium；
- 列表 FLIP 可以使用 slow，但 reduced motion 下关闭；
- Android 键盘避让的 60ms 低通逻辑属于平台性能参数，不强行替换为视觉 motion token；
- TypeScript/WAAPI 动画从共享常量读取，避免与 CSS token 漂移。

## 10. 响应式 Token 草案

CSS 与 `LayoutService` 应共享同一组语义断点来源。初始建议：

| 模式 | 建议范围 | 说明 |
| --- | --- | --- |
| Compact | `< 720px` | 手机和窄窗口 |
| Medium | `720–1099px` | 平板、折叠屏、窄桌面 |
| Expanded | `≥ 1100px` | 三栏/主从桌面布局 |

这些值需要通过验收矩阵中的 VP-C、VP-M、VP-E 和断点上下实测后确定。

建议代码层提供：

```scss
$app-bp-medium: 720px;
$app-bp-expanded: 1100px;
```

同时在 TypeScript 中保持同一注释与测试用例。CSS 自定义属性不能用于 media query，
因此不能假设在运行时通过 `var()` 共享断点。

## 11. Angular Material 映射

Angular Material 继续提供 primitive 和无障碍行为，但颜色、圆角和密度由 SOMS 语义约束。

### 11.1 应全局映射

- filled/text/outlined/icon button 的品牌、危险、禁用和 state layer；
- form field 的表面、文本、轮廓、错误和 focus；
- checkbox/radio/slide toggle 的品牌和禁用；
- list/action-list 的 hover、pressed 和 selected；
- menu/dialog/snackbar 的 elevated surface、文字、圆角和阴影；
- progress indicator 的品牌和 track；
- tooltip 的 inverse surface 和文字。

### 11.2 不应组件内覆盖

- 页面为了“看起来协调”直接修改 MDC 内部类；
- 单个按钮重新绑定全套 `--mat-button-*`；
- 每个对话框声明不同 surface/shadow；
- 通过 `::ng-deep` 处理可由全局主题解决的问题。

### 11.3 映射原则

`styles.scss` 是 Material token 与 SOMS token 的唯一映射层。组件只使用公开的 Material 输入、
语义 class 或 SOMS 自有 wrapper，不感知 M3 原始调色板。

## 12. 现有公共 Token 迁移表

| 现有 Token | 目标 | 操作 |
| --- | --- | --- |
| `--app-brand` | 保留 | 值按主题调整 |
| `--app-brand-hover` | 保留 | 补 `pressed` |
| `--app-brand-soft` | 保留 | 明确为弱品牌容器 |
| `--app-brand-accent` | 认证局部 token | 公共层逐步废弃 |
| `--app-text` | 保留 | 无 |
| `--app-text-muted` | 保留 | 统一 secondary 语义 |
| `--app-text-faint` | 保留 | 限定元数据/placeholder |
| `--app-text-secondary` | `--app-text-muted` | 删除 fallback 别名 |
| `--app-text-soft` | `muted` 或 `faint` | 按组件语境迁移 |
| `--app-surface` | 保留 | 无 |
| `--app-bg` | 保留 | 明确为页面底层 |
| `--app-bg-muted` | `--app-surface-subtle` | 先别名、后废弃 |
| `--app-surface-elevated` | 保留 | 绑定 shadow 等级 |
| `--app-border` | 保留 | 无 |
| `--app-border-strong` | 保留 | 无 |
| `--app-hover` | 保留 | 补 pressed/selected |
| `--app-active` | `--app-selected-strong` | 先别名、后废弃 |
| `--app-danger` | 保留 | 无 |
| `--app-danger-soft` | 保留 | 无 |
| `--app-danger-bg` | `--app-danger-soft` | 删除未定义 fallback |
| `--app-success` | 保留 | 无 |
| `--app-success-soft` | 保留 | 无 |
| `--app-success-bg` | `--app-success-soft` | 删除未定义 fallback |
| `--app-warning` | 保留 | 新增 warning-soft |
| `--app-info-bg` | `--app-info-soft` | 正式定义并迁移 |
| `--app-primary` | `--app-brand` | 删除未定义 fallback |
| `--app-accent` | `--app-brand` 或局部角色色 | 按语境迁移 |
| `--app-bubble-self` | `--chat-bubble-outgoing` | 与 `--im-*` 合并 |
| `--app-bubble-other` | `--chat-bubble-incoming` | 与 `--im-*` 合并 |
| `--app-shadow-float` | `--app-shadow-2` | 兼容别名 |
| `--app-radius-*` | 保留并扩展 | 分批调整值 |
| `--app-space-*` | 保留并扩展 | 无 |
| `--soms-safe-*` | 保留 | 原生接口，不重命名 |

## 13. 首批核心组件映射

| 组件 | 应使用的主要 token |
| --- | --- |
| 移动首页头部 | surface、text、border、control、space、focus |
| 桌面图标导航 | surface-subtle、hover、pressed、selected、brand |
| 会话搜索 | surface-sunken、border-strong、text-faint、focus-ring |
| 文件夹标签 | surface、brand-soft、on-brand-soft、radius-pill |
| 会话行 | hover、pressed、selected-strong、text、muted、faint |
| 未读角标 | brand、on-brand、caption、radius-pill |
| 聊天头部 | surface、border、text、muted、control |
| 消息时间线 | chat-bg、chat-pattern |
| 收发气泡 | chat-bubble-incoming/outgoing、chat-text、chat-meta |
| 日期胶囊 | chat-date-bg/text、shadow-1 |
| 输入栏 | surface-subtle、surface、border、focus-ring |
| 发送/录音按钮 | brand/on-brand、danger/on-status、pressed |
| 附件和 emoji 面板 | surface-elevated、border、shadow-2、radius-md |

## 14. 分阶段迁移方案

### 阶段 T0：只新增，不改变现有视觉

- 在 `_tokens.scss` 增加缺失 token；
- 旧 token 指向新 token 的兼容别名；
- 增加字体、尺寸、阴影和 motion token；
- 在 `styles.scss` 扩展 Material 映射；
- 添加 token 存在性或静态检查；
- 构建和截图应与迁移前基本一致。

### 阶段 T1：首页与会话列表

- 迁移首页头部、桌面导航、搜索、文件夹和会话行；
- 引入 hover/pressed/selected/focus 完整状态；
- 验证 HOME、SHELL 对应场景；
- 此阶段开始采用新 surface 层级。

### 阶段 T2：聊天核心

- 引入 `--chat-*`；
- 迁移消息时间线、所有消息卡片、日期和输入区；
- 移除 WhatsApp 绿色/米色的直接语义；
- 验证 MSG、INPUT、CHAT-H 场景；
- 完成后删除 `--app-bubble-*` 与大部分 `--im-*` 使用。

### 阶段 T3：设置、认证和社交页面

- 迁移 Material 表单、列表、卡片和弹窗；
- 统一状态容器、危险操作和页面字体；
- 清理 `--app-*-bg` 等未定义 fallback。

### 阶段 T4：媒体、原生覆盖层和低频页面

- 区分允许保留的媒体黑白色与应迁移的普通 UI；
- 统一画廊、文件详情、扫码和通话控件；
- 保留调试工具独立色彩边界。

### 阶段 T5：清理兼容层

- 删除已无引用的旧 token；
- 禁止新组件使用废弃 token；
- 检查硬编码颜色、阴影、字号和 duration；
- 执行全量视觉回归与真实设备验收。

## 15. 静态约束建议

为了避免迁移后再次扩散：

- 为允许的硬编码颜色建立明确路径白名单；
- 检查生产组件中新增的 hex/rgb 值；
- 检查 `var(--token, fallback)` 中未定义的公共 token；
- 检查正式模板中的硬编码英文 `aria-label` 和 `title`；
- 组件新增 `box-shadow` 时要求使用 `--app-shadow-*`；
- 新增 `font-size`、duration 和 z-index 时优先使用对应 token；
- 不阻止局部几何变量，例如虚拟列表高度、键盘 lift 和动画测量值。

静态检查应先以报告模式运行，迁移完成后再升级为阻断规则。

## 16. 视觉确认门

实现 T0/T1 前需要通过低保真和样式样板确认以下项目：

1. outgoing 蓝色弱气泡是否符合品牌感和长文本可读性；
2. incoming 气泡与页面表面的分离程度；
3. 是否取消聊天壁纸，或替换为极低对比 SOMS 图形；
4. 浅色/深色四级 surface 是否足以表达导航、页面、输入和浮层；
5. 会话选中采用品牌弱容器还是中性容器；
6. 8/12/16px 圆角组合是否符合期望的克制程度；
7. Compact 与 Expanded 是否使用相同字体等级；
8. 深色品牌色调整是否仍与固定蓝色 Logo 协调。

这些确认应使用首页、会话列表、聊天和输入区的同屏样板完成，而不是孤立色板。

## 17. 完成标准

Token 迁移完成需要满足：

- 公共 token 均在 `_tokens.scss` 定义，不依赖组件 fallback 才能工作；
- 浅色和深色主题语义一一对应；
- Material 与自有组件使用同一品牌、状态、表面和文本角色；
- `--app-bubble-*` 与 `--im-bubble-*` 已合并为一套 `--chat-*`；
- 正式 UI 不再使用 WhatsApp 绿色作为默认聊天身份色；
- 首页、聊天、设置和认证共享同一字体、圆角、阴影和交互状态语言；
- 核心组件不新增无说明硬编码颜色；
- 所有相关 P0 验收场景通过；
- 兼容别名有明确删除批次，不永久保留两套公共 API。

## 18. 下一份产出

下一步制作首页、会话列表和聊天页低保真结构方案，包括：

- Compact、Medium、Expanded 页面结构；
- 导航、搜索、新建、账户入口的层级；
- 会话行信息模型；
- 聊天头部的操作收纳规则；
- 消息区和输入区的空间关系；
- 空状态、搜索、断网和发送失败等关键状态；
- 与现有 Angular 组件的对应关系和第一批改造边界。
