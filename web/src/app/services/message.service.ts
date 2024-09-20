import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { MsgThread, Message, Friend, QueryMessageLogParams,StandardResponse,UserMessageThread } from './model'
import { apiPrefix } from './constants';

@Injectable({
  providedIn: 'root'
})
export class MsgService {
  constructor(private http: HttpClient) { }

  getThreadInfo(params: { threadId: number }) {
    return this.http.post<MsgThread>(`${apiPrefix}/query-thread-info`, params)
  }

  addUser(params: { uniqName: string, password: string }) {
    return this.http.post(`${apiPrefix}/add-user`, params)
  }

  addFriend(uniqName: string) {
    return this.http.post(`${apiPrefix}/add-friend`, { uniqName })
  }

  sendMessage(params: { threadId: number, content: string }) {
    return this.http.post<{ id: string, createAt: string }>(`${apiPrefix}/send-message`, params)
  }

  queryMessageLog(params: QueryMessageLogParams) {
    return this.http.post<Message[]>(`${apiPrefix}/query-messages`, params)
  }

  getThreadByUserId(params: { userId: number }) {
    return this.http.post<StandardResponse<UserMessageThread>>(`${apiPrefix}/thread/by-user-id`, params)
  }
}