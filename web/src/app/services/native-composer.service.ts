import { effect, inject, Injectable, signal } from '@angular/core';
import { isAndroidNative, listenEvent } from './runtime';
import {
  KeyboardInsetService,
  uncompensatedKbdInset,
} from './keyboard-inset.service';

const DEFAULT_COMPOSER_HEIGHT_PX = 64;

export interface NativeComposerContext {
  version: 1;
  contextId: number;
  threadId: string;
  placeholder: string;
  initialDraft: string;
  sending: boolean;
  canRecord: boolean;
  canUpload: boolean;
  theme: 'light' | 'dark' | 'system';
}

export type NativeComposerEvent =
  | {
      version: 1;
      contextId: number;
      sequence: number;
      kind: 'geometry';
      occupiedHeightPx: number;
      replacesIme?: boolean;
    }
  | {
      version: 1;
      contextId: number;
      sequence: number;
      kind: 'draft';
      text: string;
      selectionStart: number;
      selectionEnd: number;
    }
  | {
      version: 1;
      contextId: number;
      sequence: number;
      kind: 'sendText';
      actionId: number;
      text: string;
    }
  | {
      version: 1;
      contextId: number;
      sequence: number;
      kind: 'pickAttachment';
      actionId: number;
      source: 'gallery' | 'file';
    }
  | {
      version: 1;
      contextId: number;
      sequence: number;
      kind: 'recording';
      phase: 'started' | 'cancelled' | 'completed' | 'failed';
      actionId: number;
      durationMs?: number;
      error?: string;
      selection?: import('./native-upload.service').NativeUploadSelection;
    };

export interface NativeVoiceUploadEvent {
  contextId: number;
  threadId: number;
  clientMessageId: string;
  durationMs: number;
  size: number;
  phase: 'started' | 'completed' | 'failed';
  error?: string;
}

@Injectable({ providedIn: 'root' })
export class NativeComposerService {
  readonly supported = isAndroidNative() && !!window.SomsShell?.showComposer;
  /** Native component height only. It deliberately excludes both IME and safe-area insets. */
  readonly occupiedHeight = signal(DEFAULT_COMPOSER_HEIGHT_PX);
  readonly event = signal<NativeComposerEvent | null>(null);
  readonly voiceUpload = signal<NativeVoiceUploadEvent | null>(null);
  readonly uploadProgress = signal<{
    clientMessageId: string;
    loaded: number;
    total: number;
  } | null>(null);

  private activeContextId: number | null = null;
  private readonly active = signal(false);
  private readonly keyboardInset = inject(KeyboardInsetService);
  private readonly keyboardLayoutOwner = {};

  constructor() {
    if (typeof window === 'undefined') return;
    effect(() => {
      const root = document.documentElement;
      if (!this.active()) {
        root.style.setProperty('--soms-composer-height', '0px');
        root.style.setProperty('--soms-ime-height', '0px');
        root.style.setProperty('--soms-chat-bottom-offset', '0px');
        return;
      }

      const override = this.keyboardInset.layoutOverride();
      const rawIme =
        override ??
        this.keyboardInset.animation()?.target ??
        this.keyboardInset.inset();
      const imeHeight =
        override === null
          ? uncompensatedKbdInset(
              rawIme,
              this.keyboardInset.viewportReduction(),
            )
          : rawIme;
      root.style.setProperty(
        '--soms-composer-height',
        `${this.occupiedHeight()}px`,
      );
      root.style.setProperty('--soms-ime-height', `${imeHeight}px`);
      root.style.setProperty(
        '--soms-chat-bottom-offset',
        'calc(var(--soms-composer-height) + max(var(--soms-ime-height), var(--soms-safe-bottom)))',
      );
    });
    window.__SOMS_COMPOSER_EVENT__ = (raw: NativeComposerEvent) => {
      if (
        raw?.version !== 1 ||
        raw.contextId !== this.activeContextId ||
        !Number.isFinite(raw.sequence)
      ) {
        return;
      }
      if (raw.kind === 'geometry') {
        this.occupiedHeight.set(Math.max(0, Math.trunc(raw.occupiedHeightPx)));
        this.keyboardInset.setLayoutOverride(
          this.keyboardLayoutOwner,
          raw.replacesIme ? 0 : null,
        );
      }
      this.event.set(raw);
    };
    void listenEvent<NativeVoiceUploadEvent>(
      'native-voice-upload',
      ({ payload }) => this.voiceUpload.set(payload),
    );
    void listenEvent<{
      clientMessageId: string;
      loaded: number;
      total: number;
    }>('upload-progress', ({ payload }) => this.uploadProgress.set(payload));
  }

  show(context: NativeComposerContext): void {
    if (!this.supported) return;
    this.activeContextId = context.contextId;
    this.active.set(true);
    window.SomsShell!.showComposer!(JSON.stringify(context));
  }

  update(contextId: number, patch: Record<string, unknown>): void {
    if (!this.supported || this.activeContextId !== contextId) return;
    window.SomsShell!.updateComposer?.(
      JSON.stringify({ version: 1, contextId, ...patch }),
    );
  }

  acknowledge(actionId: number, accepted: boolean): void {
    if (!this.supported) return;
    window.SomsShell!.acknowledgeComposerAction?.(actionId, accepted);
  }

  hide(contextId: number): void {
    if (!this.supported || this.activeContextId !== contextId) return;
    // Clear ownership before calling native: hideComposer emits a zero-height geometry event
    // synchronously on some WebViews. Reject that event so the last real measurement remains cached
    // for the next chat and its first frame can use the measured height instead of falling back.
    this.activeContextId = null;
    this.active.set(false);
    window.SomsShell!.hideComposer?.(contextId);
    this.keyboardInset.setLayoutOverride(this.keyboardLayoutOwner, null);
    this.event.set(null);
  }
}
