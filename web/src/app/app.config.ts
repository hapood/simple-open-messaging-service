import { ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { jwtInterceptor } from './jwt.interceptor';
import { routes } from './app.routes';
import { ChatService } from '../services/chat.service'

export const appConfig: ApplicationConfig = {
  providers: [provideZoneChangeDetection({ eventCoalescing: true },), ChatService,
  provideRouter(routes, withComponentInputBinding()),
  provideHttpClient(withInterceptors([jwtInterceptor]))]
};
