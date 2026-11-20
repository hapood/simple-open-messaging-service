import { TestBed } from '@angular/core/testing';
import { TranslocoService } from '@jsverse/transloco';
import { SettingsDataComponent } from './settings-data.component';
import { LocalDataManagementService } from '../../services/local-data-management.service';
import { RouteService } from '../../services/route.service';
import { ToastService } from '../../services/toast.service';

describe('SettingsDataComponent storage statistics', () => {
  it('refreshes statistics after confirmed cleanup and restores the button', async () => {
    const stats = vi
      .fn()
      .mockResolvedValue({
        messageCount: 0,
        mediaBytes: 0,
        avatarBytes: 128,
        temporaryUploadBytes: 512,
      });
    const clearChatCache = vi.fn().mockResolvedValue(undefined);
    let confirm: ((value: boolean) => void) | undefined;
    TestBed.configureTestingModule({
      providers: [
        {
          provide: RouteService,
          useValue: {
            popupDlg: (
              _type: unknown,
              _options: unknown,
              callback: (value: boolean) => void,
            ) => {
              confirm = callback;
            },
          },
        },
        { provide: ToastService, useValue: { warn: vi.fn(), info: vi.fn() } },
        {
          provide: TranslocoService,
          useValue: { translate: (key: string) => key },
        },
        {
          provide: LocalDataManagementService,
          useValue: { stats, clearChatCache },
        },
      ],
    });
    const component = TestBed.runInInjectionContext(
      () => new SettingsDataComponent(),
    );
    component.confirmClear();
    expect(clearChatCache).not.toHaveBeenCalled();
    confirm!(true);
    expect(component.clearing()).toBe(true);
    await vi.waitFor(() => expect(component.clearing()).toBe(false));
    expect(clearChatCache).toHaveBeenCalledTimes(1);
    expect(stats).toHaveBeenCalledTimes(1);
    expect(component.avatarBytes()).toBe(128);
    expect(component.temporaryUploadBytes()).toBe(512);
  });

  it('distinguishes loading, unavailable measurements and measured bytes', async () => {
    TestBed.configureTestingModule({
      providers: [
        { provide: RouteService, useValue: {} },
        { provide: ToastService, useValue: { warn: vi.fn() } },
        {
          provide: TranslocoService,
          useValue: { translate: (key: string) => key },
        },
        {
          provide: LocalDataManagementService,
          useValue: {
            stats: async () => ({
              messageCount: 12,
              mediaBytes: null,
              avatarBytes: null,
              temporaryUploadBytes: 2048,
            }),
          },
        },
      ],
    });
    const component = TestBed.runInInjectionContext(
      () => new SettingsDataComponent(),
    );
    expect(component.storageUsage(null)).toBe('…');
    component.ngOnInit();
    await Promise.resolve();
    expect(component.messageCount()).toBe(12);
    expect(component.mediaUsage()).toBe('settings.cacheMeasurementUnavailable');
    expect(component.storageUsage(component.avatarBytes())).toBe(
      'settings.cacheMeasurementUnavailable',
    );
    expect(component.storageUsage(component.temporaryUploadBytes())).toBe(
      '2.0 KB',
    );
    expect(component.storageUsage(0)).toBe('0 B');
  });
});
