import { inject, Injectable } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';
import { namespaceDisplayDomain } from '../pipes/namespace-domain.pipe';
import { ProfileNamespaceRepository } from './profile-namespace-store.service';

/** Display domain of the local identity namespace (namespace zero).
 *
 *  The session profile response carries pure namespace coordinates, so any
 *  self-address rendering or self-matching against card/facade domains that
 *  still carry a domain string resolves the local domain here instead. The
 *  binding for (publisher 0, namespace 0) is the identity row of this server
 *  and is pulled by the namespace sync at session start. */
@Injectable({ providedIn: 'root' })
export class LocalDomainService {
  private readonly namespaces = inject(ProfileNamespaceRepository);

  /** Current local display domain, or null before the first binding lands. */
  readonly domain = toSignal(
    this.namespaces
      .resolve({ publisherNamespaceId: 0, profileNamespaceId: 0 })
      .pipe(map(namespaceDisplayDomain)),
    { initialValue: null },
  );
}
