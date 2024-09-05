import { ApplicationConfig, provideExperimentalZonelessChangeDetection } from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { jwtInterceptor } from './auth.interceptor';
import { routes } from './app.routes';
import { MsgService } from './services/message.service'
import { WebsocketService } from './services/websocket.service'

export const appConfig: ApplicationConfig = {
  providers: [provideExperimentalZonelessChangeDetection(), MsgService,
    WebsocketService,
  provideRouter(routes, withComponentInputBinding()),
  provideHttpClient(withInterceptors([jwtInterceptor]))]
};
