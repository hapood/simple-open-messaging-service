import type { components } from './api-types'

/**
 * API 类型由 openapi-typescript 从后端 /api/v1/docs-json 生成（api-types.ts），
 * 本文件以别名 re-export，保持各 service/component 的 `from './model'` 引用不变。
 * 改后端 DTO 后跑 `npm run gen:api` 重新生成。
 *
 * StandardResponse<T> 保留手写：OpenAPI 的 ApiResult.data 是 unknown（泛型擦除），
 * 不能替代前端的泛型信封（http.post<StandardResponse<Message[]>>）。
 */
type S = components['schemas']

export type User = S['UserResponseDto']
export type Message = S['MessageResponseDto']
export type Group = S['GroupResponseDto']

// peerUser/group are optional on the generated DTO (mutually exclusive by type), but templates branch on
// `type` first so the accessed one is always present — override to required to keep template accessors simple.
export type ConversationItem = Omit<
  S['ConversationItemDto'],
  'peerUser' | 'group'
> & {
  peerUser: S['UserResponseDto']
  group: S['GroupResponseDto']
}

/** A P2P relationship row (thread/by-user-id returns this). */
export type Friendship = S['FriendshipDto']
/** A pending-list row — the backend additionally attaches the peer's userId for client profile lookup. */
export type FriendshipWithPeer = S['FriendshipDto'] & { peerUserId: number }

export type QueryMessageLogParams = S['QueryMessagesDto']
export type QueryUserThreadParams = S['QueryValidThreadDto']
export type MessageThreadType = S['ConversationItemDto']['type']
export type FriendshipStatus = S['FriendshipDto']['status']

// 信封泛型（生成类型的 ApiResult.data 是 unknown，不可替代）
export interface StandardResponse<T = unknown> {
  code: number
  message: string
  data?: T
  /** 仅分页接口（query-messages）返回：是否还有更早一页。 */
  hasMore?: boolean
}
