import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { Subject } from 'rxjs';
import { AuthService } from './auth.service';
import { LogoutService } from './logout.service';
import { RoutePage, RouteService } from './route.service';
import { WebsocketService } from './websocket.service';

describe('LogoutService', () => {
  it('redirects immediately and only once while the old-server revoke is still pending', () => {
    const pending = new Subject<unknown>();
    const auth = { logout: jasmine.createSpy('logout').and.returnValue(pending) };
    const ws = { disconnect: jasmine.createSpy('disconnect') };
    const route = { redirect: jasmine.createSpy('redirect') };
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        LogoutService,
        { provide: AuthService, useValue: auth },
        { provide: WebsocketService, useValue: ws },
        { provide: RouteService, useValue: route },
      ],
    });

    TestBed.inject(LogoutService).logout();

    expect(ws.disconnect).toHaveBeenCalledTimes(1);
    expect(auth.logout).toHaveBeenCalledTimes(1);
    expect(route.redirect).toHaveBeenCalledOnceWith(RoutePage.AUTH_LOGIN);

    // A late old-server failure must not navigate again and overwrite /config or a newer session.
    pending.error(new Error('old server unreachable'));
    expect(route.redirect).toHaveBeenCalledTimes(1);
  });

  it('still redirects when offline/native cleanup throws before returning an observable', () => {
    const auth = {
      logout: jasmine.createSpy('logout').and.throwError('native bridge unavailable'),
    };
    const ws = {
      disconnect: jasmine.createSpy('disconnect').and.throwError('transport unavailable'),
    };
    const route = { redirect: jasmine.createSpy('redirect') };
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        LogoutService,
        { provide: AuthService, useValue: auth },
        { provide: WebsocketService, useValue: ws },
        { provide: RouteService, useValue: route },
      ],
    });

    expect(() => TestBed.inject(LogoutService).logout()).not.toThrow();
    expect(auth.logout).toHaveBeenCalledTimes(1);
    expect(route.redirect).toHaveBeenCalledOnceWith(RoutePage.AUTH_LOGIN);
  });
});
