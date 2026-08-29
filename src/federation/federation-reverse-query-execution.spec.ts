import { describe, expect, it, vi } from 'vitest';
import { BusinessCode } from '../common/business-code.js';
import { FederationDepartedMemberProfileConsumerService } from './federation-departed-member-profile-consumer.service.js';
import type { FederationReverseThreadSource } from './federation-reverse-thread-source.js';
import { S2sResponseError } from './federation.service.js';
import { FederationThreadReverseRoundExecutorService } from './federation-thread-reverse-round-executor.service.js';

const groupSource: Extract<FederationReverseThreadSource, { kind: 'GROUP' }> = {
  kind: 'GROUP',
  threadId: 31,
  peerDomain: 'origin.test',
  selector: { account: '!group' },
};

const peerToken = {
  domain: 'origin.test',
  resetGeneration: 2,
  rootKeyFingerprint: 'fingerprint',
};

function message(sequence: number) {
  return {
    thread: { account: '!group' },
    author: { account: 'bob', domain: 'origin.test' },
    seq: sequence,
    originSeq: sequence,
    originCreatedAt: 1_700_000_000_000,
    createdAt: 1_700_000_000_000,
    contentType: 'PURE_TEXT' as const,
    content: JSON.stringify({ text: 'history' }),
    assets: [],
  };
}

function reverseExecutor(federation: object) {
  const executor = new FederationThreadReverseRoundExecutorService(
    {} as never,
    {} as never,
    federation as never,
    {} as never,
    {} as never,
  );
  return executor as unknown as {
    fetchMessages: (
      source: FederationReverseThreadSource,
      params: { before: number; through?: number; take: number },
    ) => Promise<unknown>;
  };
}

describe('federation reverse query execution', () => {
  it('uses the frozen reverse cursors and buffers the historical page for commit', async () => {
    const response = {
      data: { messages: [message(70)], scannedThrough: 70, hasMore: true },
      threadId: 31,
      peerDomain: 'origin.test',
      federationVersion: 4,
      peerToken,
    };
    const fetchThreadResource = vi.fn().mockResolvedValue(response);
    const executor = reverseExecutor({ fetchThreadResource });

    await expect(
      executor.fetchMessages(groupSource, {
        before: 100,
        through: 40,
        take: 20,
      }),
    ).resolves.toEqual({
      result: { kind: 'page', scannedThrough: 70, hasMore: true },
      batch: {
        response,
        before: 100,
        through: 40,
        prefetchedForwardClosures: new Map(),
      },
    });
    expect(fetchThreadResource).toHaveBeenCalledWith(
      31,
      '/s2s/v1/messages?account=%21group&before=100&through=40&take=20&includeSelf=true',
      'origin.test',
      16 * 1024 * 1024,
    );
  });

  it('recognizes only the lower cursor error as a history boundary', async () => {
    const executor = reverseExecutor({
      fetchThreadResource: vi
        .fn()
        .mockRejectedValue(
          new S2sResponseError(
            'cursor unavailable',
            200,
            BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
            { resumeAfter: 60, resumeBefore: 101 },
          ),
        ),
    });

    await expect(
      executor.fetchMessages(groupSource, { before: 60, take: 20 }),
    ).resolves.toEqual({
      result: { kind: 'history-boundary' },
      batch: null,
    });
  });

  it('drains every departed-member page in the frozen message window', async () => {
    const profile = (lastSentSeq: number) => ({
      account: `user${lastSentSeq}`,
      domain: 'member.test',
      lastSentSeq,
      profileRev: 1,
      displayName: `User ${lastSentSeq}`,
      avatar: null,
    });
    const fetchThreadResource = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          members: [profile(80)],
          scannedThrough: 70,
          hasMore: true,
        },
        threadId: 31,
        peerDomain: 'origin.test',
        federationVersion: 4,
        peerToken,
      })
      .mockResolvedValueOnce({
        data: {
          members: [profile(60)],
          scannedThrough: 50,
          hasMore: false,
        },
        threadId: 31,
        peerDomain: 'origin.test',
        federationVersion: 4,
        peerToken,
      });
    const federation = {
      fetchThreadResource,
      assertThreadResourceResponseWritableInTransaction: vi.fn(),
    };
    const consumer = new FederationDepartedMemberProfileConsumerService(
      {
        db: {
          transaction: (callback: (value: unknown) => unknown) => callback({}),
        },
      } as never,
      {} as never,
      federation as never,
    );

    await expect(
      consumer.fetch(groupSource, {
        before: 100,
        through: 50,
        take: 20,
      }),
    ).resolves.toEqual([profile(80), profile(60)]);
    expect(fetchThreadResource).toHaveBeenNthCalledWith(
      2,
      31,
      '/s2s/v1/departed-member-profiles?account=%21group&before=70&through=50&take=20',
      'origin.test',
      4 * 1024 * 1024,
    );
  });
});
