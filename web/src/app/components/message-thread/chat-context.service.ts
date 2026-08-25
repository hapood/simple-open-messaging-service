import { computed, Injectable, signal } from '@angular/core';
import type { ConversationItem } from '../../services/model';

type GroupRole = 'OWNER' | 'ADMIN' | 'MEMBER';

/** Current chatbox state, initialized by ChatPane when the open conversation changes. */
@Injectable({ providedIn: 'root' })
export class ChatContextService {
  private readonly _groupRole = signal<GroupRole | null>(null);

  readonly groupRole = this._groupRole.asReadonly();
  readonly canAdministerGroup = computed(() => {
    const role = this._groupRole();
    return role === 'OWNER' || role === 'ADMIN';
  });

  initialize(conversation: ConversationItem): void {
    this._groupRole.set(
      conversation.type === 'GROUP' ? conversation.role : null,
    );
  }

  clear(): void {
    this._groupRole.set(null);
  }
}
