import {
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  Optional,
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
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { DatabaseService } from '../database/database.service.js';
import { localFederationIdentity } from '../database/schema.js';
import {
  loadFederationConfig,
  type FederationConfig,
} from './federation.config.js';
import {
  signingCertificateStatement,
  type SigningKeyCertificate,
} from './federation-certificate.js';

interface StoredIdentityKey {
  keyId: string;
  publicKey: string;
  privateKey: string;
  createdAt: number;
}

interface StoredSigningKey extends StoredIdentityKey {
  status: 'active' | 'published';
}

interface StoredKeyFileV1 {
  version: 1;
  domain: string;
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
const hasExactlyKeys = (
  value: unknown,
  allowed: readonly string[],
): value is Record<string, unknown> =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === allowed.length &&
  Object.keys(value).every((key) => allowed.includes(key));

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

  constructor(
    private readonly database: DatabaseService,
    @Optional()
    @Inject('SOMS_TEST_S2S_KEY_PATH')
    private readonly testKeyPath?: string,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.initialize();
  }

  /** Public for focused startup tests; normal application startup calls it through the Nest hook. */
  async initialize(): Promise<void> {
    const path = resolve(this.testKeyPath ?? this.config.keyPath);
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
            rootKeyFingerprint: fingerprint,
          })
          .onConflictDoNothing();
        const stored = await this.readAnchor();
        if (
          !stored ||
          normalizeDomain(stored.domain) !== configuredDomain ||
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

  getSigningKeyCertificates(): SigningKeyCertificate[] {
    this.assertAvailable();
    return this.keyFile!.signingKeys.map((key) => {
      const notBefore = key.createdAt;
      const unsigned = {
        keyId: key.keyId,
        ed25519: key.publicKey,
        notBefore,
        notAfter: 253_402_300_799_999,
      };
      return {
        ...unsigned,
        authorizationSignature: Buffer.from(
          ed25519.sign(
            Buffer.from(signingCertificateStatement(unsigned)),
            fromB64(this.keyFile!.rootKey.privateKey),
          ),
        ).toString('base64'),
      };
    });
  }

  getCreatedAt(): number {
    return this.activeKey().createdAt;
  }

  getRootKeyFingerprint(): string {
    this.assertAvailable();
    return this.fingerprint(this.keyFile!.rootKey.publicKey);
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
        OR EXISTS (SELECT 1 FROM "IdentityNamespace" WHERE id <> 0 LIMIT 1)
        OR EXISTS (SELECT 1 FROM "FederatedPeerEvent" LIMIT 1)
        OR EXISTS (SELECT 1 FROM "S2SKeyCache" LIMIT 1)
        AS "hasHistory"
    `);
    return result.rows[0]?.hasHistory === true;
  }

  private createFresh(path: string): StoredKeyFileV1 {
    const rootPrivateKey = ed25519.utils.randomSecretKey();
    const rootPublicKey = ed25519.getPublicKey(rootPrivateKey);
    const signingPrivateKey = ed25519.utils.randomSecretKey();
    const signingPublicKey = ed25519.getPublicKey(signingPrivateKey);
    const createdAt = Date.now();
    const domain = normalizeDomain(this.config.domain);
    const rootKey: StoredIdentityKey = {
      keyId: `${domain}/root-1`,
      publicKey: b64(rootPublicKey),
      privateKey: b64(rootPrivateKey),
      createdAt,
    };
    const keyFile: StoredKeyFileV1 = {
      version: 1,
      domain,
      rootKey,
      signingKeys: [
        {
          keyId: `${domain}/key-1`,
          publicKey: b64(signingPublicKey),
          privateKey: b64(signingPrivateKey),
          createdAt,
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
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('key file must be an object');
    const candidate = value as Partial<StoredKeyFileV1>;
    if (candidate.version !== 1)
      throw new Error('unsupported key file version');
    return candidate as StoredKeyFileV1;
  }

  private validateKeyFile(keyFile: StoredKeyFileV1): void {
    if (
      !hasExactlyKeys(keyFile, [
        'version',
        'domain',
        'rootKey',
        'signingKeys',
      ]) ||
      typeof keyFile.domain !== 'string' ||
      keyFile.domain !== normalizeDomain(keyFile.domain) ||
      keyFile.domain.length === 0 ||
      !keyFile.rootKey ||
      !Array.isArray(keyFile.signingKeys) ||
      keyFile.signingKeys.length === 0
    ) {
      throw new Error('invalid S2S key file structure');
    }
    this.validateKey(keyFile.rootKey, 'root', false);
    for (const key of keyFile.signingKeys)
      this.validateKey(key, 'signing', true);
    if (
      keyFile.signingKeys.filter((key) => key.status === 'active').length !== 1
    ) {
      throw new Error('S2S identity must have exactly one active signing key');
    }
    if (
      new Set(keyFile.signingKeys.map((key) => key.keyId)).size !==
      keyFile.signingKeys.length
    ) {
      throw new Error('S2S signing key IDs must be unique');
    }
    if (
      keyFile.signingKeys.some(
        (key) => key.publicKey === keyFile.rootKey.publicKey,
      )
    ) {
      throw new Error('S2S root and signing keys must be distinct');
    }
  }

  private validateKey(
    key: StoredIdentityKey,
    label: string,
    signing: boolean,
  ): void {
    if (
      !hasExactlyKeys(
        key,
        signing
          ? ['keyId', 'publicKey', 'privateKey', 'createdAt', 'status']
          : ['keyId', 'publicKey', 'privateKey', 'createdAt'],
      ) ||
      typeof key.keyId !== 'string' ||
      !Number.isSafeInteger(key.createdAt) ||
      key.createdAt < 0 ||
      (signing &&
        key.status !== 'active' &&
        key.status !== 'published')
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
