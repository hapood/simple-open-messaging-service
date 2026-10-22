import type { ProfileNamespaceBinding } from './webdb-storage';

/** Display domains are derived from bindings, never used as identity keys. */
export function namespaceDisplayDomain(
  binding: ProfileNamespaceBinding,
): string | null {
  if (!binding.domain) return null;
  return binding.status === 'ARCHIVED'
    ? `${binding.profileNamespaceId}.archive.${binding.domain}`
    : binding.domain;
}
