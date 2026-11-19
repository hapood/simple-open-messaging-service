import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { DatabaseService } from '../database/database.service.js';
import { ContentType } from '../database/enums.js';
import { LinkPreviewService } from '../link-preview/link-preview.service.js';
import { ThreadPreviewService } from './thread-preview.service.js';
import { MessageService } from './message.service.js';

async function fixture(missing = false) {
  const lookup = vi.fn(async (_query: { where: SQL }) =>
    missing
      ? undefined
      : {
          id: 41n,
          fileCnt: 1,
          contentType: 'IMAGE',
          status: 'pending',
        },
  );
  const update = vi.fn();
  const predicates: SQL[] = [];
  update.mockImplementation(() => ({
    set: () => ({
      where: async (predicate: SQL) => {
        predicates.push(predicate);
      },
    }),
  }));
  const module = await Test.createTestingModule({
    providers: [
      MessageService,
      { provide: EventEmitter2, useValue: new EventEmitter2() },
      {
        provide: DatabaseService,
        useValue: {
          db: {
            query: {
              account: {
                findFirst: async () => ({ account: 'alice', namespaceId: 0 }),
              },
              pendingMedia: { findFirst: lookup },
            },
            update,
          },
        },
      },
      { provide: LinkPreviewService, useValue: {} },
      { provide: ThreadPreviewService, useValue: {} },
    ],
  }).compile();
  onTestFinished(() => module.close());
  return { service: module.get(MessageService), lookup, update, predicates };
}

describe('staged content type database identity', () => {
  it('authorizes and updates the captured stage ID, never a replacement under a client key', async () => {
    const s = await fixture();
    await s.service.updateStagedContentType(41n, 1, ContentType.FILE);
    const dialect = new PgDialect();
    const lookup = dialect.sqlToQuery(s.lookup.mock.calls[0][0].where);
    expect(lookup.sql).toContain('"PendingMedia"."id"');
    expect(lookup.sql).not.toContain('clientMessageId');
    expect(lookup.params.map(String)).toEqual(['41', 'alice', '0']);
    expect(dialect.sqlToQuery(s.predicates[0]).params.map(String)).toEqual([
      '41',
      'pending',
    ]);
  });

  it('does not fall back to a client key when the captured stage is gone', async () => {
    const s = await fixture(true);
    await s.service.updateStagedContentType(41n, 1, ContentType.FILE);
    expect(s.lookup).toHaveBeenCalledOnce();
    expect(s.update).not.toHaveBeenCalled();
  });
});
