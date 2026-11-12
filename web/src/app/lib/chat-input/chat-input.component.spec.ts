import { ChatSurfaceLifecycle } from '../../components/message-thread/chat-surface-lifecycle';
import {
  ApplicationRef,
  provideZonelessChangeDetection,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, Subject } from 'rxjs';
import { vi } from 'vitest';
import { TranslocoService } from '@jsverse/transloco';
import { ChatInputComponent } from './chat-input.component';
import { NativeUploadService } from '../../services/native-upload.service';
import { KeyboardInsetService } from '../../services/keyboard-inset.service';
import { PreferenceStore } from '../../services/preference-store.service';
import { LinkCardGenerationService } from '../../services/link-card-generation.service';
import { RouteService } from '../../services/route.service';
import { ComposerDraftService } from '../../services/composer-draft.service';

describe('ChatInputComponent binding isolation', () => {
  it('saves to the old binding even after the thread input changes, and clears the editor on unbind', () => {
    const owner = new ChatSurfaceLifecycle();
    const binding = owner.bind(42);
    const component = Object.create(ChatInputComponent.prototype);
    const save = vi.fn();
    const clear = vi.fn();
    Object.assign(component, {
      boundContext: binding,
      threadId: () => 99,
      editor: () => ({ clear, getText: () => 'old draft' }),
      composerDrafts: { save },
      draftHtml: signal('<p>old draft</p>'),
      detectedLink: signal(null),
      linkGeneration: () => undefined,
      generationId: signal(null),
      generationStarting: signal(false),
      generationStartFailed: signal(false),
      recording: signal(false),
      stopWaveform: vi.fn(),
      closeEmoji: vi.fn(),
      closeAttach: vi.fn(),
    });
    component.unbind();
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 42, plainText: 'old draft' }),
    );
    expect(clear).toHaveBeenCalledOnce();
    expect(component.draftHtml()).toBe('');
    expect(component.boundContext).toBeUndefined();
    component.unbind();
    expect(save).toHaveBeenCalledOnce();
  });

  it('receives Unbound synchronously without waiting for Angular effects', async () => {
    const pendingGeneration = new Subject();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: NativeUploadService, useValue: {} },
        { provide: KeyboardInsetService, useValue: {} },
        {
          provide: TranslocoService,
          useValue: { translate: (key: string) => key },
        },
        {
          provide: PreferenceStore,
          useValue: { get: async () => undefined, set: async () => undefined },
        },
        {
          provide: LinkCardGenerationService,
          useValue: {
            snapshot: vi.fn(),
            pause: vi.fn(),
            begin$: () => pendingGeneration,
          },
        },
        { provide: RouteService, useValue: {} },
        {
          provide: ComposerDraftService,
          useValue: { get: vi.fn(), save: vi.fn() },
        },
      ],
    });
    try {
      const component = TestBed.runInInjectionContext(
        () => new ChatInputComponent(),
      );
      const owner = new ChatSurfaceLifecycle();
      const binding = owner.bind(42);
      const clear = vi.fn();
      Object.assign(component, {
        lifecycle: signal(owner),
        editor: signal({ clear, getText: () => 'draft' }),
      });
      await TestBed.inject(ApplicationRef).whenStable();
      expect(component['boundContext']).toBe(binding);
      component.draftHtml.set('draft');
      const before = clear.mock.calls.length;
      component['startGeneration']('', 'https://example.com', true);
      expect(pendingGeneration.observed).toBe(true);
      owner.unbind();
      expect(pendingGeneration.observed).toBe(false);
      // Deliberately no await/detectChanges: the stream must release immediately.
      expect(component['boundContext']).toBeUndefined();
      expect(component.draftHtml()).toBe('');
      expect(clear).toHaveBeenCalledTimes(before + 1);
      const successor = owner.bind(42);
      expect(component['boundContext']).toBe(successor);
      owner.activate(successor, true);
      expect(component.interactive()).toBe(true);
      owner.unbind();
      expect(component.interactive()).toBe(false);
      component.ngOnDestroy();
    } finally {
      TestBed.resetTestingModule();
    }
  });

  it('does not send picker results into a successor binding', async () => {
    const owner = new ChatSurfaceLifecycle();
    const old = owner.bind(42);
    let finish!: (files: unknown[]) => void;
    const component = Object.create(ChatInputComponent.prototype);
    const emit = vi.fn();
    Object.assign(component, {
      boundContext: old,
      send: { emit },
      nativeUploads: {
        supported: () => true,
        pick: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      },
    });
    component.onAttachClick();
    owner.unbind();
    component.boundContext = owner.bind(42);
    finish([{ path: 'old-file' }]);
    await Promise.resolve();
    expect(emit).not.toHaveBeenCalled();
  });
});

