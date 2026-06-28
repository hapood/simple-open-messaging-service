import { createComponent, EnvironmentInjector } from '@angular/core';
import type { VsElement, VsItem } from '../../lib/virtual-scroll/virtual-scroller';
import type { ChatDateData, ChatItemData, ChatMsgData } from './chat-item';
import { layoutAlbum } from './media-row/layout';
import { DateRowComponent } from './date-row/date-row.component';
import { InviteRowComponent } from './invite-row/invite-row.component';
import { MediaRowComponent } from './media-row/media-row.component';
import { TextRowComponent } from './text-row/text-row.component';

// 生产 AOT 置 ngDevMode=falsy 并据此死代码消除（与虚拟滚动内核同模式）。
// 守卫下方「高度计算过程」console——生产构建完全不输出、零开销；仅 dev 可见。
declare const ngDevMode: boolean | null | undefined;

/**
 * 把一个 ChatItemData 包装成 VsElement：按类型选组件、createComponent 动态创建、
 * setInput 注入 data + 分组标、detectChanges 手动首渲（zoneless 无自动 CD）。
 *
 * thread 与 playground 共用本工厂——保证真实聊天与演示用同一套卡片 + 包装逻辑。
 *
 * 高度约定（vs-element-border-box 记忆）：estimateHeight 给初值，onHeightChange 用
 * ResizeObserver 读 el.offsetHeight（border-box，与内核 measurePending 同口径；不可用
 * RO 的 contentRect.height——content-box 会差 padding 高）。
 */
export function createMsgVsElement(
  item: VsItem<ChatItemData>,
  isShowHead: boolean,
  isGroupStart: boolean,
  envInjector: EnvironmentInjector,
): VsElement<ChatItemData> {
  const data = item.data;

  if (data.type === 'date') {
    return createDateEl(data, envInjector);
  }

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
  ref.changeDetectorRef.detectChanges(); // zoneless：手动驱动首次渲染（触发 ngOnInit）

  return wrapEl(ref, estimateMsgHeight(data, isShowHead), data.msgId);
}

/** 日期分隔行组件化包装。 */
function createDateEl(
  data: ChatDateData,
  envInjector: EnvironmentInjector,
): VsElement<ChatItemData> {
  const ref = createComponent(DateRowComponent, { environmentInjector: envInjector });
  ref.setInput('data', data);
  ref.changeDetectorRef.detectChanges();
  return wrapEl(ref, 45, `date「${data.label}」`); // padding 14*2 + pill ~17
}

/**
 * 通用 VsElement 包装：ResizeObserver 实测 offsetHeight 上报；destroy 断开 RO + 销毁组件 ref。
 * 抽出来避免 text/media/invite/date 四处重复 RO + destroy 模板。
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

function estimateMsgHeight(data: ChatMsgData, isShowHead: boolean): number {
  const nameRow = isShowHead && !data.isSelf ? 17 : 0;
  if (data.contentType === 'IMAGE' && data.images) {
    const { totalH } = layoutAlbum(data.images);
    return Math.max(64, totalH + nameRow + 12);
  }
  // 纯文本/邀请：按文本粗估行数（~16 字/行）。实测会修正，估算只需近似。
  const lines = Math.max(1, Math.ceil(data.text.length / 16));
  return Math.max(64, 24 + nameRow + lines * 20);
}
