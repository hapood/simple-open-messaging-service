import { and, eq } from 'drizzle-orm';
import { BusinessCode } from '../../common/business-code.js';
import { BusinessException } from '../../common/business.exception.js';
import { localIdentityDomain } from '../../common/local-identity.js';
import type { DatabaseService } from '../../database/database.service.js';
import { MessageThreadType } from '../../database/enums.js';
import * as tables from '../../database/schema.js';
import {
  groupState as groupStateTable,
  groupStateFields,
} from '../../group/shared/group-state.js';
import type { Message } from '../../message/message.service.js';

export interface MessageMediaRoute {
  peerDomain: string;
  fromAccount: string;
  fromDomain: string;
  toAccount: string;
  sourceSeq: number;
}

async function readMediaSourceDomain(
  database: DatabaseService,
  namespaceId: number,
): Promise<string | null> {
  if (namespaceId === 0) return null;
  const source = await database.db.query.identityNamespace.findFirst({
    where: eq(tables.identityNamespace.id, namespaceId),
    columns: { domain: true },
  });
  if (!source)
    throw new Error(`message publisher namespace ${namespaceId} is missing`);
  return source.domain;
}

/** Reconstruct request addressing, not an authorization token. The peer still authorizes each request. */
async function resolveMediaContext(
  database: DatabaseService,
  threadId: number,
  creatorAccount: string,
  authorNamespaceId: number,
  sourceDomain: string,
): Promise<{ toAccount: string; peerDomain: string }> {
  const [thread] = await database.db
    .select({
      type: tables.messageThread.type,
      group: {
        account: groupStateFields.account,
        authorityDomain: tables.identityNamespace.domain,
      },
    })
    .from(tables.messageThread)
    .leftJoin(groupStateTable, eq(groupStateTable.id, tables.messageThread.id))
    .leftJoin(
      tables.identityNamespace,
      eq(
        tables.identityNamespace.id,
        tables.messageThread.authorityNamespaceId,
      ),
    )
    .where(eq(tables.messageThread.id, threadId))
    .limit(1);
  if (thread?.type === MessageThreadType.GROUP && thread.group) {
    return {
      toAccount: thread.group.account,
      peerDomain: thread.group.authorityDomain,
    };
  }
  const [pair] = await database.db
    .select({
      endpointAAccount: tables.relationshipPair.endpointAAccount,
      endpointBAccount: tables.relationshipPair.endpointBAccount,
    })
    .from(tables.relationshipPair)
    .where(
      and(
        eq(tables.relationshipPair.threadId, threadId),
        eq(tables.relationshipPair.kind, 'P2P'),
        eq(tables.relationshipPair.active, true),
        authorNamespaceId === 0
          ? and(
              eq(tables.relationshipPair.endpointAType, 'USER'),
              eq(tables.relationshipPair.endpointAAccount, creatorAccount),
              eq(tables.relationshipPair.endpointBNamespaceId, 0),
            )
          : and(
              eq(tables.relationshipPair.endpointBType, 'USER'),
              eq(tables.relationshipPair.endpointBAccount, creatorAccount),
              eq(
                tables.relationshipPair.endpointBNamespaceId,
                authorNamespaceId,
              ),
            ),
      ),
    )
    .limit(1);
  if (!pair)
    throw new BusinessException(
      BusinessCode.FORBIDDEN,
      'message thread is no longer mutually authorized',
    );
  return {
    toAccount:
      authorNamespaceId === 0 ? pair.endpointBAccount : pair.endpointAAccount,
    peerDomain: sourceDomain,
  };
}

export async function resolveMessageMediaRoute(
  database: DatabaseService,
  msg: Message,
): Promise<MessageMediaRoute> {
  if (!msg.creatorAccount) throw new Error('media message has no author');
  const source = await readMediaSourceDomain(
    database,
    msg.publisherNamespaceId,
  );
  const context = await resolveMediaContext(
    database,
    msg.threadId,
    msg.creatorAccount,
    msg.profileNamespaceId === 0 && msg.publisherNamespaceId !== 0
      ? msg.publisherNamespaceId
      : msg.profileNamespaceId,
    await localIdentityDomain(database.db),
  );
  const peerDomain = source ?? context.peerDomain;
  return {
    peerDomain,
    fromAccount: msg.creatorAccount,
    fromDomain: peerDomain,
    toAccount: context.toAccount,
    sourceSeq: msg.originSeq ?? msg.seq,
  };
}
