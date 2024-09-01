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
  id: string
  list: DisplayMsg[],
}

export enum MsgGroupStatus {
  GENERATING, RENDERING, PREPARED, STABLE, REMOVING
}

export interface DisplayMsg {
  id: string,
  creatorName: string,
  isSelf: boolean
  lines: string[],
  createdAt: string
}