import { Test } from '@nestjs/testing';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../database/database.service.js';
import { MessageVisibilityService } from '../message/message-visibility.service.js';
import { MediaAccessService } from './media-access.service.js';

describe('forward asset carrier authorization', () => {
  it.each([true, false])(
    'uses exact bigint graph keys and returns database authorization=%s',
    async (allowed) => {
      const bundleId = 9_007_199_254_740_993n;
      const database = {
        db: {
          query: {
            forwardMessage: {
              findFirst: vi.fn().mockResolvedValue({ bundleId }),
            },
          },
          execute: vi.fn().mockResolvedValue({ rows: [{ allowed }] }),
        },
      };
      const module = await Test.createTestingModule({
        providers: [
          MediaAccessService,
          { provide: DatabaseService, useValue: database },
          {
            provide: MessageVisibilityService,
            useValue: {
              findVisibleByThreadSeq: vi
                .fn()
                .mockResolvedValue({ id: 7n, contentType: 'FORWARD' }),
            },
          },
        ],
      }).compile();
      try {
        expect(
          await module
            .get(MediaAccessService)
            .canReadMessageAsset(1, 2, 3, 'a'.repeat(64)),
        ).toBe(allowed);
        const query = new PgDialect().sqlToQuery(
          database.db.execute.mock.calls[0][0],
        );
        expect(query.sql).toContain('::bigint');
        expect(query.sql).not.toContain('::varchar');
        expect(query.params[0]).toBe(bundleId);
      } finally {
        await module.close();
      }
    },
  );
});
