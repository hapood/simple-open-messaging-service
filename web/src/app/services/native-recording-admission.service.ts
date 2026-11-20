import { Injectable, inject } from '@angular/core';
import { isAndroidNative, listenEvent } from './runtime';
import { MediaTransferService } from './media-transfer.service';
import { ThreadSendOutbox } from './thread-send-outbox.service';
import { ToastService } from './toast.service';
import { SessionLifecycleService } from './session-lifecycle.service';
import { SessionSupersededError } from './session/session-identity';

export interface NativeVoiceReady {
  sessionId: string;
  contextId: number;
  threadId: number;
  clientMessageId: string;
  path: string;
  partId: string;
  mimeType: string;
  name: string;
  durationMs: number;
  size: number;
}

/** Persists recorder output before handing execution to the application upload service. */
export class RecordingAdmission {
  private readonly admissions = new Map<string, Promise<void>>();
  constructor(private readonly transfers: MediaTransferService, private readonly outbox: ThreadSendOutbox, private readonly lifecycle: SessionLifecycleService) {}

  handle(event: NativeVoiceReady): Promise<void> {
    const scope = this.lifecycle.capture();
    if (!scope.sessionId || scope.sessionId !== event.sessionId || !this.lifecycle.isCurrent(scope)) return Promise.resolve();
    const active = this.admissions.get(event.clientMessageId);
    if (active) return active;
    if (this.outbox.get(event.clientMessageId)) return Promise.resolve();
    const admission = this.admit(event).finally(() => this.admissions.delete(event.clientMessageId));
    this.admissions.set(event.clientMessageId, admission);
    return admission;
  }

  private async admit(event: NativeVoiceReady): Promise<void> {
    const scope = this.lifecycle.capture();
    const task = {
      clientMessageId: event.clientMessageId, threadId: event.threadId,
      item: { type: 'AUDIO' as const, file: {
        path: event.path, partId: event.partId, name: event.name, mimeType: event.mimeType, size: event.size,
      } },
    };
    await this.outbox.enqueue(task);
    this.lifecycle.assertCurrent(scope);
    await this.transfers.executeNative(task);
  }
}

/** Installed by the application root, independent of composer visibility or selected thread. */
@Injectable({ providedIn: 'root' })
export class NativeRecordingAdmissionService {
  private readonly admission = new RecordingAdmission(inject(MediaTransferService), inject(ThreadSendOutbox), inject(SessionLifecycleService));
  private readonly toast = inject(ToastService);

  constructor() {
    if (!isAndroidNative()) return;
    void listenEvent<NativeVoiceReady>('native-voice-ready', ({ payload }) => {
      void this.admission.handle(payload).catch(error => {
        if (!(error instanceof SessionSupersededError)) this.toast.warn(String(error));
      });
    });
  }
}
