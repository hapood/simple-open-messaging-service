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

  it('claims the sender root on Recognize independently of the recipient', async () => {
    const { svc, pub } = makeService();
    const senderRoot = Buffer.alloc(32, 4).toString('base64');
    const recipientRoot = Buffer.alloc(32, 7).toString('base64');
    for (const recipient of ['peer-b.test', 'peer-c.test']) {
      const recognize = {
        method: 'POST',
        url: new URL(`https://${recipient}/s2s/v1/recognize`),
        body: '{"namespaceId":7}',
      };
      const headers = await svc.signOutbound(recognize);
      expect(headers['s2s-root-key']).toBe(senderRoot);
      expect(headers['s2s-root-key']).not.toBe(recipientRoot);
      expect(headers['signature-input']).toContain('keyid="aaa.com/key-1"');
      expect(headers['signature-input']).not.toContain('s2s-root-key');
      await expect(svc.verifyWithKey(recognize, headers, pub)).resolves.toBe(
        true,
      );
    }
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

  it.each([
    [
      'wrong algorithm',
      (value: string) => value.replace('alg="ed25519"', 'alg="rsa-pss-sha512"'),
    ],
    ['extra parameter', (value: string) => `${value};nonce="unexpected"`],
    [
      'wrong component order',
      (value: string) =>
        value.replace('"@method" "@path"', '"@path" "@method"'),
    ],
    [
      'extra component',
      (value: string) =>
        value.replace('"content-digest")', '"content-digest" "x-extra")'),
    ],
  ])('rejects a Signature-Input with %s', async (_name, mutate) => {
    const { svc } = makeService();
    const headers = await svc.signOutbound(req);
    expect(
      svc.hasValidMetadata(
        { ...headers, 'signature-input': mutate(headers['signature-input']) },
        Math.floor(Date.now() / 1000),
      ),
    ).toBe(false);
  });

  it('requires Date to equal created exactly', async () => {
    const { svc } = makeService();
    const headers = await svc.signOutbound(req);
    const created = svc.parseMetadata(headers)!.created;
    expect(
      svc.hasValidMetadata(
        { ...headers, date: new Date((created + 1) * 1000).toUTCString() },
        created,
      ),
    ).toBe(false);
  });
});
