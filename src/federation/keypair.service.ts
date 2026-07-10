import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ed25519 } from '@noble/curves/ed25519.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadFederationConfig, type FederationConfig } from './federation.config.js';

interface StoredKeypair {
  keyId: string;
  publicKey: string; // base64 of raw 32 bytes — published in /.well-known/soms
  privateKey: string; // base64 of raw 32 bytes — NEVER logged, NEVER sent over the wire
  createdAt: string;
}

const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');
const fromB64 = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, 'base64'));

/**
 * Owns this server's S2S signing identity: one Ed25519 keypair, generated on first boot and
 * persisted to disk (SOMS_S2S_KEY_PATH). The DKIM-equivalent application-layer signing key
 * (the TLS cert is a separate transport-layer concern — see docs/federation-protocol.md §5.1).
 *
 * The private key MUST be backed up. Losing it = losing this server's identity: every peer has
 * trusted the OLD public key (fetched from our .well-known), so a new key cannot be proven a
 * legitimate rotation and all peers must re-approve out-of-band. This is NOT like losing a TLS
 * cert (which is re-issuable from a CA).
 *
 * keyId is versioned ("<domain>/key-1"); a future rotation adds "<domain>/key-2" alongside and
 * republishes both in /.well-known until the old one retires (§5.1 five-step rotation). v0.1
 * ships a single active key.
 */
@Injectable()
export class KeypairService implements OnModuleInit {
  private readonly logger = new Logger(KeypairService.name);
  private readonly config: FederationConfig = loadFederationConfig();
  private key!: StoredKeypair;

  onModuleInit(): void {
    this.key = this.loadOrCreate();
  }

  private loadOrCreate(): StoredKeypair {
    const path = resolve(this.config.keyPath);
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as StoredKeypair;
      this.logger.log(`Loaded S2S signing key ${parsed.keyId} from ${path}`);
      return parsed;
    }

    // First boot: generate + persist (mode 0600).
    const privateKey = ed25519.utils.randomSecretKey();
    const publicKey = ed25519.getPublicKey(privateKey);
    const created: StoredKeypair = {
      keyId: `${this.config.domain}/key-1`,
      publicKey: b64(publicKey),
      privateKey: b64(privateKey),
      createdAt: new Date().toISOString(),
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(created, null, 2), { mode: 0o600 });
    this.logger.warn(
      `Generated new S2S signing key ${created.keyId} at ${path}. ` +
        'BACK THIS FILE UP — losing it means losing this server identity (all peers must re-approve).',
    );
    return created;
  }

  /** The keyId used in outbound Signature-Input headers, e.g. "aaa.com/key-1". */
  getKeyId(): string {
    return this.key.keyId;
  }

  /** Raw 32-byte Ed25519 private key — used by SignatureService to sign outbound S2S requests. */
  getPrivateKey(): Uint8Array {
    return fromB64(this.key.privateKey);
  }

  /** Base64 raw public key — published in /.well-known/soms `keys[].ed25519`. */
  getPublicKeyB64(): string {
    return this.key.publicKey;
  }

  /** ISO timestamp of keypair creation — the admin self-check warns if the key is very young, since a
   *  freshly-regenerated key without the documented 5-step rotation leaves existing peers holding a
   *  stale public key (their inbound signature verification starts failing 401). */
  getCreatedAt(): string {
    return this.key.createdAt;
  }
}
