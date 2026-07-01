import { Component, computed, input, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import dayjs from 'dayjs';
import { GroupService } from '../../../services/group.service';
import type { ChatMsgData } from '../chat-item';
import { DateRowComponent } from '../date-row/date-row.component';
import { UserAvatarComponent, UserAvatarType } from '../../user-avatar/user-avatar.component';

/**
 * 邀请消息行（WhatsApp 行外壳 + 内嵌邀请卡片 + Join 按钮）。
 *
 * data.text 是 JSON 原文（{groupName, token, expiryDate}），ngOnInit 解析。
 * 保留 MatButtonModule + GroupService（joinGroup 需组件级 DI，createComponent 传 envInjector 正常注入）。
 *
 * 修复旧 invite-card bug：原 dayjs().isAfter() 漏参数（恒比较 现在>现在），应为 isAfter(过期时间)。
 *
 * dateLabel：createItem 工厂按跨日判定传入；非空时模板顶部渲染 date pill。
 */
@Component({
  selector: 'app-msg-invite-row',
  standalone: true,
  imports: [MatButtonModule, DateRowComponent, UserAvatarComponent],
  templateUrl: './invite-row.component.html',
  styleUrl: './invite-row.component.scss',
})
export class InviteRowComponent {
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
  /** Render a status tick only for self-sent messages with a delivery status. Invites are always "other" -> always false,
   *  but the member is required so this component stays structurally aligned with TextRow/MediaRow (createMsgCbElement
   *  picks the component by contentType and relies on the shared shape). */
  readonly statusTick = computed(() => this.data().isSelf && !!this.data().status);
  /** Dim while in flight (never true for invites). */
  readonly isSending = computed(() => this.data().isSelf && this.data().status === 'sending');

  readonly invite = signal<{ groupName: string; token: string; expiryDate?: string }>({
    groupName: '',
    token: '',
  });
  readonly expiryLabel = signal('');
  /** 0=有效可加入；1=已过期。 */
  readonly status = signal(0);

  constructor(private groupService: GroupService) {}

  ngOnInit() {
    const parsed = this.parseInvite(this.data().text);
    this.invite.set(parsed);
    this.expiryLabel.set(
      parsed.expiryDate ? dayjs(parsed.expiryDate).format('YYYY-MM-DD HH:mm') : '',
    );
    // 判过期：now 晚于 expiryDate → status=1（修复旧 isAfter() 漏参数 bug）。
    this.status.set(
      parsed.expiryDate && dayjs().isAfter(dayjs(parsed.expiryDate)) ? 1 : 0,
    );
  }

  private parseInvite(content: string): {
    groupName: string;
    token: string;
    expiryDate?: string;
  } {
    try {
      const obj = JSON.parse(content);
      return {
        groupName: obj.groupName ?? '',
        token: obj.token ?? '',
        expiryDate: obj.expiryDate,
      };
    } catch {
      return { groupName: '', token: '' };
    }
  }

  joinGroup() {
    this.groupService.joinGroup({ token: this.invite().token }).subscribe((res) => {
      if (res.code === 0) {
        alert('joinGroup ok');
      }
    });
  }
}
