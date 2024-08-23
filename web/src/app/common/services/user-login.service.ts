import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';

@Injectable({
  providedIn: 'root'
})
export class UserLoginService {
  prefix = 'http://10.176.80.28:3000'
  constructor(private http: HttpClient) {
  }

  login(params: { username: string, password: string }) {
    return this.http.post<{ access_token: string }>(`${this.prefix}/auth/login`, params)
  }
}