describe('ChatInputComponent recording disposal', () => {
  it('discards synchronously and removes queued recorder callbacks before stopping', () => {
    const component = Object.create(ChatInputComponent.prototype);
    const unsubscribe = vi.fn();
    const emit = vi.fn();
    const recorder = {
      state: 'recording',
      ondataavailable: vi.fn(),
      onstop: vi.fn(),
      stop: vi.fn(() => {
        expect(recorder.ondataavailable).toBeNull();
        expect(recorder.onstop).toBeNull();
      }),
    };
    Object.assign(component, {
      microphone: { unsubscribe },
      recorder,
      chunks: [new Blob(['old audio'])],
      recording: signal(true),
      stopWaveform: vi.fn(),
      send: { emit },
    });
    component.stopRecording(true);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(recorder.stop).toHaveBeenCalledOnce();
    expect(component.recorder).toBeNull();
    expect(component.chunks).toEqual([]);
    expect(component.recording()).toBe(false);
    component.finalizeRecording();
    expect(emit).not.toHaveBeenCalled();
    component.stopRecording(true);
    expect(recorder.stop).toHaveBeenCalledOnce();
  });

  it('keeps final recorder data for send, but unbind can discard before stop settles', () => {
    const component = Object.create(ChatInputComponent.prototype);
    const emit = vi.fn();
    const recorder = {
      state: 'recording',
      ondataavailable: vi.fn(),
      onstop: vi.fn(),
      stop: vi.fn(),
    };
    Object.assign(component, {
      recorder,
      microphone: { unsubscribe: vi.fn() },
      chunks: [new Blob(['audio'])],
      recording: signal(true),
      stopWaveform: vi.fn(),
      send: { emit },
      recordStartedAt: Date.now() - 2500,
      mimeForRecording: 'audio/webm',
    });
    component.stopRecording(false);
    expect(component.recorder).toBe(recorder);
    expect(component.chunks).toHaveLength(1);
    expect(emit).not.toHaveBeenCalled();
    recorder.state = 'inactive';
    component.stopRecording(true);
    component.finalizeRecording();
    expect(component.chunks).toEqual([]);
    expect(emit).not.toHaveBeenCalled();
  });

  it('sends a completed clip after a normal release', () => {
    const component = Object.create(ChatInputComponent.prototype);
    const emit = vi.fn();
    const recorder = {
      state: 'inactive',
      ondataavailable: vi.fn(),
      onstop: vi.fn(),
    };
    Object.assign(component, {
      recorder,
      chunks: [new Blob(['audio'])],
      recording: signal(true),
      recorderStopSettled: true,
      recordStartedAt: Date.now() - 2500,
      mimeForRecording: 'audio/webm',
      stopWaveform: vi.fn(),
      send: { emit },
    });
    component.stopRecording(false);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'audio', mimeType: 'audio/webm' }),
    );
    expect(recorder.onstop).toBeNull();
    component.finalizeRecording();
    expect(emit).toHaveBeenCalledOnce();
  });

  it('ends pending acquisition even when no recorder exists', () => {
    const component = Object.create(ChatInputComponent.prototype);
    const unsubscribe = vi.fn();
    Object.assign(component, {
      microphone: { unsubscribe },
      recording: signal(false),
      stopWaveform: vi.fn(),
      recordHoldPending: true,
    });
    component.stopRecording(true);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(component.recordHoldPending).toBe(false);
    expect(component.microphone).toBeUndefined();
  });
});

