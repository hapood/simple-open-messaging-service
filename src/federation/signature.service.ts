import { Injectable } from '@nestjs/common';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createHash } from 'node:crypto';
import * as httpMessageSignatures from 'http-message-signatures';
import {
  isInnerList,
  parseDictionary,
  serializeDictionary,
} from 'structured-headers';
import { KeypairService } from './keypair.service.js';

/** Federation v1's application profile over RFC 9421 and RFC 9530. */
const SIG_LABEL = 'sig1';
const SIGNED_COMPONENTS = [
  '@method',
  '@path',
  '@query',
  '@authority',
  'date',
  'content-digest',
] as const;
const SIGNATURE_PARAMS = ['created', 'expires', 'keyid', 'alg'] as const;

export const SIGNATURE_LIFETIME_SEC = 300;
export const ALLOWED_PAST_SKEW_SEC = 300;
export const ALLOWED_FUTURE_SKEW_SEC = 60;

export interface SignedRequest {
  method: string;
  url: URL;
  body: string;
}

export interface OutboundSignatureHeaders {
  date: string;
  'content-digest': string;
  'signature-input': string;
  signature: string;
  [key: string]: string;
}

/** RFC 9530 Content-Digest: a Structured Fields dictionary containing one SHA-256 byte sequence. */
export function contentDigest(body: string | Uint8Array): string {
  const bytes =
    typeof body === 'string' ? Buffer.from(body) : Buffer.from(body);
  const digest = Uint8Array.from(
    createHash('sha256').update(bytes).digest(),
  ).buffer;
  return serializeDictionary(
    new Map([['sha-256', [digest, new Map()] as const]]),
  );
}

interface ParsedProfile {
  created: number;
  expires: number;
  keyId: string;
}

function parseProfile(headers: OutboundSignatureHeaders): ParsedProfile | null {
  try {
    const inputs = parseDictionary(headers['signature-input']);
    const signatures = parseDictionary(headers.signature);
    if (
      inputs.size !== 1 ||
      signatures.size !== 1 ||
      !inputs.has(SIG_LABEL) ||
      !signatures.has(SIG_LABEL)
    ) {
      return null;
    }

    const input = inputs.get(SIG_LABEL);
    const signature = signatures.get(SIG_LABEL);
    if (!input || !isInnerList(input) || !signature || isInnerList(signature)) {
      return null;
    }
    if (!(signature[0] instanceof ArrayBuffer) || signature[1].size !== 0) {
      return null;
    }

    const [, params] = input;
    const created = params.get('created');
    const expires = params.get('expires');
    const keyId = params.get('keyid');
    if (
      typeof created !== 'number' ||
      !Number.isSafeInteger(created) ||
      typeof expires !== 'number' ||
      !Number.isSafeInteger(expires) ||
      typeof keyId !== 'string' ||
      !keyId
    ) {
      return null;
    }
    return { created, expires, keyId };
  } catch {
    return null;
  }
}

function requestMessage(req: SignedRequest, headers: Record<string, string>) {
  return {
    method: req.method,
    url: req.url,
    headers,
  };
}

function hasMatchingContentDigest(body: string, header: string): boolean {
  try {
    const dictionary = parseDictionary(header);
    const item = dictionary.get('sha-256');
    if (
      dictionary.size !== 1 ||
      !item ||
      isInnerList(item) ||
      !(item[0] instanceof ArrayBuffer) ||
      item[1].size !== 0
    ) {
      return false;
    }
    const expected = createHash('sha256').update(Buffer.from(body)).digest();
    return Buffer.from(item[0]).equals(expected);
  } catch {
    return false;
  }
}

@Injectable()
export class SignatureService {
  constructor(private readonly keypair: KeypairService) {}

  /** Generate the RFC 9421 signature headers for an outbound Federation request. */
  async signOutbound(
    req: SignedRequest,
    now = new Date(),
  ): Promise<OutboundSignatureHeaders> {
    const created = Math.floor(now.getTime() / 1000);
    const date = new Date(created * 1000).toUTCString();
    const digest = contentDigest(req.body);
    const keyId = this.keypair.getKeyId();
    const privateKey = this.keypair.getPrivateKey();
    const signed = await httpMessageSignatures.httpbis.signMessage(
      {
        name: SIG_LABEL,
        fields: [...SIGNED_COMPONENTS],
        params: [...SIGNATURE_PARAMS],
        paramValues: {
          created: new Date(created * 1000),
          expires: new Date((created + SIGNATURE_LIFETIME_SEC) * 1000),
          keyid: keyId,
          alg: 'ed25519',
        },
        key: {
          id: keyId,
          alg: 'ed25519',
          sign: async (data) => Buffer.from(ed25519.sign(data, privateKey)),
        },
      },
      requestMessage(req, { date, 'content-digest': digest }),
    );
    const signatureInput = signed.headers['Signature-Input'];
    const signature = signed.headers.Signature;
    if (typeof signatureInput !== 'string' || typeof signature !== 'string') {
      throw new Error(
        'HTTP Message Signature library returned invalid headers',
      );
    }
    return {
      date,
      'content-digest': digest,
      'signature-input': signatureInput,
      signature,
    };
  }

  /** Verify the digest and RFC 9421 signature with an already resolved peer public key. */
  async verifyWithKey(
    req: SignedRequest,
    headers: OutboundSignatureHeaders,
    publicKey: Uint8Array,
  ): Promise<boolean> {
    if (!this.hasValidMetadata(headers, Math.floor(Date.now() / 1000))) {
      return false;
    }
    if (!hasMatchingContentDigest(req.body, headers['content-digest'])) {
      return false;
    }
    try {
      const verified = await httpMessageSignatures.httpbis.verifyMessage(
        {
          all: true,
          requiredFields: [...SIGNED_COMPONENTS],
          requiredParams: [...SIGNATURE_PARAMS],
          keyLookup: async () => ({
            id: this.parseMetadata(headers)?.keyId,
            algs: ['ed25519'],
            verify: async (data, signature) =>
              ed25519.verify(signature, data, publicKey),
          }),
        },
        requestMessage(req, {
          date: headers.date,
          'content-digest': headers['content-digest'],
          'signature-input': headers['signature-input'],
          signature: headers.signature,
        }),
      );
      return verified === true;
    } catch {
      return false;
    }
  }

  /** Enforce the Federation profile around otherwise order-independent RFC 9421 fields. */
  hasValidMetadata(headers: OutboundSignatureHeaders, now: number): boolean {
    const profile = parseProfile(headers);
    if (!profile) return false;
    const { created, expires } = profile;
    if (created < now - ALLOWED_PAST_SKEW_SEC) return false;
    if (created > now + ALLOWED_FUTURE_SKEW_SEC) return false;
    if (expires < created || expires > created + SIGNATURE_LIFETIME_SEC) {
      return false;
    }
    if (now > expires) return false;

    const dateSeconds = Date.parse(headers.date) / 1000;
    return (
      Number.isInteger(dateSeconds) && Math.abs(dateSeconds - created) <= 1
    );
  }

  /** Return parsed profile metadata after Structured Fields validation. */
  parseMetadata(
    headers: OutboundSignatureHeaders,
  ): Readonly<ParsedProfile> | null {
    return parseProfile(headers);
  }
}
