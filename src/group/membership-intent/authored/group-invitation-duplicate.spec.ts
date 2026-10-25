import { describe, expect, it, vi } from 'vitest';
import { BusinessCode } from '../../../common/business-code.js';
import { GroupAuthoredMembershipIntentService } from './group-authored-membership-intent.service.js';

describe('group invitation duplicate validation', () => {
  function setup() {
    const service = new GroupAuthoredMembershipIntentService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    // Exercise the decision made after the transaction has locked and read
    // the authoritative pair and intent rows, independently of UI hints.
    const row = {
      dissolvedAt: null,
      authorized: true,
      pairActive: false,
      invitationOutstanding: false,
      applicationPending: false,
      memberIntentStatus: null,
    };
    const validate = (patch: Partial<typeof row>) =>
      service['validateRequestInTx'](
        {} as never,
        { decision: 'REQUESTED' } as never,
        1n,
        {} as never,
        { ...row, ...patch } as never,
      );
    return { service, validate };
  }

  it('reports existing membership as a business rejection, not a successful no-op', async () => {
    const { validate } = setup();
    await expect(validate({ pairActive: true })).resolves.toMatchObject({
      status: 'REJECTED',
      reason: 'ALREADY_MEMBER',
      code: BusinessCode.ALREADY_EXISTS,
    });
  });

  it('rejects an outstanding unacknowledged invitation', async () => {
    const { validate } = setup();
    await expect(
      validate({ invitationOutstanding: true }),
    ).resolves.toMatchObject({
      status: 'REJECTED',
      reason: 'ALREADY_INVITED',
      code: BusinessCode.ALREADY_EXISTS,
    });
  });

  it('keeps crossed applications on the acceptance path', async () => {
    const { service, validate } = setup();
    const accept = vi
      .spyOn(service as never, 'validateAcceptanceInTx')
      .mockResolvedValue({
        status: 'NO_OP',
        reason: 'ALREADY_SATISFIED',
      } as never);
    await validate({ invitationOutstanding: true, applicationPending: true });
    expect(accept).toHaveBeenCalledOnce();
  });
});