describe('ChatInputComponent link generation', () => {
  it('unsubscribes a pending start on reset and does not deliver its late result', () => {
    const component = Object.create(ChatInputComponent.prototype);
    const response = new Subject();
    const forget = vi.fn();
    Object.assign(component, {
      generations: { begin$: () => response, forget },
      generationId: signal(null),
      generationStarting: signal(false),
      generationStartFailed: signal(false),
      openGenerationDialog: vi.fn(),
      openWhenStarted: true,
    });
    component.startGeneration('', 'https://example.com', true);
    expect(response.observed).toBe(true);
    component.resetGeneration();
    expect(response.observed).toBe(false);
    response.next({ generationId: 'old', status: 'pending' });
    expect(component.generationId()).toBeNull();
    expect(component.generationStarting()).toBe(false);
    expect(component.openGenerationDialog).not.toHaveBeenCalled();
    expect(forget).not.toHaveBeenCalled();
  });
  it('reset closes only its preview dialog and cancellation cannot submit or retry', () => {
    const component = Object.create(ChatInputComponent.prototype);
    const start = vi.fn();
    const emit = vi.fn();
    let cancel: (() => void) | undefined;
    const close = vi.fn(() => {
      const callback = cancel;
      cancel = undefined;
      callback?.();
    });
    const popup = vi.fn((_type, _inputs, result) => {
      cancel = () => result(undefined);
      return { id: 17 };
    });
    Object.assign(component, {
      route: { popupDlg: popup, closeDialogAndAbove: close },
      generationId: signal('preview'),
      generationStarting: signal(false),
      generationStartFailed: signal(false),
      generations: { forget: vi.fn() },
      editor: () => undefined,
      threadId: () => 42,
      startGeneration: start,
      send: { emit },
    });
    component.openGenerationDialog();
    component.openGenerationDialog();
    expect(popup).toHaveBeenCalledOnce();
    component.resetGeneration();
    expect(close).toHaveBeenCalledExactlyOnceWith({ id: 17 });
    expect(component.generationDialog).toBeUndefined();
    expect(cancel).toBeUndefined();
    expect(start).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    component.resetGeneration();
    expect(close).toHaveBeenCalledOnce();
  });

  it('starts generation only after the user activates the link action', async () => {
    vi.useFakeTimers();
    const begin = vi.fn().mockReturnValue(
      of({
        generationId: 'generation-1',
        status: 'pending',
        expiresAt: Date.now() + 60_000,
      }),
    );
    TestBed.configureTestingModule({
      providers: [
        { provide: NativeUploadService, useValue: {} },
        { provide: KeyboardInsetService, useValue: {} },
        {
          provide: TranslocoService,
          useValue: { translate: (key: string) => key },
        },
        {
          provide: PreferenceStore,
          useValue: {
            get: vi.fn().mockResolvedValue(undefined),
            set: vi.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: LinkCardGenerationService,
          useValue: {
            begin$: begin,
            snapshot: vi.fn(),
            resume: vi.fn(),
            forget: vi.fn(),
          },
        },
        { provide: RouteService, useValue: { popupDlg: vi.fn() } },
        {
          provide: ComposerDraftService,
          useValue: { drafts: signal(0), get: vi.fn(), save: vi.fn() },
        },
      ],
    });

    const component = TestBed.runInInjectionContext(
      () => new ChatInputComponent(),
    );
    component.onLinkMarkers([
      { href: 'https://example.com', start: 0, end: 19 },
    ]);
    await vi.advanceTimersByTimeAsync(500);

    expect(component.detectedLink()).toBe('https://example.com');
    expect(begin).not.toHaveBeenCalled();

    component.onLinkClick();
    await vi.runAllTimersAsync();

    expect(begin).toHaveBeenCalledOnce();
    expect(begin).toHaveBeenCalledWith('https://example.com', '', undefined);
    vi.useRealTimers();
  });
});
