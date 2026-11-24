import {
  parseIncomingRequestHead,
  type IncomingRequestHead,
} from './relationship-request.js';

export type ClientStateFeedItemType =
  | 'REQUEST_HEAD'
  | 'THREAD_TOMB_HEAD'
  | 'THREAD_META_HEAD';

export interface ThreadTombHead {
  threadId: number;
  tombstoneEndSeq: number;
}

export interface ThreadMetaHead {
  threadId: number;
  groupMetaFeedEndId: string;
}

export type ClientStateFeedItem =
  | {
      feedId: number;
      type: 'REQUEST_HEAD';
      body: IncomingRequestHead;
    }
  | {
      feedId: number;
      type: 'THREAD_TOMB_HEAD';
      body: ThreadTombHead;
    }
  | {
      feedId: number;
      type: 'THREAD_META_HEAD';
      body: ThreadMetaHead;
    };

const INT32_MAX = 2_147_483_647;

function positiveInt32(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > INT32_MAX
  )
    throw new Error(`invalid ${label}`);
  return value;
}

function nonNegativeInt32(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > INT32_MAX
  )
    throw new Error(`invalid ${label}`);
  return value;
}

export function parseThreadTombHead(value: unknown): ThreadTombHead {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid thread tomb head');
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    !Object.hasOwn(record, 'threadId') ||
    !Object.hasOwn(record, 'tombstoneEndSeq')
  )
    throw new Error('invalid thread tomb head');
  return {
    threadId: positiveInt32(record['threadId'], 'threadId'),
    tombstoneEndSeq: nonNegativeInt32(
      record['tombstoneEndSeq'],
      'tombstoneEndSeq',
    ),
  };
}

export function parseThreadMetaHead(value: unknown): ThreadMetaHead {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid thread meta head');
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    !Object.hasOwn(record, 'threadId') ||
    !Object.hasOwn(record, 'groupMetaFeedEndId')
  )
    throw new Error('invalid thread meta head');
  const end = record['groupMetaFeedEndId'];
  if (typeof end !== 'string' || !/^(0|[1-9]\d*)$/.test(end))
    throw new Error('invalid groupMetaFeedEndId');
  const parsed = Number(end);
  if (!Number.isSafeInteger(parsed) || parsed > INT32_MAX)
    throw new Error('invalid groupMetaFeedEndId');
  return {
    threadId: positiveInt32(record['threadId'], 'threadId'),
    groupMetaFeedEndId: end,
  };
}

export function parseClientStateFeedItem(value: unknown): ClientStateFeedItem {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid client state feed item');
  const record = value as Record<string, unknown>;
  const feedId = positiveInt32(record['feedId'], 'feedId');
  const type = record['type'];
  if (type === 'REQUEST_HEAD') {
    return {
      feedId,
      type,
      body: parseIncomingRequestHead(record['body']),
    };
  }
  if (type === 'THREAD_TOMB_HEAD') {
    return {
      feedId,
      type,
      body: parseThreadTombHead(record['body']),
    };
  }
  if (type === 'THREAD_META_HEAD') {
    return {
      feedId,
      type,
      body: parseThreadMetaHead(record['body']),
    };
  }
  throw new Error('invalid client state feed item type');
}
