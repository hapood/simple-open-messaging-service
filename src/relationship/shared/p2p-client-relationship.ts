import type { DatabaseTransaction } from '../../database/database.service.js';
import {
  accountAddressInTx,
  localAccountsForTargetsInTx,
  type AccountTarget,
} from '../../user/account-address.js';
import type { ClientStateFeedService } from '../../client-state-feed/client-state-feed.service.js';
import type { RelationshipIntentService } from '../relationship-intent.service.js';
import { captureThreadStateUpdatesInTx } from '../../client-state-feed/capture-thread-state-updates.js';
import type { PendingClientStateFeedUpdate } from '../../client-state-feed/client-state-feed.service.js';

/** Preserve conversation fan-out without copying protocol intents into client state. */
export async function writeP2PClientRelationshipInTx(
  tx: DatabaseTransaction,
  firstTarget: AccountTarget,
  secondTarget: AccountTarget,
  intents: RelationshipIntentService,
  _feed: ClientStateFeedService,
): Promise<PendingClientStateFeedUpdate[]> {
  const first = await accountAddressInTx(tx, firstTarget);
  const second = await accountAddressInTx(tx, secondTarget);
  const relationship = await intents.readP2PRelationshipInTx(tx, first, second);
  if (relationship.pair.threadId === null) return [];
  const recipients = await localAccountsForTargetsInTx(tx, [first, second]);
  return captureThreadStateUpdatesInTx(
    tx,
    recipients.filter((owner) => owner.availability === 'AVAILABLE').map((owner) => owner.id),
  );
}
