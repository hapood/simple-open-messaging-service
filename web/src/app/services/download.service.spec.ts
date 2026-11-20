import { SessionLifecycleService } from './session-lifecycle.service';
import { TestBed } from '@angular/core/testing';
import { WebdbService } from './webdb.service';
import { BrowserDownloadAdapter, DOWNLOAD_ADAPTER, DownloadService, type DownloadAdapter, type DownloadTaskEvent } from './download.service';

const request = { threadId: 10, path: '/uploads/file.bin', filename: 'file.bin', mimeType: 'application/octet-stream' };

describe('browser download delegation', () => {
  afterEach(() => vi.restoreAllMocks());

  it('clicks synchronously without fetching a Blob and removes its anchor', async () => {
    const fetchSpy = vi.spyOn(window, 'fetch');
    const objectUrl = vi.spyOn(URL, 'createObjectURL');
    let clicked = false;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked = true;
      expect(this.isConnected).toBe(true);
      expect(this.download).toBe('file.bin');
      expect(this.href).toContain('/uploads/file.bin');
    });
    TestBed.configureTestingModule({ providers: [{ provide: DOWNLOAD_ADAPTER, useValue: new BrowserDownloadAdapter() }] });
    const pending = TestBed.inject(DownloadService).download(request);
    expect(clicked).toBe(true);
    expect(document.querySelector('a[download="file.bin"]')).toBeNull();
    await pending;
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(objectUrl).not.toHaveBeenCalled();
  });

  it('keeps browser subscriptions empty even after delegation', async () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    TestBed.configureTestingModule({ providers: [{ provide: DOWNLOAD_ADAPTER, useValue: new BrowserDownloadAdapter() }] });
    const service = TestBed.inject(DownloadService);
    const events: DownloadTaskEvent[] = [];
    const subscription = service.watchThread(10).subscribe(event => events.push(event));
    await service.download(request);
    expect(events).toEqual([{ type: 'snapshot', tasks: [] }]);
    subscription.unsubscribe();
  });

  it('publishes native progress and failure only to its owning thread', async () => {
    let publish!: Parameters<DownloadAdapter['download']>[2];
    let reject!: (error: Error) => void;
    const adapter: DownloadAdapter = { download: (_request, _signal, callback) => {
      publish = callback;
      return new Promise((_resolve, fail) => { reject = fail; });
    } };
    TestBed.configureTestingModule({ providers: [{ provide: DOWNLOAD_ADAPTER, useValue: adapter }] });
    const service = TestBed.inject(DownloadService);
    const events: DownloadTaskEvent[] = [];
    const other: DownloadTaskEvent[] = [];
    const first = service.watchThread(10).subscribe(event => events.push(event));
    const second = service.watchThread(20).subscribe(event => other.push(event));
    const running = service.download(request);
    const rejected = expect(running).rejects.toThrow('offline');
    publish({ loaded: 42, total: 100, phase: 'downloading', error: null });
    reject(new Error('offline'));
    await rejected;
    expect(other).toEqual([{ type: 'snapshot', tasks: [] }]);
    expect(events.at(-1)).toMatchObject({ type: 'upsert', task: { loaded: 42, phase: 'failed', error: 'offline' } });
    const last = events.at(-1)!;
    if (last.type !== 'upsert') throw new Error('missing task');
    service.dismiss(last.task.id);
    expect(events.at(-1)).toEqual({ type: 'remove', id: last.task.id });
    first.unsubscribe(); second.unsubscribe();
  });

  it('removes session tasks and ignores late adapter completion', async () => {
    let publish!: Parameters<DownloadAdapter['download']>[2];
    let finish!: () => void;
    let signal!: AbortSignal;
    TestBed.configureTestingModule({ providers: [{ provide: DOWNLOAD_ADAPTER, useValue: {
      download: (_request: unknown, abort: AbortSignal, callback: typeof publish) => {
        signal = abort; publish = callback;
        return new Promise<void>(resolve => { finish = resolve; });
      },
    } }] });
    const service = TestBed.inject(DownloadService);
    const events: DownloadTaskEvent[] = [];
    const subscription = service.watchThread(10).subscribe(event => events.push(event));
    const running = service.download(request);
    publish({ loaded: 1, total: 10, phase: 'downloading', error: null });
    TestBed.inject(SessionLifecycleService).invalidateSession();
    expect(signal.aborted).toBe(true);
    expect(events.at(-1)?.type).toBe('remove');
    const count = events.length;
    publish({ loaded: 10, total: 10, phase: 'completed', error: null });
    finish(); await running;
    expect(events).toHaveLength(count);
    subscription.unsubscribe();
  });

  it('delivers reentrant updates after the initial snapshot', async () => {
    TestBed.configureTestingModule({ providers: [{ provide: DOWNLOAD_ADAPTER, useValue: {
      download: (_request: unknown, _signal: AbortSignal, publish: Parameters<DownloadAdapter['download']>[2]) => {
        publish({ loaded: 0, total: null, phase: 'downloading', error: null });
        return Promise.resolve();
      },
    } }] });
    const service = TestBed.inject(DownloadService);
    const events: DownloadTaskEvent[] = [];
    const subscription = service.watchThread(10).subscribe(event => {
      events.push(event);
      if (event.type === 'snapshot') void service.download(request);
    });
    expect(events.map(event => event.type)).toEqual(['snapshot', 'upsert']);
    subscription.unsubscribe();
  });

  it('cancels active downloads but leaves OS saving to its platform result', async () => {
    let publish!: Parameters<DownloadAdapter['download']>[2];
    let signal!: AbortSignal;
    let finish!: () => void;
    TestBed.configureTestingModule({ providers: [{ provide: DOWNLOAD_ADAPTER, useValue: {
      download: (_request: unknown, abort: AbortSignal, callback: typeof publish) => {
        signal = abort; publish = callback;
        return new Promise<void>(resolve => { finish = resolve; });
      },
    } }] });
    const service = TestBed.inject(DownloadService);
    const events: DownloadTaskEvent[] = [];
    const subscription = service.watchThread(10).subscribe(event => events.push(event));
    const running = service.download(request);
    publish({ loaded: 10, total: 10, phase: 'saving', error: null });
    const saved = events.at(-1)!;
    if (saved.type !== 'upsert') throw new Error('missing task');
    service.cancel(saved.task.id);
    expect(signal.aborted).toBe(false);
    expect(events.at(-1)).toBe(saved);
    publish({ loaded: 10, total: 10, phase: 'completed', error: null });
    finish(); await running;
    service.dismiss(saved.task.id);
    expect(events.at(-1)).toEqual({ type: 'remove', id: saved.task.id });
    const second = service.download(request);
    publish({ loaded: 2, total: 10, phase: 'downloading', error: null });
    const active = events.at(-1)!;
    if (active.type !== 'upsert') throw new Error('missing task');
    service.cancel(active.task.id);
    expect(signal.aborted).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'remove', id: active.task.id });
    publish({ loaded: 10, total: 10, phase: 'completed', error: null });
    expect(events.at(-1)?.type).toBe('remove');
    finish(); await second;
    subscription.unsubscribe();
  });

  it('retains a failed save and retries under the same task identity', async () => {
    const download = vi.fn<DownloadAdapter['download']>();
    download.mockImplementationOnce(async (_request, _signal, publish) => {
      publish({ loaded: 100, total: 100, phase: 'saving', error: null });
      throw new Error('storage full');
    });
    download.mockImplementationOnce(async (_request, _signal, publish) => {
      publish({ loaded: 100, total: 100, phase: 'saving', error: null });
      publish({ loaded: 100, total: 100, phase: 'completed', error: null });
    });
    TestBed.configureTestingModule({ providers: [{ provide: DOWNLOAD_ADAPTER, useValue: { download } }] });
    const service = TestBed.inject(DownloadService);
    const events: DownloadTaskEvent[] = [];
    const subscription = service.watchThread(10).subscribe(event => events.push(event));
    await expect(service.download(request)).rejects.toThrow('storage full');
    const failed = events.at(-1)!;
    if (failed.type !== 'upsert') throw new Error('missing task');
    expect(failed.task).toMatchObject({ loaded: 100, phase: 'failed', error: 'storage full' });
    await service.retry(failed.task.id);
    expect(events.at(-1)).toMatchObject({ type: 'upsert', task: { id: failed.task.id, phase: 'completed', error: null } });
    expect(download).toHaveBeenCalledTimes(2);
    expect(events.some(event => event.type === 'remove')).toBe(false);
    subscription.unsubscribe();
  });

  it('forwards resource metadata without returning platform discriminators', async () => {
    const download = vi.fn(async () => undefined);
    TestBed.configureTestingModule({ providers: [{ provide: DOWNLOAD_ADAPTER, useValue: { download } }] });
    await expect(TestBed.inject(DownloadService).download(request)).resolves.toBeUndefined();
    expect(download).toHaveBeenCalledWith(request, expect.any(AbortSignal), expect.any(Function));
  });

  it('clears saved history and keeps an in-progress download', async () => {
    let release!: () => void;
    const records = new Map<string, { destination: string | null }>();
    const download = vi.fn(async (item: { filename: string }, _signal: AbortSignal, publish: (update: { loaded: number; total: number | null; phase: 'downloading' | 'completed'; error: string | null; destination?: string }) => void) => {
      if (item.filename === 'done.bin') {
        publish({ loaded: 2, total: 2, phase: 'completed', error: null, destination: '/tmp/done.bin' });
        return;
      }
      publish({ loaded: 1, total: 2, phase: 'downloading', error: null });
      await new Promise<void>(resolve => { release = resolve; });
    });
    TestBed.configureTestingModule({ providers: [
      { provide: DOWNLOAD_ADAPTER, useValue: { download } },
      { provide: WebdbService, useValue: {
        downloadRecords: vi.fn(async () => []),
        putDownloadRecord: vi.fn(async (record: { id: string; destination: string | null }) => { records.set(record.id, record); }),
        removeDownloadRecord: vi.fn(async (id: string) => { records.delete(id); }),
        clearDownloadRecords: vi.fn(async () => { records.clear(); return ['content://saved']; }),
      } },
    ] });
    const service = TestBed.inject(DownloadService);
    const events: DownloadTaskEvent[] = [];
    service.watchAll().subscribe(event => events.push(event));
    const running = service.download(request);
    await service.download({ ...request, filename: 'done.bin' });
    await vi.waitFor(() => expect(records.size).toBe(1));
    await service.clearHistory(true);
    expect(records.size).toBe(0);
    const removed = events.flatMap(event => event.type === 'remove' ? [event.id] : []);
    const active = events.find(event => event.type === 'upsert' && event.task.phase === 'downloading');
    expect(active?.type === 'upsert' && removed.includes(active.task.id)).toBe(false);
    release();
    await running;
  });
});
