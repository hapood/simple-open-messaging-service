import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { DatabaseTransaction } from '../../database/database.service.js';
import { validateRequestDecisionInTx } from './validate-request-decision-in-tx.js';

const asOf = new Date('2026-10-20T00:00:00Z');
const future = new Date(asOf.getTime() + 1000);
const id = 9007199254740993n;
const flow = {
  kind: 'GROUP_APPLICATION' as const,
  author: { account: 'member', namespaceId: 7 },
  receiver: { account: '!group', namespaceId: 0 },
};
function transaction(round: unknown, intent: unknown) {
  const predicates: unknown[] = [];
  const select = vi.fn().mockImplementation(() => ({
    from: () => ({
      where: (predicate: unknown) => {
        predicates.push(predicate);
        return Promise.resolve(
          (predicates.length === 1 ? round : intent)
            ? [predicates.length === 1 ? round : intent]
            : [],
        );
      },
    }),
  }));
  return {
    tx: { select } as unknown as DatabaseTransaction,
    select,
    predicates,
  };
}

describe('shared exact request decision admission', () => {
  it.each(['FRIEND', 'GROUP_APPLICATION', 'GROUP_INVITATION'] as const)(
    'uses the complete %s flow and lossless request ID without taking locks or writing',
    async (kind) => {
      const { tx, predicates } = transaction(
        { status: 'REQUESTED', expiresAt: future },
        { requestId: id, status: 'REQUESTED', expiresAt: future },
      );
      expect(
        await validateRequestDecisionInTx(tx, {
          flow: { ...flow, kind },
          requestId: id,
          pairActive: false,
          asOf,
        }),
      ).toBeUndefined();
      const query = new PgDialect().sqlToQuery(predicates[0] as never);
      expect(query.params).toEqual([id, kind, 'member', 7, '!group', 0]);
    },
  );
  it.each([
    [undefined, { requestId: id, status: 'REQUESTED', expiresAt: future }],
    [{ status: 'REQUESTED', expiresAt: future }, undefined],
    [
      { status: 'ACCEPTED', expiresAt: future },
      { requestId: id, status: 'REQUESTED', expiresAt: future },
    ],
    [
      { status: 'REQUESTED', expiresAt: future },
      { requestId: id, status: 'REVOKED', expiresAt: null },
    ],
    [
      { status: 'REQUESTED', expiresAt: future },
      { requestId: id + 1n, status: 'REQUESTED', expiresAt: future },
    ],
  ])(
    'rejects missing, terminal or replaced associations',
    async (round, intent) => {
      const { tx } = transaction(round, intent);
      expect(
        await validateRequestDecisionInTx(tx, {
          flow,
          requestId: id,
          pairActive: false,
          asOf,
        }),
      ).toEqual({ status: 'STALE_REQUEST' });
    },
  );
  it.each([
    [asOf, future],
    [future, asOf],
    [future, null],
  ])('checks both validity deadlines', async (roundExpiry, intentExpiry) => {
    const { tx } = transaction(
      { status: 'REQUESTED', expiresAt: roundExpiry },
      { requestId: id, status: 'REQUESTED', expiresAt: intentExpiry },
    );
    expect(
      await validateRequestDecisionInTx(tx, {
        flow,
        requestId: id,
        pairActive: false,
        asOf,
      }),
    ).toEqual({ status: 'EXPIRED' });
  });
  it('never interprets a pending request action as an established relationship departure', async () => {
    const { tx, select } = transaction(undefined, undefined);
    expect(
      await validateRequestDecisionInTx(tx, {
        flow,
        requestId: id,
        pairActive: true,
        asOf,
      }),
    ).toEqual({ status: 'STALE_REQUEST' });
    expect(select).not.toHaveBeenCalled();
  });
});
