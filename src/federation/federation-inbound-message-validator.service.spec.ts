import { describe, expect, it } from 'vitest';
import type { FederationMessageFeedMessage } from './federation-message-feed.service.js';
import { FederationInboundMessageValidatorService } from './federation-inbound-message-validator.service.js';

const message = (): FederationMessageFeedMessage => ({
  thread: { account: 'alice', peerAccount: 'bob' },
  author: { ref: 'THREAD_ACCOUNT', namespaceId: 0 },
  seq: 1,
  profileRev: 2,
  originSeq: null,
  contentType: 'PURE_TEXT',
  content: '{"text":"hello"}',
  createdAt: 1_700_000_000_000,
  originCreatedAt: null,
  assets: [],
});

const groupMessage = (): FederationMessageFeedMessage => ({
  ...message(),
  thread: { account: '!group' },
  author: { account: 'alice', namespaceId: 1 },
});

describe('FederationInboundMessageValidatorService', () => {
  const validator = new FederationInboundMessageValidatorService();

  it.each([{ seq: 8 }, { originSeq: 42 }])(
    'requires a digest with positive coordinate %j without requiring a target body',
    (quoteTarget) => {
      expect(() =>
        validator.assertEnvelope({
          ...message(),
          quoteTarget,
          quoteDigest: 'a'.repeat(64),
        }),
      ).not.toThrow();
      expect(() =>
        validator.assertEnvelope({ ...message(), quoteTarget }),
      ).toThrow('must appear together');
    },
  );

  it('rejects orphan digests and zero coordinates even with a digest', () => {
    expect(() =>
      validator.assertEnvelope({ ...message(), quoteDigest: 'a'.repeat(64) }),
    ).toThrow('must appear together');
    for (const quoteTarget of [{ seq: 0 }, { originSeq: 0 }]) {
      expect(() =>
        validator.assertEnvelope({
          ...message(),
          quoteTarget,
          quoteDigest: 'a'.repeat(64),
        }),
      ).toThrow('invalid federated reply target');
    }
  });

  it('rejects non-canonical wire account grammars', () => {
    expect(() =>
      validator.assertEnvelope({
        ...message(),
        thread: { account: 'Alice', peerAccount: 'bob' },
      }),
    ).toThrow('invalid thread address');
    expect(() =>
      validator.assertEnvelope({
        ...groupMessage(),
        thread: { account: '!x' },
      }),
    ).toThrow('invalid thread address');
  });

  it.each([message, groupMessage])(
    'accepts a single nested author namespace',
    (factory) => {
      const item = factory();
      expect(() => validator.assertEnvelope(item)).not.toThrow();
      expect(() =>
        validator.assertEnvelope({
          ...item,
          namespaceId: 1,
        } as FederationMessageFeedMessage),
      ).toThrow('invalid fields');
      expect(() =>
        validator.assertEnvelope({
          ...item,
          authorRef: 'THREAD_ACCOUNT',
        } as FederationMessageFeedMessage),
      ).toThrow('invalid fields');
      expect(() =>
        validator.assertEnvelope({
          ...item,
          author: { ...item.author, domain: 'peer.test' },
        } as FederationMessageFeedMessage),
      ).toThrow('invalid fields');
      expect(() =>
        validator.assertEnvelope({
          ...item,
          author: { ...item.author, namespaceId: -1 },
        }),
      ).toThrow('invalid namespaceId');
      expect(() =>
        validator.assertEnvelope({
          ...item,
          author: { ...item.author, namespaceId: '1' },
        } as unknown as FederationMessageFeedMessage),
      ).toThrow('invalid namespaceId');
    },
  );

  it('rejects missing, mixed, or wrong-kind author selectors', () => {
    for (const item of [
      { ...groupMessage(), author: { account: 'alice' } },
      { ...groupMessage(), author: { ref: 'THREAD_ACCOUNT', namespaceId: 1 } },
      { ...message(), author: { account: 'alice', namespaceId: 0 } },
      {
        ...message(),
        author: { ref: 'THREAD_ACCOUNT', account: 'alice', namespaceId: 0 },
      },
      { ...message(), author: { ref: ['THREAD_ACCOUNT'], namespaceId: 0 } },
    ]) {
      expect(() =>
        validator.assertEnvelope(
          item as unknown as FederationMessageFeedMessage,
        ),
      ).toThrow();
    }
  });

  it('canonicalizes nested content when fingerprinting an immutable envelope', () => {
    const left = message();
    const right = { ...message(), content: '{"text":"hello"}' };
    expect(validator.immutableEnvelopeDigest(left)).toBe(
      validator.immutableEnvelopeDigest(right),
    );
  });

  it.each([
    ['author', { author: { ref: 'THREAD_PEER_ACCOUNT', namespaceId: 1 } }],
    ['author namespace', { author: { ref: 'THREAD_ACCOUNT', namespaceId: 2 } }],
    ['profile revision', { profileRev: 3 }],
    ['content type', { contentType: 'LINK' }],
    ['content', { content: '{"text":"different"}' }],
    ['quote', { quoteTarget: { seq: 8 }, quoteDigest: 'a'.repeat(64) }],
    ['asset descriptors', { assets: [{ digest: 'a'.repeat(64), bytes: 1 }] }],
    ['created time', { createdAt: 1_700_000_000_001 }],
  ])('changes the envelope fingerprint when %s changes', (_name, change) => {
    expect(
      validator.immutableEnvelopeDigest({
        ...message(),
        ...change,
      } as FederationMessageFeedMessage),
    ).not.toBe(validator.immutableEnvelopeDigest(message()));
  });
});
