import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { userIntentAcceptanceSql } from './user-intent-acceptance-sql.js';
import { userIntentRevocationSql } from './user-intent-revocation-sql.js';
import { userIntentRequestSql } from './user-intent-request-sql.js';

const dialect = new PgDialect();

describe('protocol statements without client intent replication', () => {
  it.each([0, 7])(
    'keeps protocol and thread effects for namespace %i',
    (targetNamespaceId) => {
      const input = {
        pairId: 10n,
        threadId: 20,
        namespaceId: targetNamespaceId,
        actorAccount: 'alice',
        actorNamespaceId: 0,
        targetAccount: 'bob',
        targetNamespaceId,
      };
      const request = dialect.sqlToQuery(
        userIntentRequestSql({
          ...input,
          note: 'hello',
          statusChangedAt: new Date(1000),
          expiresAt: new Date(2000),
          snapshot: { displayName: 'Bob', avatar: null },
        }),
      ).sql;
      const acceptanceQuery = dialect.sqlToQuery(
        userIntentAcceptanceSql({
          ...input,
          note: '',
          acceptedAt: new Date(1500),
        }),
      );
      const acceptance = acceptanceQuery.sql;
      const revocation = dialect.sqlToQuery(
        userIntentRevocationSql({
          ...input,
          localActorId: 1,
          localTargetId: targetNamespaceId === 0 ? 2 : null,
        }),
      ).sql;
      for (const statement of [request, acceptance, revocation]) {
        expect(statement).toContain('"RelationshipIntent"');
        expect(statement).not.toContain('"ClientStateFeed"');
        expect(statement).not.toContain('"compactionKey"');
        expect(statement).not.toContain('snapshot');
        if (targetNamespaceId !== 0)
          expect(statement).toContain('"PeerStateFeed"');
        else expect(statement).not.toContain('"PeerStateFeed"');
      }
      expect(acceptance).toContain('FRIEND_ADDED');
      expect(acceptance).toContain('"ThreadAudience"');
      expect(acceptanceQuery.params).toContain('FAN_OUT_THREAD_CONTENT');
      expect(revocation).toContain('FRIEND_REMOVED');
      expect(revocation).toContain('"authorizationEpoch"');
      expect(revocation).toContain('FAN_OUT_ACCOUNT_THREAD_CONTENT');
    },
  );
});
