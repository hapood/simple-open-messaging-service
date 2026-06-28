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
// userItem/groupItem 在生成 DTO 里是 optional（P2P/GROUP 互斥），但前端 template
// 直接访问 .userItem.uniqName / .groupItem.name（按 toObjType 分支保证存在）。
// override 成 required 保持手写语义，避免改各 template（与 desktop 重构冲突）。
export type UserMessageThread = Omit<
  S['UserMessageThreadResponseDto'],
  'userItem' | 'groupItem'
> & {
  userItem: S['UserResponseDto']
  groupItem: S['GroupResponseDto']
}
export type QueryMessageLogParams = S['QueryMessagesDto']
export type QueryUserThreadParams = S['QueryValidThreadDto']
export type MessageThreadType = S['UserMessageThreadResponseDto']['toObjType']

// 信封泛型（生成类型的 ApiResult.data 是 unknown，不可替代）
export interface StandardResponse<T = unknown> {
  code: number
  message: string
  data?: T
  /** 仅分页接口（query-messages）返回：是否还有更早一页。 */
  hasMore?: boolean
}
