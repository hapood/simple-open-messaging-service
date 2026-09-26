import type { ConversationItem, ThreadListRecord } from './model';

/** An attention/list write must not replace a newer committed profile selection. */
export function preserveThreadProfile(
  incoming: ConversationItem,
  current: ThreadListRecord | undefined,
): ConversationItem {
  if (!current || current.type !== incoming.type)
    return incoming;
  const oldSubject = current.type === 'P2P' ? current.peerUser : current.group;
  const subject = incoming.type === 'P2P' ? incoming.peerUser : incoming.group;
  if (
    oldSubject.account !== subject.account ||
    oldSubject.domain !== subject.domain ||
    oldSubject.namespaceId !== subject.namespaceId ||
    current.profileRev <= incoming.profileRev
  )
    return incoming;
  return {
    ...incoming,
    profileRev: current.profileRev,
    ...(current.type === 'P2P'
      ? {
          peerUser: {
            ...incoming.peerUser,
            name: current.peerUser.name,
            avatar: current.peerUser.avatar,
            bio: current.peerUser.bio,
          },
        }
      : {
          group: {
            ...incoming.group,
            name: current.group.name,
            avatar: current.group.avatar,
            description: current.group.description,
          },
        }),
  } as ConversationItem;
}
