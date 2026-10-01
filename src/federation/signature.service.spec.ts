import { describe, it, expect, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createHash } from 'node:crypto';
import { SignatureService, contentDigest } from './signature.service.js';
import type { KeypairService } from './keypair.service.js';

describe('SignatureService (RFC 9421 + Ed25519)', () => {
  const req = {
    method: 'POST',
    url: new URL('https://peer.com/s2s/v1/feed-heads?cursor=abc%2D1'),
    body: '{"hi":1}',
  };

  function makeService() {
    const priv = ed25519.utils.randomSecretKey();
    const pub = ed25519.getPublicKey(priv);
    const keypair = {
      getKeyId: () => 'aaa.com/key-1',
      getPrivateKey: () => priv,
      getRootPublicKeyB64: () => Buffer.alloc(32, 4).toString('base64'),
    } as unknown as KeypairService;
    return { svc: new SignatureService(keypair), pub };
  }

  it('contentDigest uses the RFC 9530 SHA-256 byte-sequence form', () => {
    expect(contentDigest('hello')).toBe(
      'sha-256=:' + createHash('sha256').update('hello').digest('base64') + ':',
    );
  });

  it('round-trip: a signed request verifies with the correct public key', async () => {
    const { svc, pub } = makeService();
    const headers = await svc.signOutbound(req);
    expect(headers['signature-input']).toMatch(/^sig1=\("@method"/);
    expect(headers.signature).toMatch(/^sig1=:[^:]+:$/);
    // The unsigned routing hint rides along but never enters the signature base.
    expect(headers['s2s-root-key']).toBe(
      Buffer.alloc(32, 4).toString('base64'),
    );
    await expect(svc.verifyWithKey(req, headers, pub)).resolves.toBe(true);
  });

  it('preserves a fixed expiry when signing a later terminal retry', async () => {
    const { svc } = makeService();
    const expiry = 1_700_000_300;
    for (const created of [1_700_000_000, 1_700_000_020]) {
      const headers = await svc.signOutbound(
        req,
        new Date(created * 1000),
        expiry,
      );
      expect(headers['signature-input']).toContain(`;created=${created}`);
      expect(headers['signature-input']).toContain(`;expires=${expiry}`);
    }
  });

  it.each([1_699_999_999, 1_700_000_301, Number.NaN, 1_700_000_010.5])(
    'rejects an invalid fixed signature expiry %s',
    async (expiry) => {
      const { svc } = makeService();
      await expect(
        svc.signOutbound(req, new Date(1_700_000_000_000), expiry),
      ).rejects.toThrow('signing window');
    },
  );

  it('rejects a tampered body (content-digest mismatch)', async () => {
    const { svc, pub } = makeService();
    const headers = await svc.signOutbound(req);
    await expect(
      svc.verifyWithKey({ ...req, body: '{"hi":2}' }, headers, pub),
    ).resolves.toBe(false);
  });

  it('rejects the wrong public key', async () => {
    const { svc } = makeService();
    const otherPub = ed25519.getPublicKey(ed25519.utils.randomSecretKey());
    const headers = await svc.signOutbound(req);
    await expect(svc.verifyWithKey(req, headers, otherPub)).resolves.toBe(
      false,
    );
  });

  it('rejects a malformed Signature-Input', async () => {
    const { svc, pub } = makeService();
    const headers = await svc.signOutbound(req);
    await expect(
      svc.verifyWithKey(req, { ...headers, 'signature-input': 'garbage' }, pub),
    ).resolves.toBe(false);
  });

  it('rejects a tampered authority (signature covers @authority)', async () => {
    const { svc, pub } = makeService();
    const headers = await svc.signOutbound(req);
    await expect(
      svc.verifyWithKey(
        {
          ...req,
          url: new URL(req.url.toString().replace('peer.com', 'evil.com')),
        },
        headers,
        pub,
      ),
    ).resolves.toBe(false);
  });

  it('rejects a tampered query (signature covers the raw @query)', async () => {
    const { svc, pub } = makeService();
    const headers = await svc.signOutbound(req);
    const tampered = new URL(req.url);
    tampered.search = '?cursor=other';
    await expect(
      svc.verifyWithKey({ ...req, url: tampered }, headers, pub),
    ).resolves.toBe(false);
  });

  it('rejects an expired signature', async () => {
    const { svc, pub } = makeService();
    const now = Date.now();
    const headers = await svc.signOutbound(req, new Date(now - 301_000));
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now);
    await expect(svc.verifyWithKey(req, headers, pub)).resolves.toBe(false);
    spy.mockRestore();
  });

  it('rejects a signature created too far in the future', async () => {
    const { svc, pub } = makeService();
    const now = Date.now();
    const headers = await svc.signOutbound(req, new Date(now + 61_000));
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now);
    await expect(svc.verifyWithKey(req, headers, pub)).resolves.toBe(false);
    spy.mockRestore();
  });

  it('rejects malformed timestamp metadata before crypto verification', async () => {
    const { svc, pub } = makeService();
    const headers = await svc.signOutbound(req);
    const malformed = {
      ...headers,
      'signature-input': headers['signature-input'].replace(
        /;created=\d+/,
        ';created=1.5',
      ),
    };
    await expect(svc.verifyWithKey(req, malformed, pub)).resolves.toBe(false);
  });
});
