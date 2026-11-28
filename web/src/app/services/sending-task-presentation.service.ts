import { Injectable, computed, inject } from '@angular/core';
import { ThreadSendOutbox } from './thread-send-outbox.service';
import { WebsocketService } from './websocket.service';

/** Counts come from one durable-intent projection, never from rendered message cards. */
@Injectable({ providedIn: 'root' })
export class SendingTaskPresentation {
  private readonly outbox = inject(ThreadSendOutbox);
  private readonly connection = inject(WebsocketService);
  // Connection loss changes graphics only; durable execution/retry state stays owned by the outbox.
  readonly unavailable = computed(() => this.connection.state() !== 'open');

  readonly snapshot = computed(() => {
    const tasks = this.outbox.tasks();
    return {
      messages: tasks.filter((row) => row.execution.kind === 'message'),
      uploads: tasks.filter((row) => row.execution.kind === 'attachment'),
      failures: tasks.filter((row) => row.execution.phase === 'failed'),
    };
  });

  forThread(threadId: number) {
    const snapshot = this.snapshot();
    const messages = snapshot.messages.filter(
      (row) => row.task.threadId === threadId,
    );
    const uploads = snapshot.uploads.filter(
      (row) => row.task.threadId === threadId,
    );
    return {
      messages,
      uploads,
      unavailable: this.unavailable(),
      failedCount: snapshot.failures.filter(
        (row) => row.task.threadId === threadId,
      ).length,
      messageCount: messages.filter((row) => row.execution.phase === 'sending')
        .length,
      uploadCount: uploads.filter((row) => row.execution.phase === 'sending')
        .length,
    };
  }
}
