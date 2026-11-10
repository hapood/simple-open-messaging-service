import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { RequestAttentionService } from './request-attention.service.js';

describe('RequestAttentionService', () => {
  it.each([
    [true, false, true],
    [false, true, true],
    [false, false, false],
  ])(
    'uses personal=%s and manager=%s unread heads',
    async (personal, manager, expected) => {
      const predicates: unknown[] = [];
      const limit = vi
        .fn()
        .mockResolvedValueOnce(personal ? [{ id: 1 }] : [])
        .mockResolvedValueOnce(manager ? [{ id: 2 }] : []);
      const service = new RequestAttentionService({
        db: {
          select: () => ({
            from: () => ({
              where: (predicate: unknown) => {
                predicates.push(predicate);
                return { limit };
              },
            }),
          }),
        },
      } as never);
      expect(
        await service.hasUnread(1, { personal: true, managedGroups: true }),
      ).toBe(expected);
      const dialect = new PgDialect();
      const sql = predicates
        .map((p) => dialect.sqlToQuery(p as never).sql)
        .join(' ');
      expect(sql).toContain('"requestEndId" > "Account"."requestReadId"');
      expect(sql).not.toContain('unreadCount');
      if (!personal) {
        expect(sql).toContain(
          '"joinRequestEndFeedId" > "AccountThreadState"."joinRequestReadFeedId"',
        );
        expect(sql).toContain('"joinRequestReadFeedId" >=');
        expect(sql).toContain('"role" in');
        expect(sql).toContain('"messageVisibleThroughSeq" is null');
      }
    },
  );
});
