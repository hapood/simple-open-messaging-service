import { BusinessCode } from './biz-code';
import { TestBed } from '@angular/core/testing';
import { of, Subject, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import {
  IdentitySearch,
  IdentitySearchStatus as Status,
  parseIdentitySearch,
} from './identity-search';
import { FederatedResolveError, UserService, type User } from './user.service';
import { SessionLifecycleService } from './session-lifecycle.service';

const user: User = {
  id: 1,
  account: 'alice',
  namespaceId: 0,
  name: 'Alice',
  avatar: '',
  bio: '',
  isGroup: false,
  isDeleted: false,
  profileRev: 1,
};

function create() {
  const users = {
    resolveUser: vi.fn(() => of({ code: 0, data: user })),
    resolveFederatedUser: vi.fn(() => of({ user })),
  };
  TestBed.configureTestingModule({
    providers: [{ provide: UserService, useValue: users }],
  });
  return {
    lookup: TestBed.runInInjectionContext(() => new IdentitySearch()),
    users,
    lifecycle: TestBed.inject(SessionLifecycleService),
  };
}

describe('IdentitySearch', () => {
  it.each(['alice@', '@host', 'alice@@host', 'alice bob', 'alice@some host'])(
    'rejects invalid UI syntax %s before requesting identity data',
    (query) => {
      const { lookup, users } = create();
      lookup.search(query);
      expect(lookup.status()).toBe(Status.ERROR);
      expect(lookup.errorKey()).toBe('friend.error.invalidAddress');
      expect(users.resolveUser).not.toHaveBeenCalled();
      expect(users.resolveFederatedUser).not.toHaveBeenCalled();
    },
  );

  it('trims input and preserves exact account coordinates, including group identities', () => {
    expect(parseIdentitySearch(' alice ')).toEqual({ account: 'alice' });
    expect(parseIdentitySearch(' !team@peer.test ')).toEqual({
      account: '!team',
      domain: 'peer.test',
    });
    const { lookup, users } = create();
    lookup.search(' alice ');
    expect(users.resolveUser).toHaveBeenCalledWith({ account: 'alice' });
    expect(lookup.results()).toEqual([user]);
    lookup.search('');
    expect(lookup.status()).toBe(Status.INIT);
    expect(lookup.results()).toEqual([]);
  });

  it('forwards pinned identity keys and ignores old progress callbacks', () => {
    const { lookup, users } = create();
    const pending = new Subject<{ user: User }>();
    users.resolveFederatedUser.mockReturnValue(pending);
    lookup.search('alice@peer.test', { publicKey: 'pinned-key' });
    expect(users.resolveFederatedUser).toHaveBeenCalledWith(
      { account: 'alice', domain: 'peer.test', publicKey: 'pinned-key' },
      expect.any(Function),
    );
    const progress = (
      users.resolveFederatedUser.mock.calls[0] as unknown as [
        unknown,
        (stage: 'WAITING_FOR_PEER') => void,
      ]
    )[1];
    progress('WAITING_FOR_PEER');
    expect(lookup.progress().percent).toBe(80);
    lookup.search('alice');
    expect(pending.observed).toBe(false);
    progress('WAITING_FOR_PEER');
    expect(lookup.connectingDomain()).toBeNull();
    expect(lookup.stage()).toBe('DISCOVERING');
    expect(lookup.results()).toEqual([user]);
  });

  it.each([
    ['TIMEOUT', 'friend.error.timeout'],
    ['BLOCKED', 'friend.error.blocked'],
    ['DOMAIN_RESOLUTION_FAILED', 'friend.error.domainResolution'],
    ['UNREACHABLE', 'friend.error.unreachable'],
    ['INVALID_ADDRESS', 'friend.error.invalidAddress'],
    ['UNKNOWN', 'friend.error.unknownError'],
  ] as const)('classifies %s consistently', (reason, key) => {
    const { lookup, users } = create();
    users.resolveFederatedUser.mockReturnValue(
      throwError(() => new FederatedResolveError(reason)),
    );
    lookup.search('alice@peer.test');
    expect(lookup.status()).toBe(Status.ERROR);
    expect(lookup.errorKey()).toBe(key);
  });

  it('uses the same empty state for missing local and remote accounts', () => {
    const { lookup, users } = create();
    users.resolveUser.mockReturnValue(
      of({ code: BusinessCode.NOT_FOUND, data: user }),
    );
    lookup.search('missing');
    expect(lookup.status()).toBe(Status.EMPTY);
    users.resolveFederatedUser.mockReturnValue(
      throwError(() => new FederatedResolveError('NOT_FOUND')),
    );
    lookup.search('missing@peer.test');
    expect(lookup.status()).toBe(Status.EMPTY);
    expect(lookup.query()).toBe('missing@peer.test');
  });

  it.each([
    [BusinessCode.VALIDATION_FAILED, 'friend.error.invalidAddress'],
    [50000, 'friend.error.unknownError'],
  ] as const)(
    'does not treat local failure %s as a missing account',
    (code, key) => {
      const { lookup, users } = create();
      users.resolveUser.mockReturnValue(of({ code, data: user }));
      lookup.search('alice');
      expect(lookup.status()).toBe(Status.ERROR);
      expect(lookup.errorKey()).toBe(key);
      expect(lookup.results()).toEqual([]);
    },
  );

  it.each(['cancel', 'new-search', 'session', 'destroy'])(
    'does not publish deferred action state after %s',
    async (action) => {
      const { lookup, lifecycle } = create();
      let finish!: () => void;
      let stillCurrent!: () => boolean;
      lookup.search('alice', {
        prepare: (_user, isCurrent) => {
          stillCurrent = isCurrent;
          return new Promise<void>((resolve) => {
            finish = resolve;
          });
        },
      });
      expect(lookup.status()).toBe(Status.SEARCHING);
      if (action === 'cancel') lookup.cancel();
      else if (action === 'new-search') lookup.search('alice@');
      else if (action === 'session') lifecycle.invalidateSession();
      else TestBed.resetTestingModule();
      finish();
      await Promise.resolve();
      expect(stillCurrent()).toBe(false);
      expect(lookup.results()).toEqual([]);
      expect(lookup.status()).not.toBe(Status.SEARCHING);
      expect(lookup.status()).not.toBe(Status.SUCCESS);
    },
  );

  it('handles relationship-state preparation failure and permits retry', async () => {
    const { lookup } = create();
    lookup.search('alice', {
      prepare: () => Promise.reject(new Error('offline')),
    });
    await Promise.resolve();
    expect(lookup.status()).toBe(Status.ERROR);
    expect(lookup.errorKey()).toBe('friend.error.unknownError');
    lookup.search('alice');
    expect(lookup.status()).toBe(Status.SUCCESS);
  });

  it('session invalidation and destruction unsubscribe transport work', () => {
    const { lookup, users, lifecycle } = create();
    const pending = new Subject<{ user: User }>();
    users.resolveFederatedUser.mockReturnValue(pending);
    lookup.search('alice@peer.test');
    lifecycle.invalidateSession();
    expect(pending.observed).toBe(false);
    lookup.search('alice@peer.test');
    expect(pending.observed).toBe(true);
    TestBed.resetTestingModule();
    expect(pending.observed).toBe(false);
  });
});
