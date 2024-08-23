import { Message } from "../../../common/services/Interfaces"
export enum SendingMessageStatus {
  SENDING, SENT, FAILED
}
export interface SendingMessage {
  id: number, content: string
}
export interface SentMessage {
  id: number, content: string, dbId: string
}
export interface MsgGroup {
  id: string,
  list: Message[],
  startIndex: number,
  endIndex: number
}