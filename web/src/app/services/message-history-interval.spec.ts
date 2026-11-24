import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { Subject, of } from 'rxjs';
import {
  MessageRepository,
  type MessageHistoryIntervalPage,
} from './message-repository.service';
import { WebdbService } from './webdb.service';
import { WebsocketService } from './websocket.service';
import { MsgService } from './message.service';
import { UserService } from './user.service';
import { SessionLifecycleService } from './session-lifecycle.service';
import type { Message } from './model';

describe('mounted history intervals', () => {
  let repo: MessageRepository;
  let query: ReturnType<typeof vi.fn>;
  let commit: ReturnType<typeof vi.fn>;
  let stream: ReadableStreamDefaultController<Uint8Array>;
  let fetchSpy: ReturnType<typeof vi.fn>;
  let streamSignal: AbortSignal;
  const message = { threadId: 42, seq: 79 } as Message;
  const notify = async (left = 20, right = 80, threadId = 42) => {
    stream.enqueue(
      new TextEncoder().encode(
        `event: MESSAGE_HISTORY_INTERVAL\ndata: ${JSON.stringify({ threadId, left, right })}\n\n`,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const response = () => ({
    code: 0,
    data: {
      messages: [message],
      gaps: [{ startSeq: 71, endSeq: 78, recoverable: true }],
      scannedThrough: 71,
      hasMore: true,
    },
  });
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => {
    fetchSpy = vi.fn(async (_url, options) => {
      streamSignal = options.signal;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
          },
        }),
      );
    });
    vi.stubGlobal('fetch', fetchSpy);
    query = vi.fn().mockReturnValue(of(response()));
    commit = vi.fn().mockImplementation(async (page) => ({
      messages: page.messages,
      ranges: page.gaps,
    }));
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        MessageRepository,
        {
          provide: WebdbService,
          useValue: {
            captureMessageLifetime: () => new AbortController().signal,
            messageDbCommitted$: new Subject(),
            tombstoneCommitted$: new Subject(),
            commitBrowserMessagePage: commit,
          },
        },
        { provide: WebsocketService, useValue: { reconnect$: new Subject() } },
        { provide: MsgService, useValue: { queryMessageHistoryPage: query } },
        {
          provide: UserService,
          useValue: { sessionProfile: signal({ id: 1 }) },
        },
      ],
    });
    repo = TestBed.inject(MessageRepository);
  });

  it('subscribes immediately, bypasses cached pending ranges and emits only the actual committed scan', async () => {
    const pages: MessageHistoryIntervalPage[] = [];
    const watch = repo
      .watchHistoryInterval(42, 20, 80)
      .subscribe((page) => pages.push(page));
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0][0]).toContain(
      '/message/history-interval?threadId=42&left=20&right=80',
    );
    expect(query).not.toHaveBeenCalled();
    await notify();
    await vi.waitFor(() => expect(pages).toHaveLength(1));
    expect(query).toHaveBeenCalledExactlyOnceWith({
      threadId: 42,
      before: 81,
      through: 21,
      take: 50,
    });
    expect(pages[0]).toEqual({
      left: 70,
      right: 80,
      items: [
        { kind: 'serverGap', left: 70, right: 78, state: 'SERVER_PENDING' },
        { kind: 'message', message },
      ],
    });
    expect(commit.mock.calls[0][0].scan).toEqual({ left: 70, right: 80 });
    watch.unsubscribe();
    expect(streamSignal.aborted).toBe(true);
  });

  it('coalesces in-flight notifications into one follow-up query and clips to subscription', async () => {
    const delayed = new Subject<ReturnType<typeof response>>();
    query.mockReturnValueOnce(delayed);
    const pages: MessageHistoryIntervalPage[] = [];
    const watch = repo
      .watchHistoryInterval(42, 20, 80)
      .subscribe((page) => pages.push(page));
    await notify(0, 100);
    await notify(20, 80);
    await notify(20, 80);
    await notify(20, 80, 99);
    expect(query).toHaveBeenCalledTimes(1);
    delayed.next(response());
    await vi.waitFor(() => expect(pages).toHaveLength(2));
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][0]).toEqual({
      threadId: 42,
      before: 81,
      through: 21,
      take: 50,
    });
    watch.unsubscribe();
  });

  it('unmount cancels the outstanding page before it can commit', async () => {
    const delayed = new Subject<ReturnType<typeof response>>();
    query.mockReturnValue(delayed);
    const emit = vi.fn();
    const watch = repo.watchHistoryInterval(42, 20, 80).subscribe(emit);
    await notify();
    watch.unsubscribe();
    delayed.next(response());
    await Promise.resolve();
    expect(commit).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('session replacement cancels both stream and late page work', async () => {
    const delayed = new Subject<ReturnType<typeof response>>();
    query.mockReturnValue(delayed);
    const watch = repo.watchHistoryInterval(42, 20, 80).subscribe();
    await notify();
    TestBed.inject(SessionLifecycleService).invalidateSession();
    delayed.next(response());
    await Promise.resolve();
    expect(watch.closed).toBe(true);
    expect(streamSignal.aborted).toBe(true);
    expect(commit).not.toHaveBeenCalled();
  });

  it('emits empty deletion exhaustion with its committed scan coordinates', async () => {
    query.mockReturnValue(
      of({
        code: 0,
        data: {
          messages: [],
          gaps: [],
          scannedThrough: 21,
          hasMore: false,
        },
      }),
    );
    const next = vi.fn();
    const watch = repo.watchHistoryInterval(42, 20, 80).subscribe(next);
    await notify();
    await vi.waitFor(() =>
      expect(next).toHaveBeenCalledExactlyOnceWith({
        left: 20,
        right: 80,
        items: [],
      }),
    );
    expect(commit).toHaveBeenCalledOnce();
    watch.unsubscribe();
  });

  it('ends an unauthorized mount instead of retrying it', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 403 }));
    const error = vi.fn();
    const watch = repo.watchHistoryInterval(42, 20, 80).subscribe({ error });
    await vi.waitFor(() => expect(watch.closed).toBe(true));
    expect(error).toHaveBeenCalledOnce();
    expect(query).not.toHaveBeenCalled();
  });

  it('clips full wire gaps on both sides before committing and publishing', async () => {
    query.mockReturnValue(
      of({
        code: 0,
        data: {
          messages: [],
          gaps: [{ startSeq: 1, endSeq: 100, recoverable: false }],
          scannedThrough: 71,
          hasMore: true,
        },
      }),
    );
    const next = vi.fn();
    const watch = repo.watchHistoryInterval(42, 20, 80).subscribe(next);
    try {
      await notify();
      await vi.waitFor(() =>
        expect(next).toHaveBeenCalledExactlyOnceWith({
          left: 70,
          right: 80,
          items: [
            {
              kind: 'serverGap',
              left: 70,
              right: 80,
              state: 'SERVER_UNAVAILABLE',
            },
          ],
        }),
      );
      expect(commit.mock.calls[0][0].gaps).toEqual([
        { left: 70, right: 80, state: 'SERVER_UNAVAILABLE' },
      ]);
      expect(query).toHaveBeenCalledOnce();
    } finally {
      watch.unsubscribe();
    }
  });

  it.each([
    { startSeq: 0, endSeq: 75, recoverable: true },
    { startSeq: 76, endSeq: 75, recoverable: true },
    { startSeq: 1, endSeq: 70, recoverable: true },
    { startSeq: 81, endSeq: 100, recoverable: true },
    { startSeq: 71, endSeq: Number.MAX_SAFE_INTEGER + 1, recoverable: true },
    { startSeq: 71, endSeq: 80, recoverable: 'true' },
  ])('rejects unsafe or nonintersecting wire gaps: %j', async (gap) => {
    query.mockReturnValue(
      of({
        code: 0,
        data: {
          messages: [],
          gaps: [gap],
          scannedThrough: 71,
          hasMore: true,
        },
      }),
    );
    const next = vi.fn();
    const watch = repo.watchHistoryInterval(42, 20, 80).subscribe(next);
    try {
      await notify();
      expect(commit).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
    } finally {
      watch.unsubscribe();
    }
  });

  it('rejects responses outside the notified scan before the cache reducer', async () => {
    query.mockReturnValue(
      of({
        code: 0,
        data: { messages: [], gaps: [], scannedThrough: 1, hasMore: false },
      }),
    );
    const emit = vi.fn();
    const watch = repo.watchHistoryInterval(42, 20, 80).subscribe(emit);
    await notify();
    await Promise.resolve();
    await Promise.resolve();
    expect(commit).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    watch.unsubscribe();
  });
});
