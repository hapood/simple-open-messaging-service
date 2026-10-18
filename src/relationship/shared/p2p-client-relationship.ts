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
        actor.namespaceId === 0 && actor.account === owner.account;
      const peer = outgoing ? subject : actor;
      const peerIntent = outgoing
        ? undefined
        : directions.find(
            (direction) =>
              direction.actor.account === peer.account &&
              direction.actor.namespaceId === peer.namespaceId,
          )?.intent;
      const feedId = await feed.writeInTx(tx, {
        userId: owner.id,
        account: actor.account,
        subjectAccount: subject.account,
        subjectNamespaceId: subject.namespaceId,
        namespaceId,
        eventType: 'RELATIONSHIP_INTENT',
        body: {
          status: intent.status,
          note: intent.note,
          requestedAt: intent.requestedAt?.getTime() ?? null,
          expiresAt: intent.expiresAt?.getTime() ?? null,
          snapshot: outgoing ? intent.snapshot : null,
          direction: outgoing ? 'OUTGOING' : 'INCOMING',
          localThreadId: relationship.pair.threadId,
          // Keep sent bodies independent of subsequent peer profile evidence.
          peer: await clientInviteUser(
            tx,
            peer,
            outgoing ? 0 : (peerIntent?.profileRev ?? 0),
          ),
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

/** Resolve the local profile snapshot for an invitee reference inside a
 * client feed body. Identity is the namespace coordinate; display domains
 * are resolved on the client through the namespace binding repository. */

async function clientInviteUser(
  tx: DatabaseTransaction,
  value: Pick<NamespacedAddress, 'account' | 'namespaceId'>,
  rev: number,
) {
  const profile =
    rev > 0
      ? await tx.query.profileTable.findFirst({
          where: and(
            eq(profileTable.account, value.account),
            eq(
              profileTable.publisherNamespaceId,
              value.namespaceId === 0 ? 0 : value.namespaceId,
            ),
            // A peer's own profile is subject namespace 0 at its publisher,
            // even when its home namespace is foreign on this server.
            eq(profileTable.profileNamespaceId, 0),
            eq(profileTable.profileRev, rev),
          ),
        })
      : undefined;
  return {
    account: value.account,
    avatar: profile?.avatar ?? '',
    bio: profile?.bio ?? '',
    namespaceId: value.namespaceId,
    profileRev: rev,
  };
}
