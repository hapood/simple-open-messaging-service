import { computed, type Signal } from '@angular/core';
import { ConversationListService } from './conversation-list.service';
import { conversationAvatarProfile, type AvatarProfileRef } from './avatar-profile-ref';
import { displayThreadName } from './model';
import { conversationAvatarSrc } from '../components/user-avatar/conversation-avatar.util';


/** The peer presentation inputs every call surface shares. */
export interface CallPeerPresentationState {
  /** The call's P2P thread id (0 / absent while a caller-side `starting` snapshot precedes the response). */
  threadId: number;
  /** Transport-provided name (the SSE `callerName`); a fallback only, never authoritative. */
  peerName: string;
  peerAvatar: string;
}

/**
 * Shared peer presentation for every call surface (call screen, banner). The owner-scoped
 * conversation thread record is the identity authority: its display name (alias → profile name
 * → account, via `displayThreadName`) and its avatar resolution. The transport-provided
 * name/avatar in the call state are fallbacks for the rare case the thread record is not
 * loaded yet; renderers add only their own terminal fallbacks ('…', the generic call label,
 * or the OS-required app name).
 */
export function callPeerPresentation(
  conversations: ConversationListService,
  callState: Signal<CallPeerPresentationState>,
) {
  const peerThread = computed(() => {
    const threadId = callState().threadId;
    return threadId === 0
      ? undefined
      : conversations
          .items()
          .find((item) => item.type === 'P2P' && item.threadId === threadId);
  });
  const peer = computed(() => {
    const thread = peerThread();
    return thread?.type === 'P2P' ? thread.peerUser : undefined;
  });
  const name = computed(() => {
    const thread = peerThread();
    // The thread record is the identity authority; the transport-provided name is deliberately
    // ignored (a federated server cannot be trusted to spell the peer's display name). A missing
    // thread record falls through to the renderer's terminal fallback.
    return thread ? displayThreadName(thread) : '';
  });
  const avatarSrc = computed(() => {
    const thread = peerThread();
    return thread ? conversationAvatarSrc(thread) : undefined;
  });
  const profile = computed(() => {
    const thread = peerThread();
    return thread ? conversationAvatarProfile(thread) : undefined;
  });
  return { peerThread, peer, name, avatarSrc, profile };
}
