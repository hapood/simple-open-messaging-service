import { EnvironmentInjector, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject, of } from 'rxjs';
import { AuthService } from '../../services/auth.service';
import { ConfigService } from '../../services/config.service';
import { RouteService } from '../../services/route.service';
import { ServerConfigDialogService } from '../../services/server-config-dialog.service';
import { QrLoginPageComponent } from './qr-login-page.component';

describe('QrLoginPageComponent polling', () => {
  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  it('keeps at most one poll request in flight while the backend is unresponsive', async () => {
    vi.useFakeTimers();
    const pendingPoll = new Subject<never>();
    const qrPoll = vi.fn(() => pendingPoll);
    const expiresAt = Date.now() + 180_000;

    TestBed.configureTestingModule({
      providers: [
        {
          provide: AuthService,
          useValue: {
            qrCreate: () =>
              of({ code: 0, data: { qrToken: 'qr-token', expiresAt } }),
            qrPoll,
          },
        },
        {
          provide: ConfigService,
          useValue: {
            ensureLoaded: () => Promise.resolve(),
            methodsForPlatform: signal<string[]>([]),
          },
        },
        { provide: RouteService, useValue: { redirect: vi.fn() } },
        { provide: ServerConfigDialogService, useValue: { open: vi.fn() } },
      ],
    });

    const injector = TestBed.inject(EnvironmentInjector);
    const component = injector.runInContext(() => new QrLoginPageComponent());

    await vi.advanceTimersByTimeAsync(1_500);
    expect(qrPoll).toHaveBeenCalledTimes(1);

    // The old setInterval implementation would have started several more requests here.
    await vi.advanceTimersByTimeAsync(6_000);
    expect(qrPoll).toHaveBeenCalledTimes(1);

    component.ngOnDestroy();
  });
});
