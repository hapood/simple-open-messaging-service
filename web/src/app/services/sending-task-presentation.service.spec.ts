import { TestBed } from '@angular/core/testing';
import { SendingTaskPresentation } from './sending-task-presentation.service';
import { ThreadSendOutbox } from './thread-send-outbox.service';
import { WebdbService } from './webdb.service';

describe('SendingTaskPresentation', () => {
  it('counts each durable intent once and scopes active and failed states to its thread', async () => {
    let outbox!: ThreadSendOutbox;
    TestBed.configureTestingModule({ providers: [{ provide: WebdbService, useValue: {
      enqueuePendingSend: vi.fn().mockResolvedValue(undefined),
      pendingSend: vi.fn(async (clientMessageId: string) => outbox.get(clientMessageId)?.task ?? null),
      pendingSends: vi.fn(async () => outbox.tasks().map(row => row.task)),
      removePendingSend: vi.fn().mockResolvedValue(undefined),
      clearPendingSends: vi.fn().mockResolvedValue(undefined),
    } }] });
    outbox = TestBed.inject(ThreadSendOutbox);
    const presentation = TestBed.inject(SendingTaskPresentation);
    for (const [clientMessageId, threadId] of [['text', 1], ['failed', 1], ['other', 2]] as const) {
      await outbox.enqueue({ clientMessageId, threadId, item: { type: 'PURE_TEXT', content: 'hello' } });
    }
    await outbox.enqueue({ clientMessageId: 'upload', threadId: 1, item: {
      type: 'FILE', file: { partId: 'part', path: 'runtime-file', size: 4, name: 'file', mimeType: 'application/octet-stream' },
    } });
    outbox.setPhase('failed', 'failed');
    expect(presentation.forThread(1).messageCount).toBe(1);
    expect(presentation.forThread(1).messages).toHaveLength(2);
    expect(presentation.forThread(1).uploadCount).toBe(1);
    expect(presentation.forThread(1).failedCount).toBe(1);
    expect(presentation.forThread(2).messageCount).toBe(1);
    outbox.setPhase('text', 'failed');
    outbox.setPhase('upload', 'failed');
    expect(presentation.forThread(1).messageCount).toBe(0);
    expect(presentation.forThread(1).uploadCount).toBe(0);
    expect(presentation.forThread(1).failedCount).toBe(3);
    outbox.setPhase('upload', 'failed');
    expect(presentation.forThread(1).failedCount).toBe(3);
    await outbox.remove('text');
    expect(presentation.forThread(1).failedCount).toBe(2);
    await outbox.clear();
    expect(presentation.forThread(1).messages).toEqual([]);
    expect(presentation.forThread(1).uploads).toEqual([]);
    expect(presentation.forThread(2).messageCount).toBe(0);
  });

});
