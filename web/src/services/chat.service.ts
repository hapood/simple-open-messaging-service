import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { User, ChatThread, Message, Friend } from './Interfaces'

@Injectable({
  providedIn: 'root'
})
export class ChatService {
  prefix = 'http://127.0.0.1:3000'
  constructor(private http: HttpClient) { }

  getUserList() {
    return this.http.get<User[]>(`${this.prefix}/get-user-list`)
  }

  getChatThreadList() {
    return this.http.post<ChatThread[]>(`${this.prefix}/get-chat-thread-list`, {})
  }

  getChatThreadInfo(params: { threadId: number }) {
    return this.http.post<ChatThread>(`${this.prefix}/query-chat-thread-info`, params)
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
    return this.http.post(`${this.prefix}/send-message`, params)
  }

  queryMessageLog(params: { threadId: number, take: number, skip: number, lastId?: number }) {
    return this.http.post<Message[]>(`${this.prefix}/query-reversed-message`, params)
  }

  queryFriendInfo(params: { userId: number }) {
    return this.http.post<Friend>(`${this.prefix}/query-friend-info`, params)
  }
}