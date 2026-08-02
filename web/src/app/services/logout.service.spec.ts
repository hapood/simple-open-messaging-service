import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { Subject } from 'rxjs';
import { AuthService } from './auth.service';
import { LogoutService } from './logout.service';
import { RoutePage, RouteService } from './route.service';
import { WebsocketService } from './websocket.service';

describe('LogoutService', () => {
  it('waits for local cache deletion before disconnecting and redirecting', () => {
    const pending = new Subject<unknown>();
    const auth = {
      logout: jasmine.createSpy('logout').and.returnValue(pending),
    };
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

    expect(auth.logout).toHaveBeenCalledTimes(1);
    expect(ws.disconnect).not.toHaveBeenCalled();
    expect(route.redirect).not.toHaveBeenCalled();

    pending.next(undefined);
    expect(ws.disconnect).toHaveBeenCalledTimes(1);
    expect(route.redirect).toHaveBeenCalledOnceWith(RoutePage.AUTH_LOGIN);

    // A late old-server failure must not navigate again and overwrite /config or a newer session.
    pending.error(new Error('old server unreachable'));
    expect(route.redirect).toHaveBeenCalledTimes(1);
  });

  it('keeps the authenticated UI when local cleanup throws synchronously', () => {
    const auth = {
      logout: jasmine
        .createSpy('logout')
        .and.throwError('native bridge unavailable'),
    };
    const ws = {
      disconnect: jasmine
        .createSpy('disconnect')
        .and.throwError('transport unavailable'),
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
    expect(ws.disconnect).not.toHaveBeenCalled();
    expect(route.redirect).not.toHaveBeenCalled();
  });

  it('keeps the authenticated UI when local cache deletion fails asynchronously', () => {
    const failed = new Subject<unknown>();
    const auth = {
      logout: jasmine.createSpy('logout').and.returnValue(failed),
    };
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
    failed.error(new Error('cache busy'));

    expect(ws.disconnect).not.toHaveBeenCalled();
    expect(route.redirect).not.toHaveBeenCalled();
  });
});
