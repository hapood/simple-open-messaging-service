export interface User { id: number; uniqName: string; password: string }
export interface ChatThread { id: number, threadItem: ThreadItem }
export interface ThreadItem { id: number, info: { userId1: number, userId2: number } }
export interface Message { id: number, content: Text, creator: number, createdAt: string }
export interface Friend { id: number, friendUser: User }