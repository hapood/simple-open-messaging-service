import { computed, DestroyRef, inject, signal } from '@angular/core';
import { BusinessCode } from './biz-code';
import { Subscription } from 'rxjs';
import { SessionLifecycleService } from './session-lifecycle.service';
import {
  FederatedResolveError,
  type FederatedResolveStage,
  UserService,
  type User,
} from './user.service';

export enum IdentitySearchStatus {
  INIT,
  EMPTY,
  SEARCHING,
  SUCCESS,
  ERROR,
}

const STAGES: readonly FederatedResolveStage[] = [
  'DISCOVERING',
  'VERIFYING_IDENTITY',
  'CONNECTING',
  'WAITING_FOR_PEER',
  'FETCHING_USER',
];

/** Parse UI syntax only; authoritative account/domain validation stays on the server. */
export function parseIdentitySearch(text: string): {
  account: string;
  domain?: string;
} | null {
  const match = /^([^@\s]+)(?:@([^@\s]+))?$/.exec(text.trim());
  return match
    ? { account: match[1], ...(match[2] ? { domain: match[2] } : {}) }
    : null;
}

interface SearchOptions {
  publicKey?: string;
  /** Domain-specific target eligibility, independent of identity resolution. */
  reject?: (user: User) => string | null;
  /** Prepare action state before publishing the result; guard asynchronous side effects. */
  prepare?: (user: User, isCurrent: () => boolean) => void | Promise<void>;
}

/** Per-view exact lookup state. Never provided globally: independent dialogs own independent work. */
export class IdentitySearch {
  private readonly users = inject(UserService);
  private readonly lifecycle = inject(SessionLifecycleService);
  private subscription?: Subscription;
  private abortCleanup?: () => void;
  private generation = 0;

  readonly status = signal(IdentitySearchStatus.INIT);
  readonly generationId = signal(0);
  readonly results = signal<User[]>([]);
  readonly query = signal('');
  readonly errorKey = signal('');
  readonly connectingDomain = signal<string | null>(null);
  readonly stage = signal<FederatedResolveStage>('DISCOVERING');
  readonly stageKey = computed(() => `friend.federationStage.${this.stage()}`);
  readonly progress = computed(() => {
    const current = Math.max(1, STAGES.indexOf(this.stage()) + 1);
    return {
      current,
      total: STAGES.length,
      percent: (current / STAGES.length) * 100,
    };
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => this.cancel());
  }

  cancel(): void {
    this.generation++;
    this.generationId.set(this.generation);
    this.abortCleanup?.();
    this.abortCleanup = undefined;
    this.subscription?.unsubscribe();
    this.subscription = undefined;
    this.connectingDomain.set(null);
    this.stage.set('DISCOVERING');
    this.results.set([]);
    this.errorKey.set('');
    this.status.set(IdentitySearchStatus.INIT);
  }

  search(text: string, options: SearchOptions = {}): void {
    this.cancel();
    this.query.set(text.trim());
    if (!this.query()) return;
    const address = parseIdentitySearch(text);
    if (!address) {
      this.errorKey.set('friend.error.invalidAddress');
      this.status.set(IdentitySearchStatus.ERROR);
      return;
    }
    const generation = this.generation;
    const scope = this.lifecycle.capture();
    const isCurrent = () =>
      generation === this.generation && this.lifecycle.isCurrent(scope);
    const abort = () => this.cancel();
    scope.signal.addEventListener('abort', abort, { once: true });
    this.abortCleanup = () => scope.signal.removeEventListener('abort', abort);
    this.status.set(IdentitySearchStatus.SEARCHING);

    const fail = (error: unknown) => {
      if (!isCurrent()) return;
      this.connectingDomain.set(null);
      const reason =
        error instanceof FederatedResolveError ? error.reason : 'UNKNOWN';
      const keys: Record<string, string> = {
        DOMAIN_RESOLUTION_FAILED: 'friend.error.domainResolution',
        TIMEOUT: 'friend.error.timeout',
        BLOCKED: 'friend.error.blocked',
        UNREACHABLE: 'friend.error.unreachable',
        INVALID_ADDRESS: 'friend.error.invalidAddress',
      };
      if (reason === 'NOT_FOUND') {
        this.status.set(IdentitySearchStatus.EMPTY);
      } else {
        this.errorKey.set(keys[reason] ?? 'friend.error.unknownError');
        this.status.set(IdentitySearchStatus.ERROR);
      }
    };
    const resolved = (user: User) => {
      if (!isCurrent()) return;
      this.connectingDomain.set(null);
      const rejection = options.reject?.(user);
      if (rejection) {
        this.errorKey.set(rejection);
        this.status.set(IdentitySearchStatus.ERROR);
        return;
      }
      const publish = () => {
        if (!isCurrent()) return;
        this.results.set([user]);
        this.status.set(IdentitySearchStatus.SUCCESS);
      };
      try {
        const prepared = options.prepare?.(user, isCurrent);
        if (prepared) void prepared.then(publish, fail);
        else publish();
      } catch (error) {
        fail(error);
      }
    };
    this.subscription = address.domain
      ? this.users
          .resolveFederatedUser(
            {
              account: address.account,
              domain: address.domain,
              ...(options.publicKey ? { publicKey: options.publicKey } : {}),
            },
            (stage) => {
              if (!isCurrent()) return;
              this.connectingDomain.set(address.domain!);
              this.stage.set(stage);
            },
          )
          .subscribe({ next: ({ user }) => resolved(user), error: fail })
      : this.users.resolveUser({ account: address.account }).subscribe({
          next: (res) => {
            if (!isCurrent()) return;
            if (res.code === 0 && res.data) resolved(res.data);
            else if (res.code === BusinessCode.NOT_FOUND)
              this.status.set(IdentitySearchStatus.EMPTY);
            else
              fail(
                new FederatedResolveError(
                  res.code === BusinessCode.VALIDATION_FAILED
                    ? 'INVALID_ADDRESS'
                    : 'UNKNOWN',
                ),
              );
          },
          error: fail,
        });
  }
}
