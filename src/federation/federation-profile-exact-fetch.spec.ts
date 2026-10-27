import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BusinessCode } from '../common/business-code.js';
import { FederationProfileService } from './federation-profile.service.js';
import { S2sResponseError } from './federation-errors.js';

const evidence = {
  account: 'alice',
  displayName: 'Alice',
  bio: '',
  avatar: null,
  generatedAt: 1_700_000_000_000,
};

function target() {
  const get = vi.fn().mockResolvedValue(evidence);
  return {
    get,
    profiles: new FederationProfileService(
      {} as never,
      {} as never,
      { get } as never,
      {} as never,
      {} as never,
    ),
  };
}

describe('exact signed profile operations', () => {
  beforeAll(() => vi.stubEnv('SOMS_DOMAIN', 'local.example'));
  afterAll(() => vi.unstubAllEnvs());
  it('uses the account home for account evidence', async () => {
    const { get, profiles } = target();
    await profiles.fetchExactAccountProfile('alice', 4, 'member.example');
    expect(get).toHaveBeenCalledWith(
      '/s2s/v1/account-profiles/0/alice/4',
      'member.example',
      expect.any(Number),
    );
  });

  it('uses the group origin to fetch an exact member-home address', async () => {
    const { get, profiles } = target();
    await profiles.fetchExactGroupMemberProfile(
      '!group',
      'alice',
      4,
      'group.example',
    );
    expect(get).toHaveBeenCalledWith(
      '/s2s/v1/group-member-profiles/%21group/0/alice/4',
      'group.example',
      expect.any(Number),
    );
  });

  it.each(['account', 'group-member'] as const)(
    'requires a valid generatedAt for %s evidence',
    async (kind) => {
      const { get, profiles } = target();
      const fetch = () =>
        kind === 'account'
          ? profiles.fetchExactAccountProfile('alice', 4, 'member.example')
          : profiles.fetchExactGroupMemberProfile(
              '!group',
              'alice',
              4,
              'member.example',
            );
      for (const generatedAt of [
        undefined,
        null,
        -1,
        0.5,
        '1',
        Number.MAX_SAFE_INTEGER + 1,
      ]) {
        const body: Record<string, unknown> = { ...evidence, generatedAt };
        if (generatedAt === undefined) delete body.generatedAt;
        get.mockResolvedValueOnce(body);
        await expect(fetch()).rejects.toMatchObject({
          code: BusinessCode.FEDERATION_MALFORMED,
        });
      }
      for (const generatedAt of [0, 1, Number.MAX_SAFE_INTEGER]) {
        get.mockResolvedValueOnce({ ...evidence, generatedAt });
        await expect(fetch()).resolves.toMatchObject({
          generatedAt,
          namespaceId: 0,
          profileRev: 4,
        });
      }
    },
  );

  it('treats only a signed 200 NOT_FOUND as absence', async () => {
    const { get, profiles } = target();
    get.mockRejectedValueOnce(
      new S2sResponseError('absent', 200, BusinessCode.NOT_FOUND),
    );
    expect(
      await profiles.fetchExactAccountProfile('alice', 4, 'member.example'),
    ).toBeNull();
    const error = new Error('transport timeout');
    get.mockRejectedValueOnce(error);
    await expect(
      profiles.fetchExactAccountProfile('alice', 4, 'member.example'),
    ).rejects.toBe(error);
    get.mockRejectedValueOnce(
      new S2sResponseError('bad', 403, BusinessCode.NOT_FOUND),
    );
    await expect(
      profiles.fetchExactAccountProfile('alice', 4, 'member.example'),
    ).rejects.toBeInstanceOf(S2sResponseError);
  });

  it('rejects wrong identity and request-coordinate echoes in the closed evidence response', async () => {
    const { get, profiles } = target();
    for (const body of [
      { ...evidence, account: 'other' },
      { ...evidence, domain: 'member.example' },
      { ...evidence, namespaceId: 0 },
      { ...evidence, profileRev: 9 },
      { ...evidence, displayName: '' },
      { ...evidence, displayName: '\ud800' },
      { ...evidence, avatar: {} },
      null,
    ]) {
      get.mockResolvedValueOnce(body);
      await expect(
        profiles.fetchExactAccountProfile('alice', 4, 'member.example'),
      ).rejects.toMatchObject({
        code: BusinessCode.FEDERATION_MALFORMED,
      });
    }
  });
});
