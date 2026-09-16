import { loadFederationConfig } from './federation.config.js';

/** Convert the storage-only local-domain marker at an outbound federation
 * boundary. Foreign domains and protocol sentinel values are left unchanged
 * by callers that do not identify a local account. */
export function toFederationWireDomain(domain: string): string {
  return domain === 'local' ? loadFederationConfig().domain : domain;
}
