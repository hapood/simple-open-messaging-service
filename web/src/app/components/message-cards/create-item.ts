import { createComponent, EnvironmentInjector } from '@angular/core';
import type { VsElement, VsItem } from '../../lib/virtual-scroll/virtual-scroller';
import type { ChatItemData, ChatMsgData } from './chat-item';
import { layoutAlbum } from './media-row/layout';
import { InviteRowComponent } from './invite-row/invite-row.component';
import { MediaRowComponent } from './media-row/media-row.component';
import { TextRowComponent } from './text-row/text-row.component';

// 生产 AOT 置 ngDevMode=falsy 并据此死代码消除（与虚拟滚动内核同模式）。
// 守卫下方「高度计算过程」console——生产构建完全不输出、零开销；仅 dev 可见。
declare const ngDevMode: boolean | null | undefined;

/**
 * 把一个 ChatMsgData 包装成 VsElement：按 contentType 选组件、createComponent 动态创建、
 * setInput 注入 data + 分组标 + dateLabel、detectChanges 手动首渲（zoneless 无自动 CD）。
 *
 * thread 与 playground 共用本工厂——保证真实聊天与演示用同一套卡片 + 包装逻辑。
 *
 * date 已从数据源移出：source 只返回 msg，date 分隔由 createItem 工厂按跨日判定算出 dateLabel
 * 传入，msg 组件模板顶部条件渲染 date pill（见 date-format.ts）。
 *
 * 高度约定（vs-element-border-box 记忆）：estimateHeight 给初值，onHeightChange 用
 * ResizeObserver 读 el.offsetHeight（border-box，与内核 measurePending 同口径；不可用
 * RO 的 contentRect.height——content-box 会差 padding 高）。
 */
export function createMsgVsElement(
  item: VsItem<ChatItemData>,
  isShowHead: boolean,
  isGroupStart: boolean,
  dateLabel: string | null,
  envInjector: EnvironmentInjector,
): VsElement<ChatItemData> {
  const data = item.data as ChatMsgData; // source 只返回 msg；date 已移到渲染层派生

  const comp =
    data.contentType === 'IMAGE'
      ? MediaRowComponent
      : data.contentType === 'INVITE'
        ? InviteRowComponent
        : TextRowComponent;

  const ref = createComponent(comp, { environmentInjector: envInjector });
  ref.setInput('data', data);
  ref.setInput('isShowHead', isShowHead);
  ref.setInput('isGroupStart', isGroupStart);
  ref.setInput('dateLabel', dateLabel);
  ref.changeDetectorRef.detectChanges(); // zoneless：手动驱动首次渲染（触发 ngOnInit）

  return wrapEl(ref, estimateMsgHeight(data, isShowHead, dateLabel), data.msgId);
}

/**
 * ghost 加载指示 VsElement：内核挂载窗口最顶条（oldest 槽位、未到全局最老）时，其组首/头像/date
 * 依赖尚未加载的更老邻居——不渲染真实组件，改用居中 spinner 占位（.vs-ghost-loading，WhatsApp 风，
 * 见 _vs.scss）。loadOlder 挂上更老邻居后内核 rebuildEntry 重建为真实组件（prev 变非 null → 调用方不再走此分支）。
 *
 * **固定高度**：消除「ghost 高度被内部真实内容撑变 / 图片异步加载改高度」的抖动——spinner 宿主高度恒定，
 * rebuildDelta（真实高 − GHOST_H）由内核 loadOlder 的 compensateAbove 一次性补偿 scrollTop（视口不跳）。
 * 不建 Angular 组件、不渲图片 / 排版——空 host + ::before 圆环（CSS 驱动），零渲染成本。
 */
export function createGhostVsElement(): VsElement<ChatItemData> {
  const GHOST_H = 48; // 固定 spinner 行高（紧凑，WhatsApp 风），不被内容撑变
  const el = document.createElement('div');
  el.className = 'vs-ghost-loading'; // 内核 updateGhost 仍会加 vs-ghost（视觉标记，无功能依赖）
  el.style.height = `${GHOST_H}px`;
  return {
    el,
    estimateHeight: () => GHOST_H,
    onHeightChange: () => () => {}, // 固定高度永不变（无 ResizeObserver）
    destroy: () => {},
  };
}

/**
 * 通用 VsElement 包装：ResizeObserver 实测 offsetHeight 上报；destroy 断开 RO + 销毁组件 ref。
 * 抽出来避免 text/media/invite 三处重复 RO + destroy 模板。
 *
 * dev（ngDevMode）下打印【高度计算过程】：创建时的估算、每次实测（含渲染后再次改动）。
 * 输出显著（彩色 + 标签 + delta）便于排查 estimate↔实测 偏差与异步高度变化（如图片加载）。
 */
function wrapEl<T>(ref: { location: { nativeElement: HTMLElement }; destroy: () => void }, estimate: number, tag: string): VsElement<T> {
  const el = ref.location.nativeElement;
  let ro: ResizeObserver | null = null;
  let live: ((h: number) => void) | null = null;
  let prev = estimate; // 上次上报高度（首次=估算），算每次变动 delta
  if (ngDevMode) console.log('%c[vs-create] ' + tag, 'color:#09f;font-weight:600', { 估算: estimate });
  return {
    el,
    estimateHeight: () => estimate,
    onHeightChange: (cb) => {
      live = cb;
      if (!ro) {
        ro = new ResizeObserver(() => {
          const h = el.offsetHeight; // border-box，与内核 measurePending 同口径
          if (h <= 0) return;
          // dev：仅当高度与上次（首次=估算）不一致时打印——即「预计算≠实测」或「渲染后再次改动」。
          // 整段（判断 + delta 计算 + prev 更新）都在 ngDevMode 守卫内 → 生产 AOT 全部死代码消除，
          // 只剩下方 live?.(h) 上报真实高度，零开销。prev 仅此处读写 → 生产连同移除。
          if (ngDevMode && h !== prev) {
            console.log('%c[vs-height] ' + tag, 'color:#e91e63;font-weight:700', { 实测: h, 估算: estimate, 上次: prev, 本次变动: h - prev, 偏离估算: h - estimate });
            prev = h;
          }
          live?.(h);
        });
        ro.observe(el);
      }
      return () => {
        live = null;
      };
    },
    destroy: () => {
      ro?.disconnect();
      ro = null;
      live = null;
      ref.destroy();
    },
  };
}

function estimateMsgHeight(data: ChatMsgData, isShowHead: boolean, dateLabel: string | null): number {
  const dateRow = dateLabel ? 45 : 0; // date pill：padding 14*2 + pill ~17（跨日时 msg 顶部多一行）
  const nameRow = isShowHead && !data.isSelf ? 17 : 0;
  if (data.contentType === 'IMAGE' && data.images) {
    const { totalH } = layoutAlbum(data.images);
    return Math.max(64, totalH + nameRow + 12) + dateRow;
  }
  // 纯文本/邀请：按文本粗估行数（~16 字/行）。实测会修正，估算只需近似。
  const lines = Math.max(1, Math.ceil(data.text.length / 16));
  return Math.max(64, 24 + nameRow + lines * 20) + dateRow;
}
