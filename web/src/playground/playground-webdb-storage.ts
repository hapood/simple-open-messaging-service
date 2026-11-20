import { WebdbStorage } from '../app/services/webdb-storage';
import type { StoredSendTask } from '../app/services/send-outbox-storage';
import type { StoredDownloadRecord } from '../app/services/download-history-storage';

/** Playground downloads have no authenticated account or durable production history. */
export class PlaygroundWebdbStorage extends WebdbStorage {
  private readonly sends = new Map<string, StoredSendTask>();

  override async enqueuePendingSend(task: StoredSendTask): Promise<void> {
    this.sends.set(task.clientMessageId, structuredClone(task));
  }

  override async pendingSend(id: string): Promise<StoredSendTask | null> {
    return structuredClone(this.sends.get(id) ?? null);
  }

  override async pendingSends(): Promise<StoredSendTask[]> {
    return structuredClone([...this.sends.values()]);
  }

  override async removePendingSend(id: string): Promise<void> {
    this.sends.delete(id);
  }

  override async clearPendingSends(): Promise<void> {
    this.sends.clear();
  }

  private readonly downloadHistory = new Map<string, StoredDownloadRecord>();

  override async downloadRecords(): Promise<StoredDownloadRecord[]> {
    return [...this.downloadHistory.values()].map(record => ({ ...record }));
  }

  override async putDownloadRecord(record: StoredDownloadRecord): Promise<void> {
    this.downloadHistory.set(record.id, { ...record });
  }

  override async removeDownloadRecord(id: string): Promise<void> {
    this.downloadHistory.delete(id);
  }

  override async clearDownloadRecords(_deleteFiles: boolean): Promise<string[]> {
    this.downloadHistory.clear();
    return [];
  }
}
