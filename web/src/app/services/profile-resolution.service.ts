import { Injectable } from '@angular/core';
import { Observable, firstValueFrom, of } from 'rxjs';
import { UserService } from './user.service';
import { WebsocketService } from './websocket.service';
import { ResolutionDispatcher } from './resolution-dispatcher';

export interface ResolvedProfile {
  account: string;
  domain: string;
  rev: number;
  name: string;
  bio: string;
  avatarBase64: string | null;
}
export type ProfileSelector =
  | { account: string; domain: string; rev: number }
  | { threadId: number; messageSeq: number }
  | { threadId: number; memberAccount: string; memberDomain: string };

@Injectable({ providedIn: 'root' })
export class ProfileResolutionService {
  private readonly results = new Map<string, ResolvedProfile>();
  private readonly dispatcher: ResolutionDispatcher<
    ProfileSelector,
    ResolvedProfile
  >;
  constructor(users: UserService, realtime: WebsocketService) {
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
          this.remember(data.profile);
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
    const cached =
      'rev' in normalized
        ? this.results.get(
            profileKey(normalized.account, normalized.domain, normalized.rev),
          )
        : undefined;
    if (cached) return of(cached);
    const request = this.dispatcher.resolve(normalized);
    request.subscribe({
      next: (profile) => this.remember(profile),
      error: () => {},
    });
    return request;
  }
  private remember(profile: ResolvedProfile) {
    const key = profileKey(profile.account, profile.domain, profile.rev);
    this.results.delete(key);
    this.results.set(key, profile);
    while (this.results.size > 1000)
      this.results.delete(this.results.keys().next().value!);
  }
}
function validProfile(
  value: ResolvedProfile | undefined,
): value is ResolvedProfile {
  return (
    !!value &&
    typeof value.account === 'string' &&
    typeof value.domain === 'string' &&
    Number.isSafeInteger(value.rev) &&
    typeof value.name === 'string' &&
    typeof value.bio === 'string' &&
    (value.avatarBase64 === null || typeof value.avatarBase64 === 'string')
  );
}
function normalizeSelector(selector: ProfileSelector): ProfileSelector {
  if ('rev' in selector)
    return {
      account: selector.account.trim().toLowerCase(),
      domain: selector.domain.trim().toLowerCase(),
      rev: selector.rev,
    };
  if ('messageSeq' in selector)
    return { threadId: selector.threadId, messageSeq: selector.messageSeq };
  return {
    threadId: selector.threadId,
    memberAccount: selector.memberAccount.trim().toLowerCase(),
    memberDomain: selector.memberDomain.trim().toLowerCase(),
  };
}

function profileKey(account: string, domain: string, rev: number): string {
  return JSON.stringify([domain.toLowerCase(), account.toLowerCase(), rev]);
}
