import { inject, Pipe, type PipeTransform } from '@angular/core';
import { map, of, type Observable } from 'rxjs';
import { ProfileNamespaceRepository } from '../services/profile-namespace-store.service';
import type { ProfileNamespaceBinding } from '../services/webdb-storage';

export function namespaceDisplayDomain(
  binding: ProfileNamespaceBinding,
): string | null {
  if (!binding.domain) return null;
  return binding.status === 'ARCHIVED'
    ? `${binding.profileNamespaceId}.archive.${binding.domain}`
    : binding.domain;
}

/** Resolves the current display domain for a server-local namespace id.
 * Identity remains `(namespaceId, account)`; the mutable domain binding is
 * presentation data loaded independently from the namespace repository. */
@Pipe({
  name: 'namespaceDomain',
  standalone: true,
  pure: true,
})
export class NamespaceDomainPipe implements PipeTransform {
  private readonly namespaces = inject(ProfileNamespaceRepository);

  transform(namespaceId: number | null | undefined): Observable<string | null> {
    if (namespaceId === null || namespaceId === undefined) return of(null);
    return this.namespaces
      .resolve({ publisherNamespaceId: 0, profileNamespaceId: namespaceId })
      .pipe(map(namespaceDisplayDomain));
  }
}
