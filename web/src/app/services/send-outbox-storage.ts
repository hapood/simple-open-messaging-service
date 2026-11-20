import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

export interface StoredSendFile {
  partId: string;
  name: string;
  /** Exact MIME supplied to upload admission, including its original fallback. */
  mimeType: string;
  /** Browser runtime lookup key or original native path/resource URI; resolved by the host without copying. */
  path: string;
  size: number;
}

export type StoredNonMediaSendContent =
  | { type: 'PURE_TEXT'; content: string }
  | { type: 'LINK'; generationId: string }
  | { type: 'CONTACT_CARD'; target: { account: string; namespaceId: number; profileRev: number } }
  | { type: 'FORWARD'; sourceMessages: { threadId: number; seq: number }[]; mode: 'DIRECT' | 'HISTORY' };

export type StoredSendContent<File = StoredSendFile> =
  | StoredNonMediaSendContent
  | { type: 'IMAGE' | 'VIDEO' | 'AUDIO' | 'FILE'; file: File }
  | { type: 'GALLERY'; files: (File & { intent: 'IMAGE' | 'VIDEO' | 'AUDIO' | 'FILE' })[] };

/** Presence means unconfirmed. Execution phase exists only in the runtime view. */
export interface StoredSendTask<File = StoredSendFile> {
  clientMessageId: string;
  threadId: number;
  item: StoredSendContent<File>;
}

interface SendOutboxSchema extends DBSchema {
  pendingSends: { key: string; value: StoredSendTask };
}

/** Durable user-authored data, separate from disposable message/profile cache schemas. */
export class BrowserSendOutboxStorage {
  private constructor(private readonly db: IDBPDatabase<SendOutboxSchema>) {}

  /** Database naming and lifetime belong to the existing database manager. */
  static async open(databaseName: string): Promise<BrowserSendOutboxStorage> {
    const db = await openDB<SendOutboxSchema>(databaseName, 1, {
      upgrade(db) {
        db.createObjectStore('pendingSends', { keyPath: 'clientMessageId' });
      },
    });
    return new BrowserSendOutboxStorage(db);
  }

  /** Persist request metadata only; browser file handles belong to the runtime resource owner. */
  async enqueue(task: StoredSendTask): Promise<void> {
    const item = task.item;
    const files = item.type === 'GALLERY' ? item.files : 'file' in item ? [item.file] : [];
    for (const file of files) {
      if ('blob' in file || typeof file.path !== 'string' || !file.path)
        throw new Error('pending attachment requires metadata and a runtime reference, not file bytes');
    }
    await this.db.add('pendingSends', task);
  }

  async get(clientMessageId: string): Promise<StoredSendTask | undefined> {
    return this.db.get('pendingSends', clientMessageId);
  }

  async list(): Promise<StoredSendTask[]> {
    return this.db.getAll('pendingSends');
  }

  async remove(clientMessageId: string): Promise<void> {
    await this.db.delete('pendingSends', clientMessageId);
  }

  async clear(): Promise<void> {
    await this.db.clear('pendingSends');
  }

  close(): void { this.db.close(); }
}
