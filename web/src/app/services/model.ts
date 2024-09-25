export interface User {
  id: number; uniqName: string; password: string,
  userExtra: { name: string, avatar: string }
}
export interface ThreadItem { id: number }
export interface Message { id: string, content: string, contentType: string, creator: number, createdAt: number }
export interface Friend { id: number, friendUser: User }
export interface Group { name: string, id: number }

type MessageThreadType = "P2P" | "GROUP"
export interface QueryMessageLogParams {
  userThreadId: number, take: number, skip: number,
  orderBy: 'asc' | 'desc', lastId?: string | undefined
}
export interface QueryUserThreadParams {
  take: number, skip: number, lastId?: string | undefined, toObjType?: MessageThreadType
}
export interface StandardResponse<T = any> {
  status: number, message: string, data?: T
}
export interface UserMessageThread {
  id: number,
  userId: number,
  toObjType: MessageThreadType,
  toObjId: number,
  threadId: number,
  threadItem?: ThreadItem,
  status: number,
  createdAt: number,
  updatedAt: number,
  userItem: User,
  groupItem: Group
}