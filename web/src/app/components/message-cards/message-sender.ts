import { computed, type Signal } from '@angular/core';
import type { ChatMsgData } from './chat-item';
import type { AvatarView } from '../user-avatar/avatar-view';
import { UserAvatarType } from '../user-avatar/model';

export type SenderDisplayContext = 'direct' | 'group' | 'forward';

/** Content/status/layout updates must not restart an unchanged sender's subscription or image lease. */
export function messageSenderKey(message: ChatMsgData): string {
  return JSON.stringify([
    message.sender ?? { kind: 'snapshot', name: message.name, imageUrl: null },
    message.isSelf,
    message.senderDisplayContext,
    message.threadId,
  ]);
}

/** Content-independent policy: grouping affects visibility, never the selected sender data. */
export function senderRowLayout(
  context: SenderDisplayContext,
  self: boolean,
  head: boolean,
) {
  return {
    side: self ? ('self' as const) : ('other' as const),
    showAvatar: head,
    showName: head && !self && context !== 'direct',
  };
}

export function messageSenderPresentation(
  data: Signal<ChatMsgData>,
  head: Signal<boolean>,
  resolved: Signal<AvatarView | undefined>,
) {
  const layout = computed(() =>
    senderRowLayout(
      data().senderDisplayContext ?? 'direct',
      data().isSelf,
      head(),
    ),
  );
  const avatar = computed<AvatarView>(
    () =>
      resolved() ?? {
        name: data().name,
        imageUrl: null,
        type: data().isSelf ? UserAvatarType.SELF : UserAvatarType.OTHER,
      },
  );
  return {
    side: computed(() => layout().side),
    showAvatar: computed(() => layout().showAvatar),
    showName: computed(() => layout().showName),
    name: computed(() => avatar().name),
    avatar,
  };
}
