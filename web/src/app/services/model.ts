export interface User {
  id: number; uniqName: string; password: string,
  userExtra: { name: string, avatar: string }
}
export interface MsgThread {
  id: number, userId: number, toObjType: number, toObjId: number,
  threadItem: ThreadItem, updatedAt: number
}
export interface ThreadItem { id: number, info: { userId1: number, userId2: number } }
export interface Message { id: string, content: string, creator: number, createdAt: number }
export interface Friend { id: number, friendUser: User }
export interface QueryMessageLogParams {
  threadId: number, take: number, skip: number,
  orderBy: 'asc' | 'desc', lastId?: string | undefined
}
export interface QueryUserThreadParams {
  take: number, skip: number, lastId?: string | undefined
}
export interface StandardResponse<T = any> {
  status: number, message: string, data?: T
}
export interface UserMessageThread {
  id: number,
  userId: number,
  toObjType: number,
  toObjId: number,
  threadItem?: ThreadItem,
  status: number
}