import { describe, expect, it } from 'vitest';
import type { FederationMessageFeedMessage } from './federation-message-feed.service.js';
import { FederationInboundMessageValidatorService } from './federation-inbound-message-validator.service.js';

const message = (): FederationMessageFeedMessage => ({
  thread: { account: 'alice', peerAccount: 'bob' },
  authorRef: 'THREAD_ACCOUNT',
  namespaceId: 0,
  seq: 1,
  profileRev: 2,
  originSeq: null,
  contentType: 'PURE_TEXT',
  content: '{"text":"hello"}',
  createdAt: 1_700_000_000_000,
  originCreatedAt: null,
  assets: [],
});

describe('FederationInboundMessageValidatorService', () => {
  const validator = new FederationInboundMessageValidatorService();

  it('rejects non-canonical wire account grammars', () => {
    expect(() =>
      validator.assertEnvelope({
        ...message(),
        thread: { account: 'Alice', peerAccount: 'bob' },
      }),
    ).toThrow('invalid thread address');
    const { authorRef: _authorRef, ...base } = message() as Extract<
      FederationMessageFeedMessage,
      { authorRef: string }
    >;
    expect(() =>
      validator.assertEnvelope({
        ...base,
        thread: { account: '!x' },
        author: { account: 'alice', domain: 'peer.test' },
      } as FederationMessageFeedMessage),
    ).toThrow('invalid thread address');
  });

  it('canonicalizes nested content when fingerprinting an immutable envelope', () => {
    const left = message();
    const right = { ...message(), content: '{"text":"hello"}' };
    expect(validator.immutableEnvelopeDigest(left)).toBe(
      validator.immutableEnvelopeDigest(right),
    );
  });

  it.each([
    ['author', { authorRef: 'THREAD_PEER_ACCOUNT' }],
    ['profile revision', { profileRev: 3 }],
    ['content type', { contentType: 'LINK' }],
    ['content', { content: '{"text":"different"}' }],
    ['quote', { quoteTarget: { seq: 0 } }],
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
