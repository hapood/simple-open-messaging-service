import { AppComponent } from './app.component';
import { NavigationEnd } from '@angular/router';
import { Subject } from 'rxjs';

describe('AppComponent context menu', () => {
  function contextMenu(target: Element): MouseEvent {
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
    });
    target.dispatchEvent(event);
    return event;
  }

  it('prevents the browser native context menu outside editable controls', () => {
    const target = document.createElement('div');
    const event = contextMenu(target);

    AppComponent.prototype.preventNativeContextMenu(event);

    expect(event.defaultPrevented).toBe(true);
  });

  for (const selector of ['input', 'textarea', 'contenteditable'] as const) {
    it(`keeps the native context menu for ${selector}`, () => {
      const target = document.createElement(
        selector === 'contenteditable' ? 'div' : selector,
      );
      if (selector === 'contenteditable')
        target.setAttribute('contenteditable', 'true');
      const event = contextMenu(target);

      AppComponent.prototype.preventNativeContextMenu(event);

      expect(event.defaultPrevented).toBe(false);
    });
  }
});

describe('native launch route handoff', () => {
  const originalTauri = window.__TAURI__;
  const originalGeneration = window.__SOMS_LAUNCH_GENERATION__;
  afterEach(() => {
    window.__TAURI__ = originalTauri;
    window.__SOMS_LAUNCH_GENERATION__ = originalGeneration;
    vi.restoreAllMocks();
  });

  function setup(url: string, navigated = true) {
    const events = new Subject<unknown>();
    const context = {
      router: { url, navigated, events },
      auth: { isLoggedIn: () => false },
      config: { ensureLoaded: vi.fn().mockResolvedValue(undefined) },
      applicationRef: { whenStable: vi.fn().mockResolvedValue(undefined) },
    };
    window.__SOMS_LAUNCH_GENERATION__ = 'test-launch';
    const finish = vi.fn();
    window.__TAURI__ = {
      core: {
        invoke: vi.fn(async (_command, args) => {
          if ((args?.['update'] as { kind: string }).kind === 'ready') finish();
          return undefined;
        }),
      },
    };
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      queueMicrotask(() => callback(0));
      return 1;
    });
    const run = () =>
      (
        AppComponent.prototype as unknown as {
          finishNativeSplashWhenReady: () => Promise<void>;
        }
      ).finishNativeSplashWhenReady.call(context);
    return { context, events, finish, run };
  }

  it('keeps the native layer until the async initial route completes', async () => {
    const { context, events, finish, run } = setup('/config', false);
    const ready = run();
    await Promise.resolve();
    expect(finish).not.toHaveBeenCalled();
    expect(context.applicationRef.whenStable).not.toHaveBeenCalled();
    events.next(new NavigationEnd(1, '/', '/config'));
    await ready;
    expect(context.config.ensureLoaded).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledOnce();
  });

  it('first-run setup never waits for a remote login config', async () => {
    const { context, finish, run } = setup('/config');
    await run();
    expect(context.config.ensureLoaded).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledOnce();
  });

  it('login waits for its configuration before publishing readiness', async () => {
    const { context, finish, run } = setup('/auth/login');
    let configured!: () => void;
    context.config.ensureLoaded.mockReturnValue(
      new Promise<void>((resolve) => {
        configured = resolve;
      }),
    );
    const ready = run();
    await Promise.resolve();
    expect(finish).not.toHaveBeenCalled();
    configured();
    await ready;
    expect(context.config.ensureLoaded).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledOnce();
  });
});
