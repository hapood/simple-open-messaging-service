import { describe, expect, it } from 'vitest';
import {
  assertProfileNamespaceBindings,
  assertProfileNamespaceFeedPage,
} from './profile-namespace-wire.js';

const binding = () => ({
  domain: 'peer.test',
  rootPublicKey: Buffer.alloc(32, 7).toString('base64'),
  profileNamespaceFeedEndId: '3',
  generatedAt: 1000,
});
const page = () => ({
  items: [{ namespaceId: 1, feedId: '3', generatedAt: 1000 }],
  scannedThrough: '3',
  feedEndId: '9',
  hasMore: true,
});

describe('profile namespace wire generation times', () => {
  it.each([0, 1, Number.MAX_SAFE_INTEGER])(
    'accepts safe Unix milliseconds %s',
    (generatedAt) => {
      expect(() =>
        assertProfileNamespaceBindings({ ...binding(), generatedAt }),
      ).not.toThrow();
      const value = page();
      value.items[0].generatedAt = generatedAt;
      expect(() => assertProfileNamespaceFeedPage(value)).not.toThrow();
    },
  );
  it.each([
    undefined,
    null,
    -1,
    0.5,
    '1000',
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ])('rejects invalid or missing generation times %s', (generatedAt) => {
    expect(() =>
      assertProfileNamespaceBindings({ ...binding(), generatedAt }),
    ).toThrow();
    expect(() =>
      assertProfileNamespaceFeedPage({
        ...page(),
        items: [{ namespaceId: 1, feedId: '3', generatedAt }],
      }),
    ).toThrow();
  });
  it('rejects publisher self bindings in the namespace feed', () => {
    const value = page();
    value.items[0].namespaceId = 0;
    expect(() => assertProfileNamespaceFeedPage(value)).toThrow();
  });

  it('rejects omitted fields and page-level generation times', () => {
    const { generatedAt: _, ...missing } = binding();
    expect(() => assertProfileNamespaceBindings(missing)).toThrow();
    expect(() =>
      assertProfileNamespaceFeedPage({ ...page(), generatedAt: 1000 }),
    ).toThrow();
    expect(() =>
      assertProfileNamespaceFeedPage({
        ...page(),
        items: [{ namespaceId: 1, feedId: '3' }],
      }),
    ).toThrow();
  });
});
