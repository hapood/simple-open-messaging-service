import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class AuthService {
  prefix = 'http://127.0.0.1:3000'
  constructor(private http: HttpClient) {
  }

  login(params: { username: string, password: string }) {
    return this.http.post<{ access_token: string }>(`${this.prefix}/auth/login`, params)
  }

  getToken() {
    return localStorage.getItem("token");
  }

  refreshToken(token: string): Observable<string> {
    throw new Error('error refresh token')
  }

  getRefreshToken(): string {
    return ''
  }

  saveToken(token: string) {
    localStorage.setItem("token", token);
    return true
  }

  logOut() {
    localStorage.setItem("token", '');
  }

  register(params: { username: string, password: string }) {
    return this.http.post<{ access_token: string }>(`${this.prefix}/auth/login`, params)
  }
}
