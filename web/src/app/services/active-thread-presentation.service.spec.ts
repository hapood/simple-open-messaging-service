import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActiveThreadPresentation } from './active-thread-presentation.service';
import { AppDataLifetime } from './app-data-lifetime.service';

describe('ActiveThreadPresentation', () => {
  const invoke =
    vi.fn<
      (command: string, args?: Record<string, unknown>) => Promise<unknown>
    >();

  beforeEach(() => {
    invoke.mockReset().mockResolvedValue(undefined);
    window.__TAURI_INTERNALS__ = {};
    window.__TAURI__ = { core: { invoke } };
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    delete window.__TAURI_INTERNALS__;
    delete window.__TAURI__;
    vi.restoreAllMocks();
  });

  it('reports and clears the single desktop selection without an account or cache', async () => {
    const bridge = TestBed.inject(ActiveThreadPresentation);
    await bridge.reportActiveThread(7);
    await bridge.reportActiveThread(8);
    await bridge.reportActiveThread(undefined);
    expect(invoke.mock.calls).toEqual([
      ['native_db_set_active_thread', { threadId: 7 }],
      ['native_db_set_active_thread', { threadId: 8 }],
      ['native_db_set_active_thread', { threadId: 0 }],
    ]);
  });

  it('does nothing in the browser', async () => {
    delete window.__TAURI_INTERNALS__;
    delete window.__TAURI__;
    await TestBed.inject(ActiveThreadPresentation).reportActiveThread(7);
    TestBed.inject(AppDataLifetime).end();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('leaves Android reports to UnreadAttentionService', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Android');
    await TestBed.inject(ActiveThreadPresentation).reportActiveThread(7);
    TestBed.inject(AppDataLifetime).end();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('clears desktop presentation once at teardown and admits no later reports', async () => {
    const bridge = TestBed.inject(ActiveThreadPresentation);
    await bridge.reportActiveThread(7);
    TestBed.inject(AppDataLifetime).end();
    TestBed.inject(AppDataLifetime).end();
    await bridge.reportActiveThread(8);
    expect(invoke.mock.calls).toEqual([
      ['native_db_set_active_thread', { threadId: 7 }],
      ['native_db_set_active_thread', { threadId: 0 }],
    ]);
  });

  it('does not invoke native code when first created after teardown', async () => {
    TestBed.inject(AppDataLifetime).end();
    await TestBed.inject(ActiveThreadPresentation).reportActiveThread(7);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('handles IPC failures locally and suppresses late teardown errors', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let reject!: (error: Error) => void;
    invoke.mockReturnValueOnce(
      new Promise((_, fail) => {
        reject = fail;
      }),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bridge = TestBed.inject(ActiveThreadPresentation);
    bridge.reportActiveThread(7);
    reject(new Error('IPC failed'));
    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
    warn.mockClear();
    invoke.mockReturnValueOnce(
      new Promise((_, fail) => {
        reject = fail;
      }),
    );
    bridge.reportActiveThread(8);
    TestBed.inject(AppDataLifetime).end();
    reject(new Error('late IPC failure'));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(warn).not.toHaveBeenCalled();
  });
});
