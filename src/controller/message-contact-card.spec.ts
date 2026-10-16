import { describe, expect, it, vi } from 'vitest';
import { MessageController } from './message.controller.js';
import { ContentType } from '../database/enums.js';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SendContactCardDto } from '../dto/message.dto.js';

const target = {
  account: 'bob',
  namespaceId: 4,
  profileRev: 7,
};

function setup(
  profile: { displayName: string; bio: string; avatar: string } | null,
) {
  const writeMsgToThread = vi.fn().mockResolvedValue({ id: 'sent' });
  const findProfile = vi.fn().mockResolvedValue(profile);
  const snapshotAvatarForMessage = vi
    .fn()
    .mockResolvedValue({ digest: 'a'.repeat(64) });
  const findUniqueUser = vi.fn().mockResolvedValue({ account: 'bob' });
  const findUniqueUserByNamespaceAddress = vi
    .fn()
    .mockResolvedValue({ account: 'bob' });
  const findVisibleGroupByAddress = vi
    .fn()
    .mockImplementation(
      async (_userId: number, address: { account: string }) =>
        address.account === '!group12' ? { id: 12 } : null,
    );
  const activeContactCardBindingForNamespace = vi
    .fn()
    .mockImplementation(async (namespaceId: number) =>
      namespaceId === 0
        ? { domain: 'local', publicKey: 'l'.repeat(43) + '=' }
        : namespaceId === 4
          ? { domain: 'bravo.test', publicKey: 'r'.repeat(43) + '=' }
          : null,
    );
  const controller = Object.assign(
    Object.create(MessageController.prototype) as unknown as {
      sendContactCard: MessageController['sendContactCard'];
    },
    {
      messageService: {
        findByClientMessageId: vi.fn().mockResolvedValue(null),
        writeMsgToThread,
      },
      threadAccess: {
        assertP2PWritable: vi.fn().mockResolvedValue(undefined),
      },
      federationNamespaces: { activeContactCardBindingForNamespace },
      participantService: {
        findP2PFriendByAddress: vi
          .fn()
          .mockResolvedValue({ ...target, threadId: 9 }),
      },
      users: { findUniqueUser, findUniqueUserByNamespaceAddress },
      contactProfiles: { findProfile },
      groups: { findVisibleGroupByAddress },

      forwardBundles: { snapshotAvatarForMessage },
      userQuota: {
        assertCanSend: vi.fn().mockResolvedValue(undefined),
        tickLax: vi.fn().mockResolvedValue(undefined),
      },
    },
  );
  const request = {
    user: { userId: 1 },
    threadAccess: {
      threadType: 'P2P',
      friendshipActive: true,
      groupDissolved: false,
    },
  } as Parameters<MessageController['sendContactCard']>[0];
  const dto = {
    threadId: 9,
    target,
    clientMessageId: 'd24a91f9-7865-40e8-94a1-1301ea07f0bc',
  };
  return {
    controller,
    request,
    dto,
    writeMsgToThread,
    findProfile,
    findUniqueUserByNamespaceAddress,
    findVisibleGroupByAddress,
    snapshotAvatarForMessage,
    activeContactCardBindingForNamespace,
  };
}

describe('send federated contact card', () => {
  it('requires a numeric profile revision and rejects legacy numeric targets', async () => {
    const base = {
      threadId: 9,
      clientMessageId: 'd24a91f9-7865-40e8-94a1-1301ea07f0bc',
      target,
    };
    const validateBody = (body: object) =>
      validate(plainToInstance(SendContactCardDto, body), {
        whitelist: true,
        forbidNonWhitelisted: true,
      });
    expect(await validateBody(base)).toHaveLength(0);
    expect(
      await validateBody({ ...base, target: { ...target, profileRev: null } }),
    ).not.toHaveLength(0);
    expect(await validateBody({ ...base, targetUserId: 7 })).not.toHaveLength(
      0,
    );
  });

  it('snapshots the selected profile version and its avatar on the server', async () => {
    const ctx = setup({
      displayName: 'Bob',
      bio: 'hello',
      avatar: '/uploads/avatars/bob.webp',
    });
    await ctx.controller.sendContactCard(ctx.request, ctx.dto);
    expect(ctx.findProfile).toHaveBeenCalledWith(target);
    expect(ctx.activeContactCardBindingForNamespace).toHaveBeenCalledWith(4);
    expect(ctx.snapshotAvatarForMessage).toHaveBeenCalledWith(
      '/uploads/avatars/bob.webp',
    );
    expect(ctx.writeMsgToThread).toHaveBeenCalledWith(
      1,
      9,
      JSON.stringify({
        account: 'bob',
        domain: 'bravo.test',
        publicKey: 'r'.repeat(43) + '=',
        displayName: 'Bob',
        bio: 'hello',
        avatar: `/uploads/msg-assets/aa/aa/${'a'.repeat(64)}`,
      }),
      ContentType.CONTACT_CARD,
      ctx.dto.clientMessageId,
      undefined,
      expect.any(Function),
      undefined,
      undefined,
    );
  });

  it('uses the account and empty bio without an avatar when the selected revision is absent', async () => {
    const ctx = setup(null);
    await ctx.controller.sendContactCard(ctx.request, ctx.dto);
    expect(ctx.snapshotAvatarForMessage).not.toHaveBeenCalled();
    expect(JSON.parse(ctx.writeMsgToThread.mock.calls[0][2] as string)).toEqual(
      {
        account: 'bob',
        domain: 'bravo.test',
        publicKey: 'r'.repeat(43) + '=',
        displayName: 'bob',
        bio: '',
      },
    );
  });

  it('accepts local identities without a numeric user id', async () => {
    const ctx = setup(null);
    const local = {
      account: 'bob',
      namespaceId: 0,
      profileRev: 0,
    };
    (ctx.controller as unknown as { keypairs: unknown }).keypairs = {
      localAddress: () => ({ domain: 'local' }),
      getRootPublicKeyB64: () => 'l'.repeat(43) + '=',
    };
    await ctx.controller.sendContactCard(ctx.request, {
      ...ctx.dto,
      target: local,
    });
    expect(ctx.findUniqueUserByNamespaceAddress).toHaveBeenCalledWith(local);
    expect(ctx.findProfile).toHaveBeenCalledWith(local);
  });

  it('requires a visible group thread matching the supplied group address', async () => {
    const ctx = setup(null);
    const group = {
      account: '!group12',
      namespaceId: 0,
      profileRev: 0,
    };
    (ctx.controller as unknown as { keypairs: unknown }).keypairs = {
      localAddress: () => ({ domain: 'local' }),
      getRootPublicKeyB64: () => 'l'.repeat(43) + '=',
    };
    await ctx.controller.sendContactCard(ctx.request, {
      ...ctx.dto,
      target: group,
    });
    expect(ctx.findVisibleGroupByAddress).toHaveBeenCalledWith(1, group);
    await expect(
      ctx.controller.sendContactCard(ctx.request, {
        ...ctx.dto,
        target: { ...group, account: '!other12' },
      }),
    ).rejects.toThrow('contact group not found');
  });

  it('rejects a foreign identity outside the active friend namespace', async () => {
    const ctx = setup(null);
    await expect(
      ctx.controller.sendContactCard(ctx.request, {
        ...ctx.dto,
        target: { ...target, namespaceId: 5 },
      }),
    ).rejects.toThrow('contact user not found');
    expect(ctx.writeMsgToThread).not.toHaveBeenCalled();
  });
});
