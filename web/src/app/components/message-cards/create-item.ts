import { createComponent, EnvironmentInjector } from '@angular/core';
import type { VsElement, VsItem } from '../../lib/virtual-scroll/virtual-scroller';
import type { ChatDateData, ChatItemData, ChatMsgData } from './chat-item';
import { layoutAlbum } from './media-row/layout';
import { DateRowComponent } from './date-row/date-row.component';
import { InviteRowComponent } from './invite-row/invite-row.component';
import { MediaRowComponent } from './media-row/media-row.component';
import { TextRowComponent } from './text-row/text-row.component';

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

  return wrapEl(ref, estimateMsgHeight(data, isShowHead));
}

/** 日期分隔行组件化包装。 */
function createDateEl(
  data: ChatDateData,
  envInjector: EnvironmentInjector,
): VsElement<ChatItemData> {
  const ref = createComponent(DateRowComponent, { environmentInjector: envInjector });
  ref.setInput('data', data);
  ref.changeDetectorRef.detectChanges();
  return wrapEl(ref, 45); // padding 14*2 + pill ~17
}

/**
 * 通用 VsElement 包装：ResizeObserver 实测 offsetHeight 上报；destroy 断开 RO + 销毁组件 ref。
 * 抽出来避免 text/media/invite/date 四处重复 RO + destroy 模板。
 */
function wrapEl<T>(ref: { location: { nativeElement: HTMLElement }; destroy: () => void }, estimate: number): VsElement<T> {
  const el = ref.location.nativeElement;
  let ro: ResizeObserver | null = null;
  let live: ((h: number) => void) | null = null;
  return {
    el,
    estimateHeight: () => estimate,
    onHeightChange: (cb) => {
      live = cb;
      if (!ro) {
        ro = new ResizeObserver(() => {
          const h = el.offsetHeight; // border-box，与内核 measurePending 同口径
          if (h > 0) live?.(h);
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
