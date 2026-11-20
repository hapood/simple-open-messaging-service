import { TestBed } from '@angular/core/testing';
import { HttpClient } from '@angular/common/http';
import { NEVER, of, Subject, throwError } from 'rxjs';
import { MediaTransferService, type UploadTaskEvent, reduceUploadTasks } from './media-transfer.service';
import { ThreadSendOutbox } from './thread-send-outbox.service';
import { BrowserSendFiles } from './browser-send-files.service';
import { WebdbService } from './webdb.service';
import { SessionLifecycleService } from './session-lifecycle.service';
import { NativeUploadTransport } from './native-upload-transport.service';
import { WebUploadTransport } from './web-upload-transport';
import { MsgService } from './message.service';

async function harness() {
  const messages = {
    sendMedia: vi.fn(() => of({ code: 0 })),
    uploadPart: vi.fn((_file: File, _identity: unknown, progress?: (loaded: number, total: number) => void) => {
      progress?.(2, 4);
      return of({ code: 0 });
    }),
    cancelUploadBatch: vi.fn(() => of({ code: 0 })),
  };
  vi.spyOn(WebUploadTransport.prototype, 'upload').mockImplementation(messages.uploadPart as never);
  const quota = vi.fn(() => of({ code: 0, data: { breaker: { maxFileBytes: 100 } } }));
  TestBed.configureTestingModule({ providers: [
    { provide: MsgService, useValue: messages },
    { provide: HttpClient, useValue: { post: quota } },
    { provide: WebdbService, useValue: {
      enqueuePendingSend: vi.fn(async () => undefined),
      pendingSend: vi.fn(async (clientMessageId: string) => outbox.get(clientMessageId)?.task ?? null),
      removePendingSend: vi.fn(async () => undefined),
    } },
  ] });
  const files = TestBed.inject(BrowserSendFiles);
  const outbox = TestBed.inject(ThreadSendOutbox);
  const service = TestBed.inject(MediaTransferService);
  const file = files.retain(new File(['test'], 'test.txt', { type: 'text/plain' }), 'part');
  const task = { clientMessageId: 'cid', threadId: 9, item: { type: 'FILE' as const, file } };
  await outbox.enqueue(task);
  return { messages, quota, files, outbox, service, task };
}

