import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

export interface StoredDownloadRecord {
  id: string;
  threadId: number;
  path: string;
  filename: string;
  mimeType: string;
  phase: 'completed' | 'failed';
  error: string | null;
  destination: string | null;
  loaded: number;
  total: number | null;
}

interface DownloadHistorySchema extends DBSchema {
  downloadHistory: { key: string; value: StoredDownloadRecord };
}

/** Account-owned download history, separate from the disposable message cache. */
export class BrowserDownloadHistoryStorage {
  private constructor(private readonly db: IDBPDatabase<DownloadHistorySchema>) {}

  static async open(databaseName: string): Promise<BrowserDownloadHistoryStorage> {
    const db = await openDB<DownloadHistorySchema>(databaseName, 1, {
      upgrade(db) {
        db.createObjectStore('downloadHistory', { keyPath: 'id' });
      },
    });
    return new BrowserDownloadHistoryStorage(db);
  }

  async put(record: StoredDownloadRecord): Promise<void> {
    await this.db.put('downloadHistory', record);
  }

  async list(): Promise<StoredDownloadRecord[]> {
    return this.db.getAll('downloadHistory');
  }

  async remove(id: string): Promise<void> {
    await this.db.delete('downloadHistory', id);
  }

  async clear(): Promise<StoredDownloadRecord[]> {
    const records = await this.list();
    await this.db.clear('downloadHistory');
    return records;
  }

  close(): void { this.db.close(); }
}
