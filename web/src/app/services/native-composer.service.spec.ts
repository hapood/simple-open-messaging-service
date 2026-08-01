import {
  ApplicationRef,
  computed,
  provideZonelessChangeDetection,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { KeyboardInsetService } from './keyboard-inset.service';
import {
  NativeComposerService,
  type NativeComposerContext,
} from './native-composer.service';

describe('NativeComposerService global geometry', () => {
  const context: NativeComposerContext = {
    version: 1,
    contextId: 7,
    threadId: '11',
    placeholder: 'Message',
    initialDraft: '',
    sending: false,
    canRecord: true,
    canUpload: true,
    mentionsEnabled: true,
    theme: 'system',
  };

  const inset = signal(0);
  const animation = signal<{ target: number; durationMs: number } | null>(null);
  const layoutOverride = signal<number | null>(null);
  const viewportReduction = signal(0);
  const setLayoutOverride = jasmine
    .createSpy('setLayoutOverride')
    .and.callFake((_owner: object, value: number | null) =>
      layoutOverride.set(value),
    );
  let originalUserAgent: string;
  let originalTauriInternals: Window['__TAURI_INTERNALS__'];
  let originalShell: Window['SomsShell'];

  const flush = (): void => TestBed.inject(ApplicationRef).tick();
  const css = (name: string): string =>
    document.documentElement.style.getPropertyValue(name);

  beforeEach(() => {
    originalUserAgent = navigator.userAgent;
    originalTauriInternals = window.__TAURI_INTERNALS__;
    originalShell = window.SomsShell;
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Android test WebView',
    });
    window.__TAURI_INTERNALS__ = {};
    window.SomsShell = {
      getSafeInsets: () => '{"top":0,"bottom":24}',
      showComposer: jasmine.createSpy('showComposer'),
      hideComposer: jasmine.createSpy('hideComposer'),
    };
    inset.set(0);
    animation.set(null);
    layoutOverride.set(null);
    viewportReduction.set(0);
    setLayoutOverride.calls.reset();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: KeyboardInsetService,
          useValue: {
            inset: inset.asReadonly(),
            animation: animation.asReadonly(),
            layoutOverride: layoutOverride.asReadonly(),
            viewportReduction: viewportReduction.asReadonly(),
            open: computed(() => inset() > 0),
            setLayoutOverride,
          } as unknown as KeyboardInsetService,
        },
      ],
    });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: originalUserAgent,
    });
    window.__TAURI_INTERNALS__ = originalTauriInternals;
    window.SomsShell = originalShell;
    delete window.__SOMS_COMPOSER_EVENT__;
    const root = document.documentElement;
    root.style.removeProperty('--soms-composer-height');
    root.style.removeProperty('--soms-keyboard-height');
    root.style.removeProperty('--soms-content-bottom-reserve');
    root.style.removeProperty('--soms-snackbar-bottom-offset');
  });

  it('leaves boot geometry untouched until the shell reports native bounds', () => {
    const service = TestBed.inject(NativeComposerService);
    document.documentElement.style.setProperty(
      '--soms-composer-height',
      '74px',
    );
    service.show(context);
    flush();

    expect(css('--soms-composer-height')).toBe('74px');
  });

  it('publishes composer and system IME geometry independently', () => {
    const service = TestBed.inject(NativeComposerService);
    service.show(context);
    inset.set(320);
    viewportReduction.set(20);
    window.__SOMS_COMPOSER_EVENT__?.({
      version: 1,
      contextId: context.contextId,
      sequence: 1,
      kind: 'geometry',
      composerHeightPx: 60.9,
      keyboardHeightPx: 351,
      occupiedHeightPx: 411.9,
    });
    flush();

    expect(css('--soms-composer-height')).toBe('60px');
    expect(css('--soms-keyboard-height')).toBe('351px');
  });

  it('keeps split emoji geometry cached across hide', () => {
    const service = TestBed.inject(NativeComposerService);
    service.show(context);
    inset.set(320);
    window.__SOMS_COMPOSER_EVENT__?.({
      version: 1,
      contextId: context.contextId,
      sequence: 1,
      kind: 'geometry',
      composerHeightPx: 64,
      keyboardHeightPx: 288,
      occupiedHeightPx: 352,
    });
    flush();

    expect(css('--soms-composer-height')).toBe('64px');
    expect(css('--soms-keyboard-height')).toBe('288px');

    service.hide(context.contextId);
    flush();
    expect(css('--soms-composer-height')).toBe('64px');
    expect(css('--soms-keyboard-height')).toBe('288px');
    expect(service.composerHeight()).toBe(64);
    expect(service.keyboardHeight()).toBe(288);
  });
});
