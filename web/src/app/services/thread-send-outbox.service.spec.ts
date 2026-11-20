import { BrowserSendFiles } from './browser-send-files.service';
import { TestBed } from '@angular/core/testing';
import { failedMatchingIntentIds, ThreadSendOutbox, type PendingSendTask, type SendingTask } from './thread-send-outbox.service';
import { WebdbService } from './webdb.service';
import { SessionLifecycleService } from './session-lifecycle.service';

const task: PendingSendTask = {
  clientMessageId: 'cid', threadId: 7,
  item: { type: 'LINK', generationId: 'original-generation' },
};

describe('durable sending task projection', () => {
  let outbox: ThreadSendOutbox;
  let lifecycle: SessionLifecycleService;
  let database: {
    enqueuePendingSend: ReturnType<typeof vi.fn>;
    pendingSends: ReturnType<typeof vi.fn>;
    pendingSend: ReturnType<typeof vi.fn>;
    removePendingSend: ReturnType<typeof vi.fn>;
    clearPendingSends: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    database = {
      enqueuePendingSend: vi.fn().mockResolvedValue(undefined),
      pendingSends: vi.fn().mockResolvedValue([task]),
      pendingSend: vi.fn().mockResolvedValue(task),
      removePendingSend: vi.fn().mockResolvedValue(undefined),
      clearPendingSends: vi.fn().mockResolvedValue(undefined),
    };
    TestBed.configureTestingModule({ providers: [{ provide: WebdbService, useValue: database }] });
    lifecycle = TestBed.inject(SessionLifecycleService);
    outbox = TestBed.inject(ThreadSendOutbox);
  });

  it('publishes only after durable admission completes', async () => {
    let commit!: () => void;
    database.enqueuePendingSend.mockReturnValue(new Promise<void>(resolve => { commit = resolve; }));
    const pending = outbox.enqueue(task);
    expect(outbox.tasks()).toEqual([]);
    commit();
    await pending;
    expect(outbox.tasks()).toEqual([{ task, execution: { kind: 'message', phase: 'sending' } }]);
    expect(database.enqueuePendingSend).toHaveBeenCalledWith(task);
  });

  it('admits attachment metadata and original upload identity as one complete intent', async () => {
    const attachment: PendingSendTask = {
      clientMessageId: 'attachment', threadId: 7,
      item: { type: 'FILE', file: { partId: 'original-part', path: 'runtime-file', size: 10, name: 'file.bin', mimeType: 'application/x-custom' } },
    };
    await outbox.enqueue(attachment);
    expect(database.enqueuePendingSend).toHaveBeenCalledWith(attachment);
    expect(outbox.get('attachment')).toEqual({ task: attachment, execution: {
      kind: 'attachment', phase: 'sending', loaded: 0, total: 0, startedAt: 0, failure: null,
    } });
  });

  it('does not create a task when persistence fails', async () => {
    database.enqueuePendingSend.mockRejectedValue(new Error('quota'));
    await expect(outbox.enqueue(task)).rejects.toThrow('quota');
    expect(outbox.tasks()).toEqual([]);
  });

  it('restores remaining rows as failed without writing or executing them', async () => {
    await outbox.restore();
    expect(outbox.forThread(7)).toEqual([{ task, execution: { kind: 'message', phase: 'failed' } }]);
    expect(outbox.forThread(8)).toEqual([]);
    expect(database.enqueuePendingSend).not.toHaveBeenCalled();
    expect(outbox.failures()).toHaveLength(1);
  });

  it('does not reset live execution on repeated restore but reloads after explicit recreation', async () => {
    await outbox.restore();
    outbox.setPhase('cid', 'sending');
    await outbox.restore();
    expect(database.pendingSends).toHaveBeenCalledTimes(1);
    expect(outbox.get('cid')?.execution.phase).toBe('sending');
    database.pendingSends.mockResolvedValue([]);
    await outbox.restore(true);
    expect(outbox.tasks()).toEqual([]);
  });

  it('retries the database request rather than a display-card snapshot', async () => {
    await outbox.restore();
    expect(await outbox.retry('cid')).toEqual(task);
    expect(database.pendingSend).toHaveBeenCalledWith('cid');
    expect(outbox.get('cid')?.execution.phase).toBe('sending');
    expect(database.enqueuePendingSend).not.toHaveBeenCalled();
  });

  it('confirms each identity once and does not delete another thread task', async () => {
    await outbox.restore();
    database.pendingSend.mockImplementation(async (cid: string) => cid === 'cid' ? task : { ...task, clientMessageId: cid, threadId: 8 });
    await outbox.confirm(7, ['cid', 'cid', 'other']);
    expect(database.removePendingSend).toHaveBeenCalledExactlyOnceWith('cid');
    expect(outbox.tasks()).toEqual([]);
  });

  it('releases browser files only after their durable record is removed', async () => {
    const files = TestBed.inject(BrowserSendFiles);
    const descriptor = files.retain(new File(['data'], 'file.bin'), 'part');
    const attachment: PendingSendTask = { clientMessageId: 'file', threadId: 7, item: { type: 'FILE', file: descriptor } };
    await outbox.enqueue(attachment);
    database.pendingSend.mockResolvedValue(attachment);
    database.removePendingSend.mockRejectedValueOnce(new Error('busy'));
    await expect(outbox.remove('file')).rejects.toThrow('busy');
    expect(files.resolve(descriptor).size).toBe(4);
    await outbox.remove('file');
    expect(() => files.resolve(descriptor)).toThrow('Please cancel and upload again');
  });

  it('releases unreferenced browser files after explicit full database recreation', async () => {
    const files = TestBed.inject(BrowserSendFiles);
    const descriptor = files.retain(new File(['data'], 'file.bin'), 'part');
    await outbox.enqueue({ clientMessageId: 'file', threadId: 7, item: { type: 'FILE', file: descriptor } });
    database.pendingSends.mockResolvedValue([]);
    await outbox.restore(true);
    expect(outbox.tasks()).toEqual([]);
    expect(files.bytes()).toBe(0);
    expect(() => files.resolve(descriptor)).toThrow('Please cancel and upload again');
  });

  it('retains the projection if durable deletion fails', async () => {
    await outbox.restore();
    database.removePendingSend.mockRejectedValueOnce(new Error('busy'));
    await expect(outbox.remove('cid')).rejects.toThrow('busy');
    expect(outbox.get('cid')).toBeDefined();
    await outbox.remove('cid');
    expect(outbox.tasks()).toEqual([]);
  });

  it('does not publish an old admission after session invalidation', async () => {
    let commit!: () => void;
    database.enqueuePendingSend.mockReturnValue(new Promise<void>(resolve => { commit = resolve; }));
    const pending = outbox.enqueue(task);
    lifecycle.invalidateSession();
    commit();
    await expect(pending).rejects.toThrow();
    expect(outbox.tasks()).toEqual([]);
  });

  it('lets history retire only failed leftovers with a matching client message ID', () => {
    const rows: SendingTask[] = [
      { task, execution: { kind: 'message', phase: 'sending' } },
      { task: { ...task, clientMessageId: 'failed' }, execution: { kind: 'message', phase: 'failed' } },
    ];
    expect(failedMatchingIntentIds(rows, ['cid', 'failed', 'other'])).toEqual(['failed']);
  });
});
