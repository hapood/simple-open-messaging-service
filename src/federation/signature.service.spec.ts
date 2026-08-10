import { describe, it, expect, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createHash } from 'node:crypto';
import { SignatureService, contentDigest } from './signature.service.js';
import type { KeypairService } from './keypair.service.js';

describe('SignatureService (RFC 9421 + Ed25519)', () => {
  const req = {
    method: 'POST',
    path: '/s2s/v1/feed-revisions',
    query: '?cursor=abc%2D1',
    authority: 'peer.com',
    body: '{"hi":1}',
  };

  function makeService() {
    const priv = ed25519.utils.randomSecretKey();
    const pub = ed25519.getPublicKey(priv);
    const keypair = {
      getKeyId: () => 'aaa.com/key-1',
      getPrivateKey: () => priv,
    } as unknown as KeypairService;
    return { svc: new SignatureService(keypair), pub };
  }

  it('contentDigest = sha-256 base64 of the body', () => {
    expect(contentDigest('hello')).toBe(
      'sha-256=' + createHash('sha256').update('hello').digest('base64'),
    );
  });

  it('round-trip: a signed request verifies with the correct public key', () => {
    const { svc, pub } = makeService();
    const headers = svc.signOutbound(req);
    expect(headers['signature-input']).toMatch(/^sig1=\("@method"/);
    expect(headers.signature).toMatch(/^sig1=:[^:]+:$/);
    expect(svc.verifyWithKey(req, headers, pub)).toBe(true);
  });

  it('rejects a tampered body (content-digest mismatch)', () => {
    const { svc, pub } = makeService();
    const headers = svc.signOutbound(req);
    expect(svc.verifyWithKey({ ...req, body: '{"hi":2}' }, headers, pub)).toBe(
      false,
    );
  });

  it('rejects the wrong public key', () => {
    const { svc } = makeService();
    const otherPub = ed25519.getPublicKey(ed25519.utils.randomSecretKey());
    const headers = svc.signOutbound(req);
    expect(svc.verifyWithKey(req, headers, otherPub)).toBe(false);
  });

  it('rejects a malformed Signature-Input', () => {
    const { svc, pub } = makeService();
    const headers = svc.signOutbound(req);
    expect(
      svc.verifyWithKey(req, { ...headers, 'signature-input': 'garbage' }, pub),
    ).toBe(false);
  });

  it('rejects a tampered authority (signature covers @authority)', () => {
    const { svc, pub } = makeService();
    const headers = svc.signOutbound(req);
    expect(
      svc.verifyWithKey({ ...req, authority: 'evil.com' }, headers, pub),
    ).toBe(false);
  });

  it('rejects a tampered query (signature covers the raw @query)', () => {
    const { svc, pub } = makeService();
    const headers = svc.signOutbound(req);
    expect(
      svc.verifyWithKey({ ...req, query: '?cursor=other' }, headers, pub),
    ).toBe(false);
  });

  it('rejects an expired signature', () => {
    const { svc, pub } = makeService();
    const now = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now);
    const headers = svc.signOutbound(req);
    spy.mockReturnValue(now + 301_000);
    expect(svc.verifyWithKey(req, headers, pub)).toBe(false);
    spy.mockRestore();
  });

  it('rejects a signature created too far in the future', () => {
    const { svc, pub } = makeService();
    const now = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);
    const headers = svc.signOutbound(req);
    spy.mockReturnValue(now);
    expect(svc.verifyWithKey(req, headers, pub)).toBe(false);
    spy.mockRestore();
  });

  it('rejects malformed timestamp metadata before crypto verification', () => {
    const { svc, pub } = makeService();
    const headers = svc.signOutbound(req);
    const malformed = {
      ...headers,
      'signature-input': headers['signature-input'].replace(
        /;created=\d+/,
        ';created=1.5',
      ),
    };
    expect(svc.verifyWithKey(req, malformed, pub)).toBe(false);
  });
});
