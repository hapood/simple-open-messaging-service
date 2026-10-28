import { isValidSomfpDomain } from '../common/account.js';
import type {
  ProfileNamespaceBindings,
  ProfileNamespaceFeedPage,
} from './profile-namespace-feed.service.js';

function closedObject(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new Error('malformed profile namespace response shape');
  return value as Record<string, unknown>;
}

function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function decimal(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value);
}

/** Generation times are required diagnostic metadata, never ordering keys. */
export function assertProfileNamespaceFeedPage(
  value: unknown,
): asserts value is ProfileNamespaceFeedPage {
  const page = closedObject(value, [
    'items',
    'scannedThrough',
    'feedEndId',
    'hasMore',
  ]);
  if (
    !Array.isArray(page.items) ||
    !decimal(page.scannedThrough) ||
    !decimal(page.feedEndId) ||
    typeof page.hasMore !== 'boolean'
  )
    throw new Error('malformed profile namespace feed page');
  for (const value of page.items) {
    const item = closedObject(value, ['namespaceId', 'feedId', 'generatedAt']);
    if (!integer(item.generatedAt)) throw new Error('invalid item.generatedAt');
    if (
      !integer(item.namespaceId) ||
      item.namespaceId === 0 ||
      !decimal(item.feedId) ||
      item.feedId === '0'
    )
      throw new Error('malformed profile namespace feed item');
  }
}

export function assertProfileNamespaceBindings(
  value: unknown,
): asserts value is ProfileNamespaceBindings {
  const binding = closedObject(value, [
    'domain',
    'rootPublicKey',
    'profileNamespaceFeedEndId',
    'generatedAt',
  ]);
  if (!integer(binding.generatedAt)) throw new Error('invalid generatedAt');
  if (
    typeof binding.domain !== 'string' ||
    !isValidSomfpDomain(binding.domain) ||
    typeof binding.rootPublicKey !== 'string' ||
    !/^[A-Za-z0-9+/]{43}=$/.test(binding.rootPublicKey) ||
    Buffer.from(binding.rootPublicKey, 'base64').toString('base64') !==
      binding.rootPublicKey ||
    !decimal(binding.profileNamespaceFeedEndId)
  )
    throw new Error('malformed profile namespace bindings');
}
