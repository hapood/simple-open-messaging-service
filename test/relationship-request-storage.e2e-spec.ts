import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from '../src/database/database.service.js';
import {
  relationshipIntent,
  relationshipRequest,
} from '../src/database/schema.js';

/** Storage invariants only: these fixtures do not stand in for request admission,
 * lifecycle writers, query authorization, or online-window filtering. */
describe('permanent request history and intent reference storage', () => {
  let database: DatabaseService;
  let sequence = 0;
  beforeAll(() => {
    database = new DatabaseService();
  });
  afterAll(async () => database?.onApplicationShutdown());

  async function newRequest(
    overrides: Partial<typeof relationshipRequest.$inferInsert> = {},
  ) {
    const n = ++sequence;
    const requestedAt = new Date();
    const [row] = await database.db
      .insert(relationshipRequest)
      .values({
        kind: 'FRIEND',
        status: 'REQUESTED',
        authorAccount: `history-author-${n}`,
        authorNamespaceId: 0,
        receiverAccount: `history-receiver-${n}`,
        receiverNamespaceId: 0,
        authorProfileNamespaceId: 0,
        authorProfileRev: 1,
        snapshot: { displayName: 'Receiver at request time', avatar: null },
        note: 'Historical evidence',
        requestedAt,
        expiresAt: new Date(requestedAt.getTime() + 7 * 86_400_000),
        ...overrides,
      })
      .returning();
    return row;
  }
  const stored = (id: bigint) =>
    database.db.query.relationshipRequest.findFirst({
      where: eq(relationshipRequest.id, id),
    });
  function intentScope(row: typeof relationshipRequest.$inferSelect) {
    return and(
      eq(relationshipIntent.authorAccount, row.authorAccount),
      eq(relationshipIntent.authorNamespaceId, row.authorNamespaceId),
      eq(relationshipIntent.receiverAccount, row.receiverAccount),
      eq(relationshipIntent.receiverNamespaceId, row.receiverNamespaceId),
    );
  }
  async function attach(
    row: typeof relationshipRequest.$inferSelect,
    status: 'REQUESTED' | 'REVOKED' = 'REQUESTED',
  ) {
    const [intent] = await database.db
      .insert(relationshipIntent)
      .values({
        requestId: row.id,
        authorAccount: row.authorAccount,
        authorNamespaceId: row.authorNamespaceId,
        receiverAccount: row.receiverAccount,
        receiverNamespaceId: row.receiverNamespaceId,
        status,
        profileNamespaceId: row.authorProfileNamespaceId,
        profileRev: row.authorProfileRev,
        messageEndSeq: 0,
        tombstoneEndSeq: 0,
        note: row.note,
        requestedAt: row.requestedAt,
        expiresAt: status === 'REQUESTED' ? row.expiresAt : null,
      })
      .returning();
    return intent;
  }

  it('stores terminal records older than seven days without a retention cutoff', async () => {
    const old = new Date(Date.now() - 60 * 86_400_000);
    for (const kind of [
      'FRIEND',
      'GROUP_APPLICATION',
      'GROUP_INVITATION',
    ] as const) {
      const n = ++sequence;
      const authorAccount =
        kind === 'GROUP_INVITATION'
          ? `!history-group-${n}`
          : `history-user-${n}`;
      const receiverAccount =
        kind === 'GROUP_APPLICATION'
          ? `!history-group-${n}`
          : `history-target-${n}`;
      const row = await newRequest({
        kind,
        authorAccount,
        receiverAccount,
        status: 'REJECTED',
        requestedAt: old,
        createdAt: old,
        expiresAt: new Date(old.getTime() + 7 * 86_400_000),
      });
      expect(await stored(row.id)).toEqual(row);
      expect(row.createdAt).toEqual(old);
      expect(row.updatedAt.getTime()).toBeGreaterThan(old.getTime());
    }
  });

  it('repoints the intent to a new round and deletes the intent without changing either history record', async () => {
    const first = await newRequest({ status: 'REJECTED' });
    const second = await newRequest({
      authorAccount: first.authorAccount,
      receiverAccount: first.receiverAccount,
      snapshot: { displayName: 'Receiver on a later round', avatar: null },
      note: 'New round evidence',
    });
    expect(second.id).toBeGreaterThan(first.id);
    await attach(first, 'REVOKED');
    await database.db
      .update(relationshipIntent)
      .set({
        requestId: second.id,
        status: 'REQUESTED',
        note: second.note,
        requestedAt: second.requestedAt,
        expiresAt: second.expiresAt,
      })
      .where(intentScope(first));
    expect(
      await database.db.query.relationshipIntent.findFirst({
        where: intentScope(first),
      }),
    ).toMatchObject({ requestId: second.id });
    expect(await stored(first.id)).toEqual(first);
    expect(await stored(second.id)).toEqual(second);
    await database.db.delete(relationshipIntent).where(intentScope(first));
    expect(
      await database.db.query.relationshipIntent.findFirst({
        where: intentScope(first),
      }),
    ).toBeUndefined();
    expect(await stored(first.id)).toEqual(first);
    expect(await stored(second.id)).toEqual(second);
  });

  it('rejects a dangling reference and SET NULL changes no other intent field', async () => {
    const row = await newRequest();
    const intent = await attach(row);
    const missing = 9223372036854775807n;
    expect(await stored(missing)).toBeUndefined();
    await expect(
      database.db
        .update(relationshipIntent)
        .set({ requestId: missing })
        .where(intentScope(row)),
    ).rejects.toMatchObject({
      cause: {
        code: '23503',
        constraint: 'RelationshipIntent_requestId_fkey',
      },
    });
    expect(
      await database.db.query.relationshipIntent.findFirst({
        where: intentScope(row),
      }),
    ).toEqual(intent);
    expect(await stored(row.id)).toEqual(row);
    // An explicit administrative deletion exercises the FK action only; no
    // production request-history deletion or garbage collector is introduced.
    await database.db
      .delete(relationshipRequest)
      .where(eq(relationshipRequest.id, row.id));
    expect(
      await database.db.query.relationshipIntent.findFirst({
        where: intentScope(row),
      }),
    ).toEqual({ ...intent, requestId: null });
  });
});
