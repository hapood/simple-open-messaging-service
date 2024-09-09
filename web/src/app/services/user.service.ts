import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { apiPrefix } from './constants';

@Injectable({
  providedIn: 'root',
})
export class UserService {
  constructor(private http: HttpClient) {
  }
  register(params: { uniqName: string, password: string }) {
    return this.http.post<{ status: number, message: string, data?: { id: number, uniqName: string } }>(`${apiPrefix}/user/register`,
      params, { 'headers': { Authorization: 'public' } })
  }
}
