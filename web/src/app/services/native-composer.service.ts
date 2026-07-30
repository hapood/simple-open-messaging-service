import { inject, Injectable, signal } from '@angular/core';
import { isAndroidNative, listenEvent } from './runtime';
import { KeyboardInsetService } from './keyboard-inset.service';

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

export interface NativeComposerBounds {
  version: 1;
  contextId: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

export type NativeComposerEvent =
  | {
      version: 1;
      contextId: number;
      sequence: number;
      kind: 'geometry';
      composerHeightPx?: number;
      keyboardHeightPx?: number;
      /** Compatibility field for Web bundles predating the split geometry contract. */
      occupiedHeightPx?: number;
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
  /** Native composer height after its latest completed layout; excludes keyboard and safe-area insets. */
  readonly composerHeight = signal(DEFAULT_COMPOSER_HEIGHT_PX);
  /** Native keyboard surface height (system IME or emoji replacement); excludes the safe-area inset. */
  readonly keyboardHeight = signal(0);
  readonly event = signal<NativeComposerEvent | null>(null);
  readonly voiceUpload = signal<NativeVoiceUploadEvent | null>(null);
  readonly uploadProgress = signal<{
    clientMessageId: string;
    loaded: number;
    total: number;
  } | null>(null);

  private activeContextId: number | null = null;
  private readonly keyboardInset = inject(KeyboardInsetService);
  private readonly keyboardLayoutOwner = {};

  constructor() {
    if (typeof window === 'undefined') return;
    window.__SOMS_COMPOSER_EVENT__ = (raw: NativeComposerEvent) => {
      if (
        raw?.version !== 1 ||
        raw.contextId !== this.activeContextId ||
        !Number.isFinite(raw.sequence)
      ) {
        return;
      }
      if (raw.kind === 'geometry') {
        const hasSplitGeometry =
          Number.isFinite(raw.composerHeightPx) &&
          Number.isFinite(raw.keyboardHeightPx);
        const composerHeight = hasSplitGeometry
          ? Math.max(0, Math.trunc(raw.composerHeightPx!))
          : 0;
        const keyboardHeight = hasSplitGeometry
          ? Math.max(0, Math.trunc(raw.keyboardHeightPx!))
          : Math.max(0, Math.trunc(raw.occupiedHeightPx ?? 0));
        this.composerHeight.set(composerHeight);
        this.keyboardHeight.set(keyboardHeight);
        document.documentElement.style.setProperty(
          '--soms-composer-height',
          `${composerHeight}px`,
        );
        document.documentElement.style.setProperty(
          '--soms-keyboard-height',
          `${keyboardHeight}px`,
        );
        document.documentElement.style.setProperty(
          '--soms-content-bottom-reserve',
          'var(--soms-bottom-occupation)',
        );
        document.documentElement.style.setProperty(
          '--soms-snackbar-bottom-offset',
          'var(--soms-bottom-occupation)',
        );
        // The split geometry still owns the complete native bottom occupation. Suppress the separate
        // Angular IME transform while the native composer owns the chat so it cannot double-compensate.
        this.keyboardInset.setLayoutOverride(this.keyboardLayoutOwner, 0);
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
    window.SomsShell!.showComposer!(JSON.stringify(context));
  }

  setBounds(contextId: number, rect: DOMRectReadOnly): void {
    if (!this.supported || this.activeContextId !== contextId) return;
    window.SomsShell!.setComposerBounds?.(
      JSON.stringify({
        version: 1,
        contextId,
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      } satisfies NativeComposerBounds),
    );
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
    this.hideActive();
  }

  /** Release the native surface at navigation start, before the outgoing pane finishes its lifecycle. */
  hideActive(): void {
    if (!this.supported || this.activeContextId === null) return;
    const contextId = this.activeContextId;
    // Clear ownership before calling native: hideComposer emits a zero-height geometry event
    // synchronously on some WebViews. Reject that event so the last real measurement remains cached
    // for the next chat and its first frame can use the measured height instead of falling back.
    this.activeContextId = null;
    window.SomsShell!.hideComposer?.(contextId);
    this.keyboardInset.setLayoutOverride(this.keyboardLayoutOwner, null);
    this.event.set(null);
  }
}
