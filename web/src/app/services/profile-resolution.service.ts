import { Injectable, Optional } from '@angular/core';
import { Observable, Subject, firstValueFrom } from 'rxjs';
import { UserService } from './user.service';
import { WebsocketService } from './websocket.service';
import { ResolutionDispatcher } from './resolution-dispatcher';
import { SessionLifecycleService } from './session-lifecycle.service';

export interface ResolvedProfile {
  namespaceId: number;
  account: string;
  domain: string;
  rev: number;
  name: string;
  bio: string;
  avatarBase64: string | null;
}
export type { ProfileSelector } from '../../../../shared/profile-selector';
import type { ProfileSelector } from '../../../../shared/profile-selector';

@Injectable({ providedIn: 'root' })
export class ProfileResolutionService {
  private readonly resolved = new Subject<{
    selector: ProfileSelector;
    profile: ResolvedProfile;
  }>();
  readonly resolved$ = this.resolved.asObservable();
  private sessionEpoch = 0;
  private readonly observedRequests = new WeakSet<
    Observable<ResolvedProfile>
  >();
  private readonly dispatcher: ResolutionDispatcher<
    ProfileSelector,
    ResolvedProfile
  >;
  constructor(
    users: UserService,
    realtime: WebsocketService,
    @Optional() lifecycle?: SessionLifecycleService,
  ) {
    lifecycle?.ended$.subscribe(() => {
      this.sessionEpoch++;
      this.dispatcher.reset();
    });
    this.dispatcher = new ResolutionDispatcher<
      ProfileSelector,
      ResolvedProfile
    >(
      realtime,
      async (selector) => {
        const response = await firstValueFrom(
          users.startProfileResolution(selector),
        );
        if (response.code !== 0 || !response.data)
          throw new Error(response.message);
        return response.data.status === 'READY'
          ? { status: 'READY', result: response.data.profile }
          : response.data;
      },
      (event) => {
        const value = event as {
          event?: string;
          status?: number;
          data?: {
            requestId?: string;
            profile?: ResolvedProfile;
            reason?: string;
          };
        };
        if (value.status !== 0 || typeof value.data?.requestId !== 'string')
          return null;
        const data = value.data;
        if (value.event === 'PROFILE_RESOLVED' && validProfile(data.profile)) {
          return { requestId: data.requestId!, result: data.profile };
        }
        if (
          value.event === 'PROFILE_FAILED' &&
          ['NOT_FOUND', 'NOT_DISCLOSED', 'TEMPORARILY_UNAVAILABLE'].includes(
            data.reason ?? '',
          )
        )
          return { requestId: data.requestId!, reason: data.reason! };
        return null;
      },
    );
  }
  resolve(selector: ProfileSelector): Observable<ResolvedProfile> {
    const normalized = normalizeSelector(selector);
    const request = this.dispatcher.resolve(normalized);
    if (this.observedRequests.has(request)) return request;
    this.observedRequests.add(request);
    const epoch = this.sessionEpoch;
    request.subscribe({
      next: (profile) => {
        if (epoch !== this.sessionEpoch) return;
        this.resolved.next({ selector: normalized, profile });
      },
      error: () => {},
    });
    return request;
  }
  /** Called immediately after subscribing: READY profiles reach the subscriber before first paint;
   * PENDING profiles continue through the shared dispatcher after the caller renders. */
  prepare(selector: ProfileSelector): Promise<void> {
    const normalized = normalizeSelector(selector);
    return this.dispatcher.prepare(normalized);
  }
}

function validProfile(
  value: ResolvedProfile | undefined,
): value is ResolvedProfile {
  return (
    !!value &&
    Number.isSafeInteger(value.namespaceId) &&
    value.namespaceId >= 0 &&
    typeof value.account === 'string' &&
    typeof value.domain === 'string' &&
    Number.isSafeInteger(value.rev) &&
    typeof value.name === 'string' &&
    typeof value.bio === 'string' &&
    (value.avatarBase64 === null || typeof value.avatarBase64 === 'string')
  );
}
function normalizeSelector(selector: ProfileSelector): ProfileSelector {
  switch (selector.type) {
    case 'EXACT':
      return {
        ...selector,
        account: selector.account.trim().toLowerCase(),
        domain: selector.domain.trim().toLowerCase(),
      };
    case 'GROUP_MEMBER':
      return {
        ...selector,
        memberAccount: selector.memberAccount.trim().toLowerCase(),
        memberDomain: selector.memberDomain.trim().toLowerCase(),
      };
    case 'MESSAGE_AUTHOR':
      return { ...selector };
  }
}
