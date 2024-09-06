import { ApplicationConfig, provideExperimentalZonelessChangeDetection } from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { provideHttpClient, withInterceptorsFromDi, HTTP_INTERCEPTORS } from '@angular/common/http';
import { AuthInterceptor } from './auth.interceptor';
import { routes } from './app.routes';
import { MsgService } from './services/message.service'
import { AuthService } from './services/auth.service'
import { WebsocketService } from './services/websocket.service'

export const appConfig: ApplicationConfig = {
  providers: [provideExperimentalZonelessChangeDetection(), MsgService,
    WebsocketService, AuthService,
  {
    provide: HTTP_INTERCEPTORS,
    useClass: AuthInterceptor,
    multi: true
  },
  provideRouter(routes, withComponentInputBinding()),
  provideHttpClient(withInterceptorsFromDi())]
};
