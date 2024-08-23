export enum SendingMessageStatus {
  SENDING, SENT, FAILED
}
export interface SendingMessage {
  id: number, content: string
}
export interface SentMessage {
  id: number, content: string, dbId: string
}