import { listUsers } from '@/api/users'
import { listFederationPeers } from '@/api/federation'
import type { FederatedPeer, User } from '@/types/api'

export interface GlobalSearchResult {
  users: User[]
  peers: FederatedPeer[]
}

/** Combined jump-target search for the ⌘K palette: up to 5 users (by account) + 5 federation peers
 *  (by domain). Reuses the existing list endpoints with a tiny `take` so no new backend route is
 *  needed. Empty when `q` is blank (the hook gates the call). */
export async function globalSearch(q: string): Promise<GlobalSearchResult> {
  const [users, peers] = await Promise.all([
    listUsers({ search: q, take: 5 }),
    listFederationPeers({ search: q, take: 5 }),
  ])
  return { users: users.list, peers: peers.list }
}
