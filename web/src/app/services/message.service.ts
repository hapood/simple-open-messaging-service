import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { User, MsgThread, Message, Friend, QueryMessageLogParams } from './Interfaces'
import { apiPrefix } from './constants';

@Injectable({
  providedIn: 'root'
})
export class MsgService {
  constructor(private http: HttpClient) { }

  getUserList() {
    return this.http.get<User[]>(`${apiPrefix}/get-user-list`)
  }

  getThreadList() {
    return this.http.post<MsgThread[]>(`${apiPrefix}/get-thread-list`, {})
  }

  getThreadInfo(params: { threadId: number }) {
    return this.http.post<MsgThread>(`${apiPrefix}/query-thread-info`, params)
  }

  addUser(params: { uniqName: string, password: string }) {
    return this.http.post(`${apiPrefix}/add-user`, params)
  }

  addFriend(uniqName: string) {
    return this.http.post(`${apiPrefix}/add-friend`, { uniqName })
  }

  getMyProfile() {
    return this.http.get<User>(`${apiPrefix}/my-profile`)
  }

  sendMessage(params: { threadId: number, content: string }) {
    return this.http.post<{ id: string, createAt: string }>(`${apiPrefix}/send-message`, params)
  }

  queryMessageLog(params: QueryMessageLogParams) {
    return this.http.post<Message[]>(`${apiPrefix}/query-messages`, params)
  }

  queryFriendInfo(params: { userId: number }) {
    return this.http.post<Friend>(`${apiPrefix}/query-friend-info`, params)
  }
}