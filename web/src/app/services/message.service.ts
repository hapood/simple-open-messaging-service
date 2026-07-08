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

  /** Upload a video (multipart: file). The server validates only the container family via magic bytes
   *  (no probe/extract); w/h/duration are NOT sent here — they are client-probed via <video>
   *  loadedmetadata and ride in the VIDEO message content. Returns {url,name,size,mimeType}. */
  uploadVideo(file: File) {
    const fd = new FormData()
    fd.append('file', file)
    return this.http.post<StandardResponse<{ url: string, name: string, size: number, mimeType: string }>>(
      `${apiPrefix}/upload/video`,
      fd,
    )
  }

  /** Upload an audio clip (multipart: file). Same contract as uploadVideo (magic-byte check only);
   *  duration is client-probed and carried in the AUDIO message content. */
  uploadAudio(file: File) {
    const fd = new FormData()
    fd.append('file', file)
    return this.http.post<StandardResponse<{ url: string, name: string, size: number, mimeType: string }>>(
      `${apiPrefix}/upload/audio`,
      fd,
    )
  }

  queryMessageLog(params: QueryMessageLogParams) {
    return this.http.post<StandardResponse<Message[]>>(`${apiPrefix}/query-messages`, params)
  }

  /** Resolve the P2P relationship (status + threadId) with a peer user. */
  getThreadByUserId(params: { userId: number }) {
    return this.http.post<StandardResponse<Friendship>>(`${apiPrefix}/thread/by-user-id`, params)
  }

  /** Mute / unmute a conversation (suppresses notifications, not delivery). */
  setMuted(params: { threadId: number, muted: boolean }) {
    return this.http.post<StandardResponse>(`${apiPrefix}/thread/set-muted`, params)
  }

  /** Pin / unpin a conversation (pinned-first ordering). */
  setPinned(params: { threadId: number, pinned: boolean }) {
    return this.http.post<StandardResponse>(`${apiPrefix}/thread/set-pinned`, params)
  }

  /** Per-user "clear chat history" — hides all messages up to now for the caller; peer copy untouched. */
  clearHistory(params: { threadId: number }) {
    return this.http.post<StandardResponse>(`${apiPrefix}/thread/clear-history`, params)
  }

  /** Set a per-user alias/remark (备注) for a conversation — overrides the displayed name for the caller.
   *  An empty string clears it. */
  setAlias(params: { threadId: number, alias?: string }) {
    return this.http.post<StandardResponse>(`${apiPrefix}/thread/set-alias`, params)
  }

  /**
   * Substring search over a conversation's text history. Returns lightweight {id, createdAt} matches
   * (no bodies) keyset-paginated by id desc — the client jumps the kernel to each id and renders the
   * bubble via the normal query path on demand. `lastId` is the BigInt→string cursor for the next page.
   */
  searchMessages(params: { threadId: number, keyword: string, take: number, lastId?: string }) {
    return this.http.post<StandardResponse<{ id: string, createdAt: number }[]>>(
      `${apiPrefix}/search-messages`,
      params,
    )
  }
}