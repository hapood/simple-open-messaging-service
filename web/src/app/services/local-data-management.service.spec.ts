import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { LocalDataManagementService } from './local-data-management.service';

describe('LocalDataManagementService', () => {
  type TauriWindow = {
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: {
      core: {
        invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
      };
    };
  };
  const tauriWindow = (): TauriWindow => window as unknown as TauriWindow;

  afterEach(() => {
    tauriWindow().__TAURI_INTERNALS__ = undefined;
    tauriWindow().__TAURI__ = undefined;
  });

  it('clears both the native database and media cache', async () => {
    const commands: string[] = [];
    tauriWindow().__TAURI_INTERNALS__ = {};
    tauriWindow().__TAURI__ = {
      core: {
        invoke: async (command) => {
          commands.push(command);
          return null;
        },
      },
    };
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), LocalDataManagementService],
    });

    await TestBed.inject(LocalDataManagementService).clearAll();

    expect(commands.sort()).toEqual([
      'clear_media_cache',
      'native_db_clear_all',
    ]);
  });
});
