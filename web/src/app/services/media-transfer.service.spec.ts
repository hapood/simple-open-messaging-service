import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { of, from, throwError } from 'rxjs';
import { MsgService } from './message.service';
import { MediaTransferService } from './media-transfer.service';
import { ThreadSendOutbox } from './thread-send-outbox.service';
import { WebdbService } from './webdb.service';

describe('attachment execution over durable tasks', () => {
  let outbox: ThreadSendOutbox;
  let service: MediaTransferService;
  let remove: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    remove = vi.fn().mockResolvedValue(undefined);
    TestBed.configureTestingModule({ providers: [
      provideHttpClient(),
      { provide: MsgService, useValue: { cancelUploadBatch: vi.fn(() => of({ code: 0 })), sendCompletedUploadBatch: vi.fn(() => of({ code: 0, data: { sent: true } })) } },
      { provide: WebdbService, useValue: {
      pendingSend: vi.fn(async (cid: string) => outbox.get(cid)?.task ?? null),
      enqueuePendingSend: vi.fn().mockResolvedValue(undefined),
      removePendingSend: remove,
    } }] });
    outbox = TestBed.inject(ThreadSendOutbox);
    service = TestBed.inject(MediaTransferService);
  });

  async function enqueue(): Promise<void> {
    await outbox.enqueue({ clientMessageId: 'cid', threadId: 1, item: {
      type: 'FILE', file: { partId: 'part', path: 'runtime-file', size: 4, name: 'file', mimeType: 'application/octet-stream' },
    } });
  }

  it('sends completed parts of a recovered gallery without resolving local files or cancelling the batch', async () => {
    await outbox.enqueue({ clientMessageId: 'gallery', threadId: 1, item: { type: 'GALLERY', files: [
      { path: 'lost-runtime-file', partId: 'part', name: 'file', size: 4, mimeType: 'application/octet-stream', intent: 'FILE' },
    ] } });
    outbox.setPhase('gallery', 'failed');
    const stopLocal = vi.fn();
    service.registerLocalStop('gallery', stopLocal);
    expect(service.canSendCompleted('gallery')).toBe(true);
    await service.sendCompleted('gallery');
    expect(TestBed.inject(MsgService).sendCompletedUploadBatch).toHaveBeenCalledWith('gallery');
    expect(stopLocal).toHaveBeenCalledOnce();
    expect(TestBed.inject(MsgService).cancelUploadBatch).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith('gallery');
    expect(outbox.get('gallery')).toBeUndefined();
  });

  it('does not mark accepted when the server has no completed parts to send', async () => {
    await outbox.enqueue({ clientMessageId: 'empty-gallery', threadId: 1, item: { type: 'GALLERY', files: [
      { path: 'unavailable', partId: 'part', name: 'file', size: 4, mimeType: 'application/octet-stream', intent: 'FILE' },
    ] } });
    vi.mocked(TestBed.inject(MsgService).sendCompletedUploadBatch).mockReturnValue(of({ code: 0, message: 'ok', data: { clientMessageId: 'empty-gallery', sent: false, completed: 0 } }));
    await service.sendCompleted('empty-gallery');
    expect(outbox.get('empty-gallery')?.execution.phase).toBe('failed');
    expect(remove).not.toHaveBeenCalled();
  });

  it('refuses to create an upload without a durable attachment intent', () => {
    expect(() => service.start('missing', 100)).toThrow('persisted attachment intent');
    expect(outbox.tasks()).toEqual([]);
  });

  it('preserves the last displayed bytes when an upload fails', async () => {
    await enqueue();
    service.start('cid', 100);
    service.progress('cid', 73, 100);
    service.fail('cid');
    expect(outbox.get('cid')?.execution).toMatchObject({ phase: 'failed', loaded: 73, total: 100 });
    expect(remove).not.toHaveBeenCalled();
  });

  it('normalizes transport progress and keeps upload completion unconfirmed', async () => {
    await enqueue();
    service.start('cid', 100);
    service.progress('cid', 60, 120);
    expect(outbox.get('cid')?.execution).toMatchObject({ loaded: 50, total: 100, phase: 'sending' });
    service.progress('cid', 30, 120);
    expect(outbox.get('cid')?.execution).toMatchObject({ loaded: 50 });
    expect(remove).not.toHaveBeenCalled();
  });

  it('stops execution and deletes the intent before releasing files', async () => {
    await enqueue();
    service.start('cid', 100);
    const order: string[] = [];
    service.cancelled('cid').subscribe(() => order.push('stop'));
    remove.mockImplementation(async () => { order.push('delete'); });
    service.registerDiscard('cid', async () => { order.push('release'); });
    await service.discard('cid');
    expect(order).toEqual(['stop', 'delete', 'release']);
    expect(outbox.tasks()).toEqual([]);
  });

  it('waits for asynchronous cancellation before deleting the intent', async () => {
    await enqueue();
    service.start('cid', 100);
    let finish!: () => void;
    vi.mocked(TestBed.inject(MsgService).cancelUploadBatch).mockReturnValue(from(new Promise<{ code: number; message: string; data: { clientMessageId: string; cancelled: number } }>(resolve => { finish = () => resolve({ code: 0, message: 'ok', data: { clientMessageId: 'cid', cancelled: 1 } }); })));
    const pending = service.discard('cid');
    await Promise.resolve();
    expect(remove).not.toHaveBeenCalled();
    finish();
    await pending;
    expect(remove).toHaveBeenCalledWith('cid');
  });

  it('marks stopped before cancellation observers run and cancels the batch once', async () => {
    await enqueue();
    service.start('cid', 100);
    service.cancelled('cid').subscribe(() => {
      expect(service.isUploading('cid')).toBe(false);
      void service.cancel('cid');
    });
    await service.cancel('cid');
    expect(TestBed.inject(MsgService).cancelUploadBatch).toHaveBeenCalledExactlyOnceWith('cid');
    expect(outbox.get('cid')?.execution.phase).toBe('failed');
  });

  it('does not delete the intent if asynchronous cancellation fails', async () => {
    await enqueue();
    service.start('cid', 100);
    vi.mocked(TestBed.inject(MsgService).cancelUploadBatch).mockReturnValue(throwError(() => new Error('cancel failed')));
    await expect(service.discard('cid')).rejects.toThrow('cancel failed');
    expect(remove).not.toHaveBeenCalled();
    expect(outbox.get('cid')?.execution.phase).toBe('failed');
  });

  it('does not release a referenced file when durable deletion fails', async () => {
    await enqueue();
    service.start('cid', 100);
    const release = vi.fn();
    service.registerDiscard('cid', release);
    remove.mockRejectedValue(new Error('database busy'));
    await expect(service.discard('cid')).rejects.toThrow('database busy');
    expect(release).not.toHaveBeenCalled();
    expect(outbox.get('cid')?.execution.phase).toBe('failed');
    expect(service.isUploading('cid')).toBe(false);
  });
});
