import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { User, MsgThread, Message, Friend, QueryMessageLogParams } from './Interfaces'

@Injectable({
  providedIn: 'root'
})
export class MsgService {
  prefix = 'http://127.0.0.1:3000'
  constructor(private http: HttpClient) { }

  getUserList() {
    return this.http.get<User[]>(`${this.prefix}/get-user-list`)
  }

  getThreadList() {
    return this.http.post<MsgThread[]>(`${this.prefix}/get-thread-list`, {})
  }

  getThreadInfo(params: { threadId: number }) {
    return this.http.post<MsgThread>(`${this.prefix}/query-thread-info`, params)
  }

  addUser(params: { uniqName: string, password: string }) {
    return this.http.post(`${this.prefix}/add-user`, params)
  }

  addFriend(uniqName: string) {
    return this.http.post(`${this.prefix}/add-friend`, { uniqName })
  }

  getMyProfile() {
    return this.http.get<User>(`${this.prefix}/my-profile`)
  }

  sendMessage(params: { threadId: number, content: string }) {
    return this.http.post<{ id: string, createAt: string }>(`${this.prefix}/send-message`, params)
  }

  queryMessageLog(params: QueryMessageLogParams) {
    return this.http.post<Message[]>(`${this.prefix}/query-messages`, params)
  }

  queryFriendInfo(params: { userId: number }) {
    return this.http.post<Friend>(`${this.prefix}/query-friend-info`, params)
  }
}