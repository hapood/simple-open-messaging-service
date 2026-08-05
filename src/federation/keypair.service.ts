import {
  HttpStatus,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { createHash, createHmac, hkdfSync } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { DatabaseService } from '../database/database.service.js';
import { localFederationIdentity } from '../database/schema.js';
import {
  loadFederationConfig,
  type FederationConfig,
} from './federation.config.js';

interface StoredIdentityKey {
  keyId: string;
  publicKey: string;
  privateKey: string;
  createdAt: string;
}

interface StoredSigningKey extends StoredIdentityKey {
  status: 'active';
}

interface StoredKeyFileV1 {
  version: 1;
  domain: string;
  identityEpoch: number;
  rootKey: StoredIdentityKey;
  signingKeys: StoredSigningKey[];
}

export type LocalFederationIdentityStatus =
  | { available: true }
  | { available: false; reason: string };

const b64 = (value: Uint8Array): string =>
  Buffer.from(value).toString('base64');
const fromB64 = (value: string): Uint8Array =>
  Uint8Array.from(Buffer.from(value, 'base64'));
const normalizeDomain = (domain: string): string =>
  domain.trim().toLowerCase().replace(/\.+$/, '');

/**
 * Owns this installation's immutable S2S root identity and active signing key.
 *
 * The file uses the v1 root-key + signing-key structure. A missing file is generated only for a
 * database with no federation history. If history exists, local chat remains usable while every S2S
 * path is disabled until the original file is restored. The database stores only a domain +
 * root-fingerprint anchor, never private material.
 */
@Injectable()
export class KeypairService implements OnApplicationBootstrap {
  private readonly logger = new Logger(KeypairService.name);
  private readonly config: FederationConfig = loadFederationConfig();
  private keyFile: StoredKeyFileV1 | undefined;
  private status: LocalFederationIdentityStatus = {
    available: false,
    reason: 'federation identity has not been initialized',
  };

  constructor(private readonly database: DatabaseService) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.initialize();
  }

  /** Public for focused startup tests; normal application startup calls it through the Nest hook. */
  async initialize(): Promise<void> {
    const path = resolve(this.config.keyPath);
    try {
      const anchor = await this.readAnchor();
      if (!existsSync(path)) {
        if (anchor || (await this.hasFederationHistory())) {
          this.disable(
            `S2S key file is missing at ${path}, but federation history exists; restore the original backup`,
          );
          return;
        }
        this.keyFile = this.createFresh(path);
      } else {
        this.keyFile = this.readAndValidate(path);
      }

      const keyFile = this.keyFile;
      if (!keyFile) throw new Error('key file did not initialize');
      const configuredDomain = normalizeDomain(this.config.domain);
      if (normalizeDomain(keyFile.domain) !== configuredDomain) {
        this.disable(
          `SOMS_DOMAIN=${configuredDomain} does not match key identity domain=${keyFile.domain}`,
        );
        return;
      }

      const fingerprint = this.fingerprint(keyFile.rootKey.publicKey);
      if (anchor) {
        if (
          normalizeDomain(anchor.domain) !== configuredDomain ||
          anchor.identityEpoch !== keyFile.identityEpoch ||
          anchor.rootKeyFingerprint !== fingerprint
        ) {
          this.disable(
            'configured domain or root key does not match the database identity anchor',
          );
          return;
        }
      } else {
        await this.database.db
          .insert(localFederationIdentity)
          .values({
            domain: configuredDomain,
            identityEpoch: keyFile.identityEpoch,
            rootKeyFingerprint: fingerprint,
          })
          .onConflictDoNothing();
        const stored = await this.readAnchor();
        if (
          !stored ||
          normalizeDomain(stored.domain) !== configuredDomain ||
          stored.identityEpoch !== keyFile.identityEpoch ||
          stored.rootKeyFingerprint !== fingerprint
        ) {
          this.disable(
            'database identity anchor raced with a different local identity',
          );
          return;
        }
      }

      this.status = { available: true };
      this.logger.log(
        `Loaded S2S identity ${this.getKeyId()} (${fingerprint}) from ${path}`,
      );
    } catch (error) {
      this.keyFile = undefined;
      this.disable(
        `S2S identity initialization failed: ${(error as Error).message}`,
      );
    }
  }

  getStatus(): LocalFederationIdentityStatus {
    return this.status;
  }

  assertAvailable(): void {
    if (!this.status.available) {
      throw new BusinessException(
        BusinessCode.FEDERATION_LOCAL_IDENTITY_LOST,
        this.status.reason,
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  getKeyId(): string {
    return this.activeKey().keyId;
  }

  getPrivateKey(): Uint8Array {
    return fromB64(this.activeKey().privateKey);
  }

  getPublicKeyB64(): string {
    return this.activeKey().publicKey;
  }

  getRootPublicKeyB64(): string {
    this.assertAvailable();
    return this.keyFile!.rootKey.publicKey;
  }

  getCreatedAt(): string {
    return this.activeKey().createdAt;
  }

  getIdentityEpoch(): number {
    this.assertAvailable();
    return this.keyFile!.identityEpoch;
  }

  getRootKeyFingerprint(): string {
    this.assertAvailable();
    return this.fingerprint(this.keyFile!.rootKey.publicKey);
  }

  getPairwiseServerId(peerDomain: string): string {
    this.assertAvailable();
    const rootSeed = fromB64(this.keyFile!.rootKey.privateKey);
    const identityKey = Buffer.from(
      hkdfSync(
        'sha256',
        rootSeed,
        Buffer.alloc(0),
        'soms-pairwise-identity-v1',
        32,
      ),
    );
    return createHmac('sha256', identityKey)
      .update(normalizeDomain(peerDomain), 'utf8')
      .digest('base64url');
  }

  private activeKey(): StoredSigningKey {
    this.assertAvailable();
    const key = this.keyFile!.signingKeys.find(
      (candidate) => candidate.status === 'active',
    );
    if (!key) throw new Error('S2S identity has no active signing key');
    return key;
  }

  private async readAnchor() {
    return this.database.db.query.localFederationIdentity.findFirst();
  }

  private async hasFederationHistory(): Promise<boolean> {
    const result = await this.database.db.execute(sql`
      SELECT
        EXISTS (SELECT 1 FROM "FederatedPeer" LIMIT 1)
        OR EXISTS (SELECT 1 FROM "User" WHERE "isForeigner" = true LIMIT 1)
        OR EXISTS (SELECT 1 FROM "FederatedPeerEvent" LIMIT 1)
        OR EXISTS (SELECT 1 FROM "S2SKeyCache" LIMIT 1)
        OR EXISTS (SELECT 1 FROM "S2SFriendOpSeen" LIMIT 1)
        OR EXISTS (SELECT 1 FROM "FederationDeletedCursor" LIMIT 1)
        AS "hasHistory"
    `);
    return result.rows[0]?.hasHistory === true;
  }

  private createFresh(path: string): StoredKeyFileV1 {
    const privateKey = ed25519.utils.randomSecretKey();
    const publicKey = ed25519.getPublicKey(privateKey);
    const createdAt = new Date().toISOString();
    const domain = normalizeDomain(this.config.domain);
    const rootKey: StoredIdentityKey = {
      keyId: `${domain}/root-1`,
      publicKey: b64(publicKey),
      privateKey: b64(privateKey),
      createdAt,
    };
    const keyFile: StoredKeyFileV1 = {
      version: 1,
      domain,
      identityEpoch: 1,
      rootKey,
      signingKeys: [
        {
          ...rootKey,
          keyId: `${domain}/key-1`,
          status: 'active',
        },
      ],
    };
    this.writeAtomically(path, keyFile);
    this.logger.warn(
      `Generated new S2S identity at ${path}. BACK THIS FILE UP — loss is not recoverable online.`,
    );
    return keyFile;
  }

  private readAndValidate(path: string): StoredKeyFileV1 {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    const keyFile = this.requireV1(raw);
    this.validateKeyFile(keyFile);
    chmodSync(path, 0o600);
    return keyFile;
  }

  private requireV1(value: unknown): StoredKeyFileV1 {
    if (!value || typeof value !== 'object')
      throw new Error('key file must be an object');
    const candidate = value as Partial<StoredKeyFileV1>;
    if (candidate.version !== 1)
      throw new Error('unsupported key file version');
    return candidate as StoredKeyFileV1;
  }

  private validateKeyFile(keyFile: StoredKeyFileV1): void {
    if (
      typeof keyFile.domain !== 'string' ||
      !Number.isInteger(keyFile.identityEpoch) ||
      keyFile.identityEpoch < 1 ||
      !keyFile.rootKey ||
      !Array.isArray(keyFile.signingKeys) ||
      keyFile.signingKeys.length !== 1
    ) {
      throw new Error('invalid S2S key file structure');
    }
    const active = keyFile.signingKeys[0];
    this.validateKey(keyFile.rootKey, 'root');
    this.validateKey(active, 'signing');
    if (active.status !== 'active')
      throw new Error('signing key is not active');
  }

  private validateKey(key: StoredIdentityKey, label: string): void {
    if (
      typeof key.keyId !== 'string' ||
      typeof key.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(key.createdAt))
    ) {
      throw new Error(`invalid ${label} key metadata`);
    }
    const privateKey = fromB64(key.privateKey);
    const publicKey = fromB64(key.publicKey);
    if (privateKey.length !== 32 || publicKey.length !== 32) {
      throw new Error(`invalid ${label} Ed25519 key length`);
    }
    if (
      !Buffer.from(ed25519.getPublicKey(privateKey)).equals(
        Buffer.from(publicKey),
      )
    ) {
      throw new Error(`${label} public key does not match private key`);
    }
  }

  private fingerprint(publicKeyB64: string): string {
    return `sha256:${createHash('sha256')
      .update(fromB64(publicKeyB64))
      .digest('base64url')}`;
  }

  private writeAtomically(path: string, keyFile: StoredKeyFileV1): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(temporaryPath, JSON.stringify(keyFile, null, 2), {
      mode: 0o600,
      flag: 'wx',
    });
    renameSync(temporaryPath, path);
    chmodSync(path, 0o600);
  }

  private disable(reason: string): void {
    this.status = { available: false, reason };
    this.logger.error(`Federation disabled: ${reason}`);
  }
}
