import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { apiPrefix } from './constants';
import { StandardMessage } from './websocket.service';

export interface GrpCreateInfo {
  threadId: number,
  groupId: number
}

@Injectable({
  providedIn: 'root'
})
export class GroupService {

  constructor(private http: HttpClient) {
  }

  createGroup(params: { groupName: string }) {
    return this.http.post<StandardMessage<GrpCreateInfo>>(`${apiPrefix}/group/create`, params)
  }

  inviteUser(params: { userId: number, groupId: number }) {
    return this.http.post<StandardMessage>(`${apiPrefix}/group/invite`, params)
  }

  joinGroup(params: { token: string }) {
    return this.http.post<StandardMessage>(`${apiPrefix}/group/join`, params)
  }
}
