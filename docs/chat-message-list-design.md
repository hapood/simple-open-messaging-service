# 聊天消息列表设计规范（移动端 · 1v1）

本文档固化 SOMS **移动端一对一聊天「消息列表」**的视觉与布局设计规范，作为前端实现（`MsgGroupComponent` 及其外围）的单一事实源。所有数值、结构、配色以本文档为准。

> **状态**：已在虚拟滚动 playground（`/playground/chatbox-a`）中验证；待 phase-4 落地为真实消息组件。关键设计的演进见文末[决策记录](#决策记录)。

## 目录

- [1. 设计风格](#1-设计风格)
- [2. 消息行结构](#2-消息行结构)
- [3. 气泡](#3-气泡)
- [4. 头像](#4-头像)
- [5. 名字标签](#5-名字标签)
- [6. 尾尖 handle](#6-尾尖-handle)
- [7. 时间戳与日期分隔](#7-时间戳与日期分隔)
- [8. 色彩与明暗主题](#8-色彩与明暗主题)
- [9. 尺寸与间距汇总](#9-尺寸与间距汇总)
- [10. 分组规则](#10-分组规则)
- [11. 桌面端差异](#11-桌面端差异)
- [12. 明确不做的事](#12-明确不做的事)
- [13. 参考实现](#13-参考实现)
- [14. 滚动架构](#14-滚动架构相对滚动)
- [决策记录](#决策记录)

---

## 1. 设计风格

- **WhatsApp 风**（已弃 iMessage / Telegram）：浅色填充气泡、小圆角、每条气泡内嵌右下时间戳、组首带头像 + 尾尖指向头像。
- **头像为微信式方形**（8px 圆角，非圆形）。
- **业界对齐**：消息头像 **40px**（WhatsApp / 微信 / Telegram / Discord / Material Design 规范均 ~40px）。
- 整体消费项目设计 token（`--app-*`，定义见 [`web/src/app/assets/_tokens.scss`](../web/src/app/assets/_tokens.scss)）；气泡色等 IM 语义色按本规范硬编码。

## 2. 消息行结构

每条消息是一个 flex 行（`.pg-msg-row`），头像与「名字 + 气泡」列（`.pg-col`）为兄弟元素：

```
他方消息（avatar 在左）            self 消息（avatar 在右）
┌─────────────────────────────┐    ┌─────────────────────────────┐
│ [头像] [gap] [ col ]         │    │ [ col ] [gap] [头像]         │
│  40px   8px  ┌ name(仅他方)  │    │  name 无      ┐              │
│              └ bubble        │    │  bubble       │ 40px         │
│ justify-content: flex-start  │    │ justify-content: flex-end    │
└─────────────────────────────┘    └─────────────────────────────┘

col = flex-column：[名字?(仅他方组首)] → [气泡(内嵌右下时间戳)]
```

布局规则：

- 行 `display:flex`；他方 `justify-content:flex-start`、self `justify-content:flex-end`。
- 组首（`isShowHead`）行才挂头像；**组内行不重复头像**，但 col 用 margin 让出头像列，使组内气泡与组首气泡的边沿对齐。
- 头像 `align-self:flex-start`，**贴该行顶部、与组首第一条消息上沿对齐**。

## 3. 气泡

| 属性 | 值 |
| --- | --- |
| `min-height` | `40px`（短消息「好」「ok」不瘪，纯 UI 参数，与虚拟滚动高度计算无关） |
| `padding` | `6px 10px`（右下时间戳由「影子占位」动态让出，见 [§7](#7-时间戳与日期分隔)） |
| 字号 / 行高 | `14.2px / 1.4`，`white-space:pre-wrap; word-break:break-word` |
| `max-width`（移动） | `calc(100% - 104px)`（两侧各让一个头像列 48×2 + 8 余量，防最长气泡碰到对方头像） |
| `box-shadow` | `0 1px 0.5px rgba(0,0,0,.13)` |

**圆角按组位**（`pg-head` / `pg-mid` / `pg-tail`）非对称——组首靠头像侧顶角大、贴邻侧小；组尾反向；组中两侧小：

| 组位 | class | 左上 / 右上 | 左下 / 右下 | 说明 |
| --- | --- | --- | --- | --- |
| 组首 | `pg-head` | 10 / 10* | 3 / 3 | 头像侧顶角收尖 3px 接尾尖（见他方行注） |
| 组中 | `pg-mid` | 3 / 3 | 3 / 3 | |
| 组尾 | `pg-tail` | 3 / 3 | 10 / 10 | |

> *组首顶角收尖：**他方**左上角 3px（尾尖在顶角）；**self** 因尾尖下移、右上角保持 10px（见 [§6](#6-尾尖-handle)）。单条消息（独占一组）使用 `head` 样式。

## 4. 头像

| 属性 | 值 |
| --- | --- |
| 尺寸 | **40 × 40 px**（业界规范） |
| 圆角 | `8px`（微信式方形） |
| 出现时机 | **双方组首（`isShowHead`）都显**——self 在右、other 在左（对称设计）；组内不重复 |
| 垂直对齐 | `align-self:flex-start`，贴组首消息上沿 |
| 字号（首字母/字） | `16px`，weight 600，白色 |
| self 底色 | `#25D366` |
| other 底色 | `#C7C7CC`（暗色 `#37424a`） |
| header 头像 | 可更小（`32px`）——header 更密集，且 48px 高的 header 装不下 40px；与消息头像大小不一属正常 |

**组内行让位**：col `margin-left/right: 48px`（= 40 头像 + 8 间距），使组内气泡边沿与组首气泡对齐；组首 col 仅留 8px 与头像间距。

## 5. 名字标签

- **仅他方组首显发送者名字**；**self 默认不署名**（业界规范：自己发的消息不署名，WhatsApp / 微信 / Telegram / iMessage / Discord / Slack 均如此）。
- 不学 WhatsApp 1v1 把他方名字也省了——保留他方名字以兼容群聊场景（群聊里他方名字用于区分多人）。
- 名字**与气泡边沿对齐**（不缩进）：`font-size:11px; font-weight:600; color:var(--app-text-muted); margin:0 0 2px`。

> 隐藏 self 名字的连带影响：self 气泡上移到行顶（无名字行），导致尾尖需下移——见 [§6](#6-尾尖-handle)。

## 6. 尾尖 handle

组首气泡带一个三角 handle 指向各自头像。两侧**机制不同、落点一致**（都指向头像中上部、绝对高度 ~15px 对齐）：

| 侧 | 位置 | 顶角处理 | 原因 |
| --- | --- | --- | --- |
| 他方 | 气泡**顶角**（`top:0`） | 头像侧顶角收尖 3px 接尾尖 | 他方有名字，气泡下沉到 ~15px，顶角正好对着头像中上部 |
| self | **下移到头像垂直中线**（`top:13px ≈ 40/2−7`） | 顶角保持圆角 10px | self 无名字、气泡贴行顶，顶角在最上方，尾尖需下移才能对齐他方、指向头像中部 |

**实现：CSS border 三角（非对称 border-width）**

```scss
.pg-bubble.pg-head::before {                 // 尾尖基类
  content: ''; position: absolute;
  border-style: solid; border-color: transparent;
}
// 他方：◀ 指左（头像在左），尾尖在顶角
.pg-bubble.pg-head.pg-other::before {
  left: -7px; top: 0;
  border-width: 7px 7px 7px 0;               // 关键：左 border=0 → 整个伪元素即三角，探出气泡左沿
  border-right-color: #FFFFFF;               // = other 气泡色（暗色改 #202c33）
}
// self：▶ 指右（头像在右），尾尖下移到头像中线
.pg-bubble.pg-head.pg-self::before {
  right: -7px; top: 13px;
  border-width: 7px 0 7px 7px;               // 关键：右 border=0 → 三角填满，探出气泡右沿
  border-left-color: #DCF8C6;                // = self 气泡色（暗色改 #005c4b）
}
```

> **务必用非对称 `border-width`**（头像侧为 0）。若四边等宽 `border:7px solid transparent` 再染一边，伪元素会是 14px 宽，三角落在**同色气泡内部**（x∈[0,7]）→ 完全看不见。这是该方案唯一已知陷阱。

> **尾尖颜色必须与气泡背景一致**（亮 / 暗色不同），否则露馅。已读、悬停等状态若改变气泡色，须同步改尾尖色。

## 7. 时间戳与日期分隔

- **时间戳**：WhatsApp 式，**每条气泡右下角内嵌**（不按组、每条都显）。`position:absolute; right:10px; bottom:4px; font-size:11px; white-space:nowrap`。亮色 `rgba(0,0,0,.45)`、暗色 `rgba(233,237,239,.5)`。**文案恒为 `HH:mm`**——WhatsApp 不在气泡上显日期（避免长串压正文），日期/年份上下文全交由日期分隔行承载。
  - **防与正文重叠 —— WhatsApp「影子占位法」**：正文 `<p>` 末尾追加一个 `visibility:hidden` 的「影子时间戳」（与可见时间**同文同字号** → 同宽度），逼末行正文让出右下角；可见时间 `position:absolute` 贴右下、叠在影子占位上。气泡 `padding-right` 因此**不再固定留白**（仅 `10px`）——影子按时间实际宽度占位。机制：末行 + 影子放得下 → 影子居末行右侧、时间叠上；放不下 → 影子独占新行、时间落该行，正文永不侵入时间区。
- **日期分隔**：居中 pill，纵向留白用 `padding:14px 0`（**不可用 `margin`**——内核用 `offsetHeight` 测高不含 margin，而 margin 会把绝对定位的行下推、却不计入高度，导致与下方气泡重叠遮挡；曾见的 pg-date 被气泡遮挡 bug 即此）。span `font-size:11px; font-weight:500; padding:3px 12px; border-radius:9999px`。底色亮 `rgba(0,0,0,.06)` / 暗 `#182229`，文字 `--app-text-faint`。**文案相对「现在」分级**（WhatsApp 惯例）：今天 → `今天`；昨天 → `昨天`；本周(今往前 2–6 天) → `周X`；今年更早 → `M月D日`；跨年 → `YYYY年M月D日`。

## 8. 色彩与明暗主题

| 用途 | 亮色 | 暗色 |
| --- | --- | --- |
| 聊天区底色 | `#f4f6f9`（`--app-bg`） | `#0b141a` |
| self 气泡 | `#DCF8C6` | `#005c4b` |
| other 气泡 | `#FFFFFF` | `#202c33` |
| 气泡文字 | `#303030` | `#e9edef` |
| 时间戳 | `rgba(0,0,0,.45)` | `rgba(233,237,239,.5)` |
| self 头像底 | `#25D366` | `#25D366` |
| other 头像底 | `#C7C7CC` | `#37424a` |
| 日期 pill 底 | `rgba(0,0,0,.06)` | `#182229` |

**主题机制**：语义 token（`--app-bg` / `--app-surface` / `--app-text` 等）解耦明暗，切主题只重定义变量、组件零改动。生产侧用 `[data-theme="dark"]` 重定义 token（[`_tokens.scss`](../web/src/app/assets/_tokens.scss) 已预留占位）；气泡等 IM 硬编码色在暗色块里覆盖。

## 9. 尺寸与间距汇总

| 项 | 值 | 备注 |
| --- | --- | --- |
| 消息头像 | `40 × 40` | 业界规范 |
| 头像圆角 | `8px` | 微信式方形 |
| 头像 ↔ 气泡 gap | `8px` | |
| 组内 col 让位 | `48px`（= 40 + 8） | 与组首气泡边沿对齐 |
| 行 padding | `6px 16px`（`--app-space-4`） | |
| 气泡 `min-height` | `40px` | 纯 UI，与高度计算无关 |
| 气泡 padding | `6px 10px` | 右下时间戳由影子占位动态让出 |
| 气泡字号 | `14.2px / 1.4` | |
| 气泡 `max-width`（移动） | `calc(100% - 104px)` | 两侧让 48×2 + 8 |
| 气泡 `max-width`（桌面） | `min(72%, 520px)` | |
| 尾尖 | `7px` 三角 | 非对称 border-width |
| self 尾尖 `top` | `13px` | 下移到头像垂直中线 |
| header 头像 | `32px` | header 更密集 |

## 10. 分组规则

复用 [`web/src/app/lib/chat-box/group-logic.ts`](../web/src/app/lib/chat-box/group-logic.ts) 的 `classifyGroupFlags`（已带单测）：

- **同发送者 + 5 分钟窗口**内连续消息归为一组。
- `isShowHead`：换发送者 / 超过 5 分钟 / 日期分隔后 → 新组首（显头像 + 名字）。
- `isDateShrink`：与上一条同组 → 合并（不单独显时间、不显头像）。
- 组位派生：`isShowHead → head`；组内末条（下一条不同组）`→ tail`；组中 `→ mid`。

## 11. 桌面端差异

消息列表为响应式，移动端为主。桌面端（宽屏 + 精确指针）差异：

- 气泡 `max-width` 用 `min(72%, 520px)`（移动端用 `calc(100% - 104px)`）。
- 控制面板为常驻侧栏（移动端为可拖动 FAB + 抽屉）——此为 playground 控件差异，与消息列表视觉规范无关。

## 12. 明确不做的事

- **已读回执**：不做。未来若做，走「主动发一条显式带回执的消息」方案，而非隐式每条都带。
- **self 名字 / self 头像省略**：不省——双方组首都显头像（对称），仅 self 不署名。
- **气泡描边 / 渐变**：当前为纯色填充 + 阴影。若将来上渐变或描边，尾尖方案需从 border 三角改为 `clip-path`（尾尖从气泡填充切出，天然继承渐变）。

## 13. 参考实现

- 验证用 playground（手写 DOM，`pg-` 前缀，phase-4 后随真实组件废弃）：
  - [`web/src/app/pages/chatbox-playground/chatbox-playground.component.ts`](../web/src/app/pages/chatbox-playground/chatbox-playground.component.ts)（`createItemEl` 渲染消息行）
  - [`...chatbox-playground.component.scss`](../web/src/app/pages/chatbox-playground/chatbox-playground.component.scss)（全部视觉规则）
  - [`...chatbox-playground.component.html`](../web/src/app/pages/chatbox-playground/chatbox-playground.component.html)
- 分组逻辑：[`group-logic.ts`](../web/src/app/lib/chat-box/group-logic.ts)
- 设计 token：[`_tokens.scss`](../web/src/app/assets/_tokens.scss)

## 14. 滚动架构（相对滚动）

消息列表虚拟滚动采用**相对滚动 + sentinel**，非「绝对定位 + 全局前缀和」。内核实现：[`chat-box-scroller.ts`](../web/src/app/lib/chat-box/chat-box-scroller.ts)。决策背景见[决策记录](#决策记录)。

### 为什么不是绝对定位

绝对定位架构（全局 `tops[]` 前缀和 + `scrollToIndex` 任意跳转 + 精确总高）为「可拖动进度条 / 跳到第 N 条」这类需求设计。1v1 聊天**用不到**：

- 流式追加（新消息贴底）、向上拉历史（prepend）、收消息跟随、偶尔引用跳转（在已加载范围内）——没有一种需要未挂载 item 的精确位置。
- 滚动条**全平台隐藏**（[§2](#2-消息行结构) `.pg-viewport` `scrollbar-width:none`），用户靠滚轮/手势，不靠拖动滚动条。

故砍掉全局坐标，**只管已挂载区域**。

### 架构

- **不维护全局 `tops[]`/`heights[]`**：content 用普通文档流（item block 堆叠），原生滚动直接滚文档流（合成器线程 120Hz + 移动 fling）。
- **双向回收**（视口上下各保留 buffer，默认 1500px）：
  - 上方挂载不足（向上滚看更早）→ 挂载更早 item 到顶部 + `scrollTop += 其高`（锚点补偿）。
  - 上方余量过多 → 卸载顶部远端 + `scrollTop -= 其高`（锚点补偿，视觉不跳）。
  - 下方挂载不足 → 挂载后续 item（DOM append）。
  - 下方余量过多 → 卸载底部远端（不动 scrollTop，底部不影响上方锚点）。
- **顶部 sentinel + IntersectionObserver**：滚到当前挂载顶触发 `onLoadMore` 向上加载历史。
- **贴底**：`scrollTop = scrollHeight - clientHeight`（原生 API，不需要总高度）。

### 元素接口化（VsElement）

每个挂载元素实现 [`VsElement`](../web/src/app/lib/chat-box/chat-box-scroller.ts) 接口，内核只通过它与元素交互，**框架无关**（ng 组件 / 手写 DOM 各自实现）：

| 方法 | 用途 |
| --- | --- |
| `estimateHeight()` | 挂载瞬间 / 实测前的占位（prepend 预补偿、首帧稳定、balance 初值） |
| `onHeightChange(cb)` | 订阅真实高度变动，返回取消订阅；元素内用 ResizeObserver / 图片 load 等。内核收到后「视口上方则锚点补偿」 |
| `destroy()` | 卸载时清理（断 observer / 销毁 ng view） |

> 两个高度方法**都只在已挂载元素上调**——估算不碰「未挂载 item」（那是绝对定位架构的需求，本架构已废弃）。phase-4 切真实 ng 组件时，仅替换 `createItem` hook 返回的 `VsElement` 实现（组件 ref + 组件 `heightChange` output），**内核一行不改**。

### 代价

- 不支持 `scrollToIndex` 跳到未挂载的任意位置（聊天用不到）。
- 滚动条全平台隐藏，故不显示「总量进度」（符合聊天场景）。

## 决策记录

> 记录反复横跳后定下的关键选择，避免后续按「标准 WhatsApp」重做而违背既定偏好。

- **风格**：iMessage → **WhatsApp**（弃 iMessage / Telegram）。
- **头像显隐**：自己不显 → **双方组首都显（对称）**。
- **头像形状**：圆形 → **微信式方形 8px**。
- **头像尺寸**：32px → **40px（业界规范）**。
- **名字**：双方都显 → **仅他方显、self 隐藏**（业界规范；保留他方以兼容群聊）。
- **尾尖**：从「看不见（四边等宽 border 藏进同色气泡）」修复为**非对称 border-width**；隐藏 self 名字后补**self 尾尖下移到头像中线**。
- **时间戳格式**：先定「气泡按距现在显 `HH:mm` / `MM-DD HH:mm` / `YYYY-MM-DD HH:mm`」→ 嫌跨年串太长，改 **WhatsApp 法：气泡恒 `HH:mm`，日期/年份全放日期分隔行**（`今天`/`昨天`/`周X`/`M月D日`/`YYYY年M月D日` 分级）。
- **已读回执**：不做。
- **min-height**：纯 UI 参数（40px），与虚拟滚动 fetch / 高度计算解耦。
- **滚动架构**：绝对定位 + 全局前缀和 → **相对滚动 + sentinel**（砍 `tops[]`/`heights[]`，元素接口化 `VsElement`，强制 `estimateHeight` + `onHeightChange` 两接口）。理由：聊天流式追加、贴底为主、滚动条全平台隐藏、不跳任意 index → 无需未挂载 item 的精确位置，只管已挂载区域。
