import { and, eq } from 'drizzle-orm';
import type { DatabaseTransaction } from '../../database/database.service.js';
import { profileTable } from '../../database/schema.js';
import {
  accountAddressInTx,
  localAccountsForTargetsInTx,
  type AccountTarget,
} from '../../user/account-address.js';
import type { NamespacedAddress } from '../../common/client-identity.js';
import type { ClientStateFeedService } from '../../client-state-feed/client-state-feed.service.js';
import type { RelationshipIntentService } from '../relationship-intent.service.js';
import { captureThreadStateUpdatesInTx } from '../../client-state-feed/capture-thread-state-updates.js';
import type { PendingClientStateFeedUpdate } from '../../client-state-feed/client-state-feed.service.js';

/** Publish both current authored directions to each local endpoint in the owning transaction. */
export async function writeP2PClientRelationshipInTx(
  tx: DatabaseTransaction,
  firstTarget: AccountTarget,
  secondTarget: AccountTarget,
  intents: RelationshipIntentService,
  feed: ClientStateFeedService,
): Promise<PendingClientStateFeedUpdate[]> {
  const first = await accountAddressInTx(tx, firstTarget);
  const second = await accountAddressInTx(tx, secondTarget);
  const relationship = await intents.readP2PRelationshipInTx(tx, first, second);
  const recipients = await localAccountsForTargetsInTx(tx, [first, second]);
  const pending: Array<{ userId: number; feedId: number }> = [];
  const directions = [
    { actor: first, subject: second, intent: relationship.firstIntent },
    { actor: second, subject: first, intent: relationship.secondIntent },
  ];
  const namespaceId = Math.max(first.namespaceId, second.namespaceId);
  for (const { actor, subject, intent } of directions) {
    if (!intent) continue;
    for (const owner of recipients) {
      if (owner.availability !== 'AVAILABLE') continue;
      const outgoing =
        actor.domain === 'local' && actor.account === owner.account;
      const peer = outgoing ? subject : actor;
      const peerIntent = directions.find(
        (direction) =>
          direction.actor.account === peer.account &&
          direction.actor.domain === peer.domain,
      )?.intent;
      const feedId = await feed.writeInTx(tx, {
        userId: owner.id,
        account: actor.account,
        domain: actor.domain,
        subjectAccount: subject.account,
        subjectDomain: subject.domain,
        namespaceId,
        eventType: 'RELATIONSHIP_INTENT',
        body: {
          status: intent.status,
          note: intent.note,
          requestedAt: intent.requestedAt?.getTime() ?? null,
          expiresAt: intent.expiresAt?.getTime() ?? null,
          direction: outgoing ? 'OUTGOING' : 'INCOMING',
          localThreadId: relationship.pair.threadId,
          peer: await clientInviteUser(tx, peer, peerIntent?.profileRev ?? 0),
        },
      });
      if (feedId !== null) pending.push({ userId: owner.id, feedId });
    }
  }
  if (relationship.pair.threadId !== null)
    pending.push(
      ...(await captureThreadStateUpdatesInTx(
        tx,
        recipients
          .filter((owner) => owner.availability === 'AVAILABLE')
          .map((owner) => owner.id),
      )),
    );
  return pending;
}

async function clientInviteUser(
  tx: DatabaseTransaction,
  value: NamespacedAddress,
  rev: number,
) {
  const profile =
    rev > 0
      ? await tx.query.profileTable.findFirst({
          where: and(
            eq(profileTable.account, value.account),
            eq(profileTable.domain, value.domain),
            eq(profileTable.publisherNamespaceId, value.domain === 'local' ? 0 : value.namespaceId),
            eq(profileTable.profileNamespaceId, value.namespaceId),
            eq(profileTable.profileRev, rev),
          ),
        })
      : undefined;
  return {
    account: value.account,
    name: profile?.displayName ?? value.account,
    avatar: profile?.avatar ?? '',
    bio: profile?.bio ?? '',
    domain: value.domain,
    profileRev: rev,
  };
}
