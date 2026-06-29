import { Component, computed, input } from '@angular/core';
import type { ChatMsgData } from '../chat-item';
import { DateRowComponent } from '../date-row/date-row.component';
import { UserAvatarComponent, UserAvatarType } from '../../user-avatar/user-avatar.component';
import { layoutAlbum } from './layout';

/**
 * 图片相册消息行。
 *
 * 核心：cell 用 div 固定 px 高 + background-image（不创建 <img>），高度完全由
 * layoutAlbum 在渲染前算定 → 图加载/解码绝不改变 cell 高度 → 虚拟滚动锚点稳定。
 * cell 用 absolute + layoutAlbum 的 {xPct, yPx, wPct, hPx} inline 定位。
 *
 * dateLabel：createItem 工厂按跨日判定传入；非空时模板顶部渲染 date pill。
 */
@Component({
  selector: 'app-msg-media-row',
  standalone: true,
  imports: [DateRowComponent, UserAvatarComponent],
  templateUrl: './media-row.component.html',
  styleUrl: './media-row.component.scss',
})
export class MediaRowComponent {
  readonly UserAvatarType = UserAvatarType
  readonly data = input.required<ChatMsgData>();
  readonly isShowHead = input(false);
  readonly isGroupStart = input(false);
  /** 跨日 date 分隔文案（非空=本条是某天首条、上方显 date pill）；null=不显。 */
  readonly dateLabel = input<string | null>(null);

  readonly side = computed(() => (this.data().isSelf ? 'self' : 'other'));
  readonly showAvatar = computed(() => this.isShowHead());
  readonly pos = computed(() => (this.isShowHead() ? 'head' : 'body'));
  readonly showName = computed(() => this.isShowHead() && !this.data().isSelf);

  private readonly layout = computed(() => layoutAlbum(this.data().images ?? []));
  readonly totalH = computed(() => this.layout().totalH);
  readonly moreCount = computed(() => this.layout().moreCount);
  /** cell 渲染数据：rect（定位）+ src（背景图）。>6 张时末格带 moreCount 角标。 */
  readonly cells = computed(() => {
    const imgs = this.data().images ?? [];
    const moreIdx = this.layout().moreCount > 0 ? this.layout().rects.length - 1 : -1;
    return this.layout().rects.map((rect, i) => ({
      rect,
      src: imgs[i]?.src ?? '',
      isMore: i === moreIdx,
    }));
  });
}
