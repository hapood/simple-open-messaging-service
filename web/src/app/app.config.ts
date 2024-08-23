import { ApplicationConfig, provideExperimentalZonelessChangeDetection } from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { jwtInterceptor } from './jwt.interceptor';
import { routes } from './app.routes';
import { MsgService } from './common/services/message.service'

export const appConfig: ApplicationConfig = {
  providers: [provideExperimentalZonelessChangeDetection(), MsgService,
  provideRouter(routes, withComponentInputBinding()),
  provideHttpClient(withInterceptors([jwtInterceptor]))]
};
