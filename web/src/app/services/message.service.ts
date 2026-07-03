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

  sendMessage(params: { threadId: number, content: string, contentType?: string, clientMessageId?: string }) {
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

  /**
   * 上传通用文件（multipart：file），返回服务端生成的 {url,name,size,mimeType}，原样作为 FILE 消息内容。
   * observe:'events' + reportProgress 让调用方能渲染上传进度（HttpProgressEvent）；final 响应体在最后一个
   * HttpResponse 事件里。POST /upload/file 的 mimetype 白名单与体积上限由后端 enforce。
   */
  uploadFile(file: File) {
    const fd = new FormData()
    fd.append('file', file)
    return this.http.post<StandardResponse<{ url: string, name: string, size: number, mimeType: string }>>(
      `${apiPrefix}/upload/file`,
      fd,
      { reportProgress: true, observe: 'events' },
    )
  }

  queryMessageLog(params: QueryMessageLogParams) {
    return this.http.post<StandardResponse<Message[]>>(`${apiPrefix}/query-messages`, params)
  }

  /** Resolve the P2P relationship (status + threadId) with a peer user. */
  getThreadByUserId(params: { userId: number }) {
    return this.http.post<StandardResponse<Friendship>>(`${apiPrefix}/thread/by-user-id`, params)
  }
}