import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Message, QueryMessageLogParams, StandardResponse, Friendship } from './model'
import { apiPrefix } from './constants';

@Injectable({
  providedIn: 'root'
})
export class MsgService {
  constructor(private http: HttpClient) { }

  addUser(params: { uniqName: string, password: string }) {
    return this.http.post(`${apiPrefix}/add-user`, params)
  }

  addFriend(uniqName: string) {
    return this.http.post(`${apiPrefix}/add-friend`, { uniqName })
  }

  sendMessage(params: { threadId: number, content: string, contentType?: string }) {
    return this.http.post<StandardResponse<{ id: string, createAt: string }>>(`${apiPrefix}/send-message`, params)
  }

  /** 上传图片（multipart：file + 宽高），返回 {url,w,h}。wh 由前端 createImageBitmap 读后带上。 */
  uploadMedia(file: File, w: number, h: number) {
    const fd = new FormData()
    fd.append('file', file)
    fd.append('w', String(w))
    fd.append('h', String(h))
    return this.http.post<StandardResponse<{ url: string, w: number, h: number }>>(`${apiPrefix}/upload`, fd)
  }

  queryMessageLog(params: QueryMessageLogParams) {
    return this.http.post<StandardResponse<Message[]>>(`${apiPrefix}/query-messages`, params)
  }

  /** Resolve the P2P relationship (status + threadId) with a peer user. */
  getThreadByUserId(params: { userId: number }) {
    return this.http.post<StandardResponse<Friendship>>(`${apiPrefix}/thread/by-user-id`, params)
  }
}