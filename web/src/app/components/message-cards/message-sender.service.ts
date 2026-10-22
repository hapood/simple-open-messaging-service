import { Injectable, Injector, inject } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { combineLatest, map, type Observable } from 'rxjs';
import { ConversationListService } from '../../services/conversation-list.service';
import type { ConversationItem } from '../../services/model';
import { AvatarPresentationService } from '../user-avatar/avatar-presentation.service';
import type { AvatarView } from '../user-avatar/avatar-view';
import { UserAvatarType } from '../user-avatar/model';
import type { ChatMsgData } from './chat-item';

/** Select once per mounted row; name, head, tail and overlay all observe this presentation. */
@Injectable({ providedIn: 'root' })
export class MessageSenderService {
  private readonly avatars = inject(AvatarPresentationService);
  private readonly injector = inject(Injector);
  private conversations$?: Observable<ConversationItem[]>;

  resolve(message: ChatMsgData): Observable<AvatarView> {
    const source = message.sender ?? {
      kind: 'snapshot' as const,
      name: message.name,
      imageUrl: null,
    };
    const view$ = this.avatars.resolve(
      source.kind === 'forward'
        ? source
        : {
            ...source,
            type: message.isSelf ? UserAvatarType.SELF : UserAvatarType.OTHER,
          },
    );
    if (
      source.kind !== 'demand' ||
      message.isSelf ||
      message.senderDisplayContext !== 'direct' ||
      message.threadId === undefined ||
      source.profile.publisherNamespaceId !== 0
    )
      return view$;
    this.conversations$ ??= toObservable(
      this.injector.get(ConversationListService).items,
      { injector: this.injector },
    );
    return combineLatest([view$, this.conversations$]).pipe(
      map(([view, conversations]) => {
        const conversation = conversations.find(
          (item) => item.threadId === message.threadId,
        );
        const alias =
          conversation?.type === 'P2P' &&
          conversation.peerUser.account === source.profile.account &&
          conversation.peerUser.namespaceId ===
            source.profile.profileNamespaceId
            ? conversation.alias?.trim()
            : undefined;
        return alias ? { ...view, name: alias } : view;
      }),
    );
  }
}
