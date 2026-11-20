import { isTauri } from '../../services/runtime';
import type { ThreadSendOutbox } from '../../services/thread-send-outbox.service';
import type {
  StoredNonMediaSendContent,
  StoredSendContent,
  StoredSendFile,
} from '../../services/send-outbox-storage';

type MediaContent<File> = Exclude<StoredSendContent<File>, StoredNonMediaSendContent>;
type RetryTask<Content> = { clientMessageId: string; threadId: number; item: Content };

export interface ThreadSendRetryHandlers {
  message(task: RetryTask<StoredNonMediaSendContent>): Promise<void>;
  webAttachment(task: RetryTask<MediaContent<StoredSendFile>>): Promise<void>;
  nativeAttachment(task: RetryTask<MediaContent<StoredSendFile>>): Promise<void>;
}

/** Manual retry uses the durable request, never a rendered card or a retained closure. */
export class ThreadSendRetryController {
  constructor(
    private readonly outbox: ThreadSendOutbox,
    private readonly handlers: ThreadSendRetryHandlers,
  ) {}

  async retry(clientMessageId: string): Promise<void> {
    const task = await this.outbox.retry(clientMessageId);
    if (!task) return;
    try {
      const item = task.item;
      if (!('file' in item) && item.type !== 'GALLERY') {
        await this.handlers.message({ ...task, item });
        return;
      }
      const files = item.type === 'GALLERY' ? item.files : [item.file];
      if (files.length === 0) throw new Error('attachment task has no files');
      if (isTauri()) await this.handlers.nativeAttachment({ ...task, item });
      else await this.handlers.webAttachment({ ...task, item });
    } catch (error) {
      this.outbox.setPhase(clientMessageId, 'failed');
      throw error;
    }
  }
}
