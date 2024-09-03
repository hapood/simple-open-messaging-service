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
  height: number,
  sIndex: number, //can not outof range
  eIndex: number //indicate msg's index in messageList and +1, maybe out of range
}

export enum MsgGroupStatus {
  GENERATING, RENDERING, PREPARED, STABLE, REMOVING
}

export interface DisplayMsg {
  id: string,
  creatorName: string,
  isSelf: boolean
  lines: string[],
  createdAt: string,
  isDateShrink: boolean,
  isShowHead: boolean
}