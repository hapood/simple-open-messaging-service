import { BusinessCode } from '../../common/business-code.js';
import { BusinessException } from '../../common/business.exception.js';
import {
  isValidGroupAccount,
  isValidSomfpUserAccount,
} from '../../common/account.js';
import type { AccountThreadStateService } from '../../account-thread-state/account-thread-state.service.js';
import type { GroupService } from '../../group/group.service.js';
import type { UserService } from '../../user/user.service.js';
import type { ContactCardTargetDto } from '../../dto/message.dto.js';

/** Verify the account address and the sender's ability to select it before reading its profile. */
export async function assertContactCardTargetVisible(
  userId: number,
  reference: ContactCardTargetDto,
  services: {
    users: UserService;
    groups: GroupService;
    participants: AccountThreadStateService;
  },
): Promise<void> {
  if (
    !(
      isValidSomfpUserAccount(reference.account) ||
      isValidGroupAccount(reference.account)
    ) ||
    !Number.isInteger(reference.namespaceId) ||
    reference.namespaceId < 0
  ) {
    throw new BusinessException(
      BusinessCode.VALIDATION_FAILED,
      'invalid contact-card target',
    );
  }
  if (isValidGroupAccount(reference.account)) {
    const group = await services.groups.findVisibleGroupByAddress(
      userId,
      reference,
    );
    if (!group) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'contact group not found',
      );
    }
  } else if (reference.namespaceId === 0) {
    const user =
      await services.users.findUniqueUserByNamespaceAddress(reference);
    if (!user) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'contact user not found',
      );
    }
  } else {
    const friend = await services.participants.findP2PFriendByAddress(
      userId,
      reference,
    );
    if (!friend || friend.namespaceId !== reference.namespaceId) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'contact user not found',
      );
    }
  }
}
