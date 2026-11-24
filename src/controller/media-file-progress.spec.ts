import { describe, expect, it, vi } from 'vitest';
import { of, Subject, type Observable } from 'rxjs';
import type { DigestDownloadProgress } from '../federation/federation-download-scheduler.js';
import type { MessageEvent } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { MessageController } from './message.controller.js';

function setup() {
  const hasMessageMediaDigest = vi.fn().mockResolvedValue(true);
  const participant = vi.fn().mockResolvedValue({});
  const observeDigest = vi.fn((): Observable<DigestDownloadProgress | null> => of({ received: 2, total: 4, status: 'downloading', bytesPerSecond: 2 }));
  const hasDigest = vi.fn(() => true);
  const terminal = new Subject<MessageEvent>();
  const controller = new MessageController(
    { queryMediaStatus: async () => [{}], hasMessageMediaDigest } as never,
    {} as never,
    { findActiveParticipantWithThread: participant } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { registerMediaFileProgress: () => terminal } as never,
    { observeDigest, hasDigest } as never,
    { snapshot: vi.fn() } as never,
  );
  const req = { user: { userId: 1 } } as FastifyRequest;
  const dto = { threadId: 2, seq: 3, digest: 'A'.repeat(64) };
  return {
    run: () => controller.mediaFileProgress(req, dto),
    observeDigest,
    hasMessageMediaDigest,
    participant,
    terminal,
  };
}

describe('authorized digest download progress', () => {
  it('checks message access and digest membership before observing shared progress', async () => {
    const s = setup();
    s.participant.mockResolvedValueOnce(null);
    await expect(s.run()).rejects.toThrow();
    expect(s.observeDigest).not.toHaveBeenCalled();
    s.hasMessageMediaDigest.mockResolvedValueOnce(false);
    await expect(s.run()).rejects.toThrow('media not found');
    expect(s.observeDigest).not.toHaveBeenCalled();
  });

  it('projects live digest bytes into authorized coordinates and closes on task completion', async () => {
    const s = setup();
    const events: MessageEvent[] = [];
    const subscription = (await s.run()).subscribe((event) =>
      events.push(event),
    );
    expect(s.hasMessageMediaDigest).toHaveBeenCalledWith(2, 3, 'a'.repeat(64));
    expect(s.observeDigest).toHaveBeenCalledWith('a'.repeat(64));
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'MEDIA_FILE_DOWNLOAD_PROGRESS',
        data: expect.objectContaining({
          threadId: 2,
          seq: 3,
          status: 'downloading',
          loaded: 2,
          total: 4,
          bytesPerSecond: 2,
        }),
      }),
    );
    s.terminal.next({
      type: 'MEDIA_FILE_DOWNLOAD_PROGRESS',
      data: { status: 'ready' },
    });
    expect(subscription.closed).toBe(true);
    expect(events.at(-1)?.data).toMatchObject({ status: 'ready' });
  });

  it('drops an idle snapshot that resolves after the terminal event', async () => {
    const digest = 'a'.repeat(64);
    const live = new Subject<{ received: number; total: number } | null>();
    let resolveSnapshot: (value: unknown) => void = () => {};
    const snapshot = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveSnapshot = resolve;
        }),
    );
    const terminal = new Subject<MessageEvent>();
    const controller = new MessageController(
      {
        queryMediaStatus: async () => [{}],
        hasMessageMediaDigest: async () => true,
      } as never,
      {} as never,
      { findActiveParticipantWithThread: async () => ({}) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { registerMediaFileProgress: () => terminal } as never,
      { observeDigest: () => live, hasDigest: () => false } as never,
      { snapshot } as never,
    );
    const events: MessageEvent[] = [];
    const subscription = (
      await controller.mediaFileProgress(
        { user: { userId: 1 } } as FastifyRequest,
        { threadId: 2, seq: 3, digest },
      )
    ).subscribe((event) => {
      if (event.type === 'MEDIA_FILE_DOWNLOAD_PROGRESS') events.push(event);
    });
    live.next(null);
    await Promise.resolve();
    terminal.next({
      type: 'MEDIA_FILE_DOWNLOAD_PROGRESS',
      data: { status: 'ready' },
    });
    resolveSnapshot({
      threadId: 2,
      seq: 3,
      status: 'failed',
      loaded: 0,
      total: null,
    });
    await Promise.resolve();
    expect(subscription.closed).toBe(true);
    expect(
      events.map((event) => (event.data as { status: string }).status),
    ).toEqual(['ready']);
  });
});