describe('service-owned Web upload execution', () => {
  afterEach(() => vi.restoreAllMocks());
  it('publishes an immediate thread snapshot followed by isolated deltas', async () => {
    const h = await harness();
    const events: UploadTaskEvent[] = [];
    const subscription = h.service.watchThread(9).subscribe(event => events.push(event));
    expect(events).toEqual([{ type: 'snapshot', tasks: [h.outbox.get('cid')] }]);
    TestBed.tick();
    expect(events).toHaveLength(1);
    await h.outbox.enqueue({ ...h.task, clientMessageId: 'other', threadId: 10 });
    TestBed.tick();
    expect(events).toHaveLength(1);
    h.service.start('cid', 4);
    h.service.progress('cid', 2, 4);
    TestBed.tick();
    expect(events.at(-1)).toMatchObject({ type: 'upsert', task: { execution: { loaded: 2 } } });
    const displayed = events.reduce(reduceUploadTasks, [] as readonly import('./thread-send-outbox.service').SendingTask[]);
    expect(displayed).toEqual([h.outbox.get('cid')]);
    subscription.unsubscribe();
    const resumed: UploadTaskEvent[] = [];
    const next = h.service.watchThread(9).subscribe(event => resumed.push(event));
    expect(resumed).toEqual([{ type: 'snapshot', tasks: [h.outbox.get('cid')] }]);
    next.unsubscribe();
  });

  it('publishes removal only after durable deletion succeeds', async () => {
    const h = await harness();
    const events: UploadTaskEvent[] = [];
    const subscription = h.service.watchThread(9).subscribe(event => events.push(event));
    const database = TestBed.inject(WebdbService);
    let finish!: () => void;
    vi.mocked(database.removePendingSend).mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
    const removal = h.outbox.remove('cid');
    await vi.waitFor(() => expect(database.removePendingSend).toHaveBeenCalled());
    TestBed.tick();
    expect(events).toHaveLength(1);
    finish();
    await removal;
    TestBed.tick();
    expect(events.at(-1)).toEqual({ type: 'remove', clientMessageId: 'cid' });
    subscription.unsubscribe();
  });

  it('retains the task when durable deletion fails', async () => {
    const h = await harness();
    const events: UploadTaskEvent[] = [];
    const subscription = h.service.watchThread(9).subscribe(event => events.push(event));
    vi.mocked(TestBed.inject(WebdbService).removePendingSend).mockRejectedValue(new Error('disk unavailable'));
    await expect(h.outbox.remove('cid')).rejects.toThrow('disk unavailable');
    TestBed.tick();
    expect(events).toHaveLength(1);
    expect(h.outbox.get('cid')).toBeDefined();
    subscription.unsubscribe();
  });

  it('does not regress a new subscriber to an older replayed value', async () => {
    const h = await harness();
    const first = h.service.watchThread(9).subscribe();
    TestBed.tick();
    h.service.start('cid', 4);
    h.service.progress('cid', 3, 4);
    const events: UploadTaskEvent[] = [];
    const second = h.service.watchThread(9).subscribe(event => events.push(event));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'snapshot', tasks: [{ execution: { loaded: 3 } }] });
    TestBed.tick();
    expect(events).toHaveLength(1);
    first.unsubscribe();
    second.unsubscribe();
  });

  it('observes writes made from the initial snapshot callback', async () => {
    const h = await harness();
    const events: UploadTaskEvent[] = [];
    const subscription = h.service.watchThread(9).subscribe(event => {
      events.push(event);
      if (event.type === 'snapshot') h.service.start('cid', 4);
    });
    TestBed.tick();
    expect(events[0].type).toBe('snapshot');
    expect(events.at(-1)).toMatchObject({ type: 'upsert', task: { execution: { total: 4 } } });
    subscription.unsubscribe();
  });

  it('aborts an old session without publishing into a replacement task', async () => {
    const h = await harness();
    const response = new Subject<{ code: number }>();
    h.messages.uploadPart.mockReturnValue(response);
    const running = h.service.executeWeb(h.task);
    const rejected = expect(running).rejects.toThrow();
    await vi.waitFor(() => expect(h.messages.uploadPart).toHaveBeenCalledOnce());
    TestBed.inject(SessionLifecycleService).invalidateSession();
    await h.outbox.enqueue(h.task);
    await rejected;
    expect(response.observed).toBe(false);
    expect(h.outbox.get('cid')?.execution).toMatchObject({ phase: 'sending', loaded: 0, failure: null });
  });

  it('stops gallery siblings locally on failure and preserves server parts', async () => {
    const h = await harness();
    const first = new Subject<{ code: number }>();
    const second = new Subject<{ code: number }>();
    const file = h.files.retain(new File(['next'], 'next.txt'), 'second');
    const task = { ...h.task, item: { type: 'GALLERY' as const, files: [
      { ...h.task.item.file, intent: 'IMAGE' as const }, { ...file, intent: 'IMAGE' as const },
    ] } };
    await h.outbox.enqueue(task);
    h.messages.uploadPart.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const running = h.service.executeWeb(task);
    const rejected = expect(running).rejects.toThrow();
    await vi.waitFor(() => expect(h.messages.uploadPart).toHaveBeenCalledTimes(2));
    second.error(new Error('second part failed'));
    await rejected;
    expect(first.observed).toBe(false);
    expect(h.messages.cancelUploadBatch).not.toHaveBeenCalled();
    expect(h.outbox.get('cid')?.execution).toMatchObject({ phase: 'failed', failure: { kind: 'transport', message: 'second part failed' } });
  });

  it('cancels quota preflight without staging or replacing cancellation with a transport error', async () => {
    const h = await harness();
    const quota = new Subject<{ code: number; data: { breaker: { maxFileBytes: number } } }>();
    h.quota.mockReturnValue(quota);
    const running = h.service.executeWeb(h.task);
    const rejected = expect(running).rejects.toThrow();
    await h.service.cancel('cid');
    await rejected;
    expect(quota.observed).toBe(false);
    expect(h.messages.sendMedia).not.toHaveBeenCalled();
    expect(h.outbox.get('cid')?.execution).toMatchObject({ phase: 'failed', failure: null });
  });

  it('starts a new-session execution without reusing the old promise', async () => {
    const h = await harness();
    const response = new Subject<{ code: number }>();
    h.messages.uploadPart.mockReturnValueOnce(response);
    const old = h.service.executeWeb(h.task);
    const rejected = expect(old).rejects.toThrow();
    await vi.waitFor(() => expect(h.messages.uploadPart).toHaveBeenCalledOnce());
    TestBed.inject(SessionLifecycleService).invalidateSession();
    const replacement = { ...h.task, item: { ...h.task.item, file: h.files.retain(new File(['next'], 'next.txt'), 'part') } };
    await h.outbox.enqueue(replacement);
    const current = h.service.executeWeb(replacement);
    expect(current).not.toBe(old);
    await rejected;
    await current;
    expect(h.messages.uploadPart).toHaveBeenCalledTimes(2);
    expect(h.outbox.get('cid')).toBeUndefined();
  });

  it('opens every native gallery resource before staging and skips staging when one is unavailable', async () => {
    const h = await harness();
    const prepare = vi.spyOn(NativeUploadTransport.prototype, 'prepare').mockRejectedValue(new Error('Attachment unavailable. Please cancel and upload again.'));
    const release = vi.spyOn(NativeUploadTransport.prototype, 'release').mockResolvedValue();
    const task = {
      clientMessageId: 'gallery', threadId: 9,
      item: { type: 'GALLERY' as const, files: [
        { path: 'content://one', partId: 'a', name: 'a.jpg', mimeType: 'image/jpeg', size: 1, intent: 'IMAGE' as const },
        { path: 'content://two', partId: 'b', name: 'b.jpg', mimeType: 'image/jpeg', size: 2, intent: 'IMAGE' as const },
      ] },
    };
    await h.outbox.enqueue(task);
    await expect(h.service.executeNative(task)).rejects.toThrow('Attachment unavailable');
    expect(prepare).toHaveBeenCalledWith('gallery', [
      { partId: 'a', path: 'content://one', size: 1 },
      { partId: 'b', path: 'content://two', size: 2 },
    ]);
    expect(h.messages.sendMedia).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith('gallery');
    expect(h.outbox.get('gallery')?.execution).toMatchObject({ kind: 'attachment', failure: { kind: 'attachment-unavailable' } });
  });

  it('executes persisted native references through the Channel transport without a File registry', async () => {
    const h = await harness();
    vi.spyOn(NativeUploadTransport.prototype, 'prepare').mockResolvedValue();
    vi.spyOn(NativeUploadTransport.prototype, 'release').mockResolvedValue();
    const upload = vi.spyOn(NativeUploadTransport.prototype, 'upload').mockReturnValue(of({ code: 0, message: 'success', data: {} }));
    const task = { ...h.task, item: { ...h.task.item, file: { ...h.task.item.file, path: 'content://provider/document/42' } } };
    await h.outbox.enqueue(task);
    await h.service.executeNative(task);
    expect(upload).toHaveBeenCalledWith(task.item.file, { clientMessageId: 'cid', partId: 'part', position: 0, intent: 'FILE' }, expect.any(Function));
    expect(h.messages.uploadPart).not.toHaveBeenCalled();
    expect(h.outbox.get('cid')).toBeUndefined();
  });

  it('deletes the intent only after the upload response succeeds', async () => {
    const h = await harness();
    const response = new Subject<{ code: number }>();
    h.messages.uploadPart.mockImplementation((_file, _identity, progress) => {
      progress?.(4, 4);
      return response;
    });
    const running = h.service.executeWeb(h.task);
    await vi.waitFor(() => expect(h.messages.uploadPart).toHaveBeenCalledOnce());
    expect(h.outbox.get('cid')?.execution).toMatchObject({ loaded: 4, phase: 'sending' });
    expect(h.messages.uploadPart.mock.calls[0][1]).toEqual({ clientMessageId: 'cid', partId: 'part', position: 0, intent: 'FILE' });
    response.next({ code: 0 });
    response.complete();
    await running;
    expect(h.outbox.get('cid')).toBeUndefined();
  });

  it('keeps failure details and last progress without cancelling server parts', async () => {
    const h = await harness();
    h.messages.uploadPart.mockImplementation((_file, _identity, progress) => {
      progress?.(2, 4);
      return throwError(() => new Error('connection lost'));
    });
    await expect(h.service.executeWeb(h.task)).rejects.toThrow('connection lost');
    expect(h.outbox.get('cid')?.execution).toMatchObject({ phase: 'failed', loaded: 2, failure: { kind: 'transport', message: 'connection lost' } });
    expect(h.messages.cancelUploadBatch).not.toHaveBeenCalled();
  });

  it('resolves all gallery resources before any requests', async () => {
    const h = await harness();
    const missing = { ...h.task.item.file, path: 'missing', partId: 'second', intent: 'IMAGE' as const };
    const task = { ...h.task, item: { type: 'GALLERY' as const, files: [{ ...h.task.item.file, intent: 'IMAGE' as const }, missing] } };
    await h.outbox.enqueue(task);
    await expect(h.service.executeWeb(task)).rejects.toThrow();
    expect(h.quota).not.toHaveBeenCalled();
    expect(h.messages.sendMedia).not.toHaveBeenCalled();
    expect(h.outbox.get('cid')?.execution).toMatchObject({ failure: { kind: 'attachment-unavailable' } });
  });

  it('rejects excessive size before staging', async () => {
    const h = await harness();
    h.quota.mockReturnValue(of({ code: 0, data: { breaker: { maxFileBytes: 3 } } }));
    await expect(h.service.executeWeb(h.task)).rejects.toThrow();
    expect(h.messages.sendMedia).not.toHaveBeenCalled();
    expect(h.outbox.get('cid')?.execution).toMatchObject({ failure: { kind: 'size-limit', limit: 3 } });
  });

  it('deduplicates active execution and display unsubscription does not cancel it', async () => {
    const h = await harness();
    const result = new Subject<{ code: number }>();
    h.messages.uploadPart.mockReturnValue(result);
    const subscription = h.service.watchThread(9).subscribe();
    const running = h.service.executeWeb(h.task);
    expect(h.service.executeWeb(h.task)).toBe(running);
    subscription.unsubscribe();
    await vi.waitFor(() => expect(h.messages.uploadPart).toHaveBeenCalledOnce());
    expect(h.service.isUploading('cid')).toBe(true);
    result.next({ code: 0 });
    await running;
    expect(h.messages.cancelUploadBatch).not.toHaveBeenCalled();
  });
});
