import { Message } from "../../../../common/services/Interfaces"

export interface UserProfile {
  id: number,
  uniqName: string,
  isSelf: boolean
}

export interface displayMsg extends Message {
  creatorName: string,
  isSelf: boolean
}