import type { DatabaseTransaction } from '../database/database.service.js';
import {
  accountAddressInTx,
  type AccountTarget,
} from '../user/account-address.js';
import type {
  OrdinarySystemMessageContent,
  SystemEventAddress,
} from '../../shared/system-message-content.js';
export {
  SystemMessageType,
  parseSystemMessageContent,
  stringifySystemMessageContent,
} from '../../shared/system-message-content.js';
export type {
  SystemMessageContent,
  OrdinarySystemMessageContent,
} from '../../shared/system-message-content.js';
export type SystemMessageInput = OrdinarySystemMessageContent<AccountTarget>;

export async function resolveSystemMessageInTx(
  tx: DatabaseTransaction,
  event: SystemMessageInput,
): Promise<OrdinarySystemMessageContent> {
  const resolve = async (
    target: AccountTarget,
  ): Promise<SystemEventAddress> => {
    const { account, domain } = await accountAddressInTx(tx, target);
    return { account, domain };
  };
  switch (event.type) {
    case 'FRIEND_REMOVED':
      return { ...event, initiator: await resolve(event.initiator) };
    case 'GROUP_JOINED':
    case 'GROUP_LEFT':
    case 'GROUP_ADMIN_GRANTED':
    case 'GROUP_ADMIN_REVOKED':
      return { ...event, member: await resolve(event.member) };
    case 'GROUP_OWNER_TRANSFERRED':
      return {
        ...event,
        previousOwner: await resolve(event.previousOwner),
        newOwner: await resolve(event.newOwner),
      };
    case 'MESSAGE_WITHDRAWN':
      return { ...event, author: await resolve(event.author) };
    default:
      return event;
  }
}
