import { Injectable, Injector, inject } from '@angular/core';
import {
  Observable,
  ReplaySubject,
  combineLatest,
  finalize,
  map,
  of,
  share,
  catchError,
  startWith,
} from 'rxjs';
import { avatarProfileDemand } from '../../services/avatar-profile-ref';
import {
  ProfileRepository,
  type ResolvedProfile,
} from '../../services/profile-store.service';
import { ProfileNamespaceRepository } from '../../services/profile-namespace-store.service';
import { namespaceDisplayDomain } from '../../services/profile-namespace-domain';
import { assetUrl } from '../../services/runtime';
import { avatarColorKey, type AvatarSource } from './avatar-source';
import type { AvatarView } from './avatar-view';
import { UserAvatarType } from './model';

/** Profile bytes are leased for as long as any mounted presentation uses them. */
const images = new Map<string, { url: string; users: number }>();
function leaseImage(profile: ResolvedProfile): {
  url: string | null;
  release(): void;
} {
  if (!profile.avatarDigest || !profile.avatarBlob)
    return { url: null, release() {} };
  const digest = profile.avatarDigest;
  let entry = images.get(digest);
  if (!entry) {
    entry = { url: URL.createObjectURL(profile.avatarBlob), users: 0 };
    images.set(digest, entry);
  }
  entry.users++;
  let released = false;
  return {
    url: entry.url,
    release() {
      if (released) return;
      released = true;
      if (--entry.users === 0) {
        images.delete(digest);
        URL.revokeObjectURL(entry.url);
      }
    },
  };
}

/** Immediate presentation while async profile/badge resolution is pending. */
export function initialAvatarView(source: AvatarSource): AvatarView {
  if (source.kind === 'forward')
    return {
      name: source.name,
      imageUrl: source.imageUrl ? assetUrl(source.imageUrl) : null,
      type: UserAvatarType.OTHER,
    };
  return {
    type: source.type ?? UserAvatarType.OTHER,
    colorKey: avatarColorKey(source),
    loading: source.loading,
    name:
      source.kind === 'demand'
        ? source.fallbackName || source.account || ''
        : source.name,
    imageUrl:
      source.kind === 'snapshot' && source.imageUrl
        ? assetUrl(source.imageUrl)
        : null,
    federatedDomain:
      source.domainSource?.type === 'snapshot'
        ? source.domainSource.domain
        : null,
  };
}

/** Source adapters own resolution and resources; renderers consume only AvatarView. */
@Injectable({ providedIn: 'root' })
export class AvatarPresentationService {
  private readonly injector = inject(Injector);
  private readonly active = new Map<string, Observable<AvatarView>>();

  resolve(source: AvatarSource): Observable<AvatarView> {
    // Forward resource selection belongs to its domain; it exposes no author identity.
    if (source.kind === 'forward') return of(initialAvatarView(source));
    const key = JSON.stringify(source);
    if (source.kind === 'demand') {
      const existing = this.active.get(key);
      if (existing) return existing;
    }
    const base = initialAvatarView(source);
    const domain = source.domainSource;
    const domain$ = !domain
      ? of(null)
      : domain.type === 'snapshot'
        ? of(domain.domain)
        : (domain.type === 'namespace' && domain.namespaceId === 0) ||
            (domain.type === 'profile-namespace' &&
              domain.publisherNamespaceId === 0 &&
              domain.profileNamespaceId === 0)
          ? of(null)
          : this.injector
              .get(ProfileNamespaceRepository)
              .resolve(
                domain.type === 'namespace'
                  ? {
                      publisherNamespaceId: 0,
                      profileNamespaceId: domain.namespaceId,
                    }
                  : {
                      publisherNamespaceId: domain.publisherNamespaceId,
                      profileNamespaceId: domain.profileNamespaceId,
                    },
              )
              .pipe(
                map(namespaceDisplayDomain),
                catchError(() => of(null)),
                startWith(null),
              );
    if (source.kind === 'snapshot')
      return domain$.pipe(
        map((federatedDomain) => ({
          ...base,
          federatedDomain,
        })),
      );
    const demand = avatarProfileDemand(source.profile);
    const profile$ = new Observable<{ name: string; imageUrl: string | null }>(
      (subscriber) => {
        let lease: ReturnType<typeof leaseImage> | undefined;
        const fallback = {
          name: source.fallbackName || source.account || '',
          imageUrl: null,
        };
        subscriber.next(fallback);
        const subscription = demand
          ? this.injector
              .get(ProfileRepository)
              .resolve(demand)
              .subscribe({
                next: (profile) => {
                  const previous = lease;
                  lease = leaseImage(profile);
                  subscriber.next({
                    name:
                      profile.name ||
                      source.fallbackName ||
                      source.account ||
                      '',
                    imageUrl: lease.url,
                  });
                  previous?.release();
                },
                error: () => {
                  subscriber.next({
                    name: source.fallbackName || source.account || '',
                    imageUrl: null,
                  });
                  lease?.release();
                  lease = undefined;
                },
              })
          : undefined;
        return () => {
          subscription?.unsubscribe();
          lease?.release();
        };
      },
    );
    const view$ = combineLatest([profile$, domain$]).pipe(
      map(([profile, federatedDomain]) => ({
        ...base,
        ...profile,
        federatedDomain,
      })),
      finalize(() => {
        if (this.active.get(key) === view$) this.active.delete(key);
      }),
      share({
        connector: () => new ReplaySubject<AvatarView>(1),
        resetOnError: true,
        resetOnComplete: true,
        resetOnRefCountZero: true,
      }),
    );
    this.active.set(key, view$);
    return view$;
  }
}
