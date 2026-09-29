import {
  HttpStatus,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { DatabaseService } from '../database/database.service.js';
import {
  localFederationIdentity,
  localFederationSigningKey,
  localFederationSigningState,
} from '../database/schema.js';
import {
  loadFederationConfig,
  type FederationConfig,
} from './federation.config.js';
import {
  signingCertificateStatement,
  type SigningKeyCertificate,
} from './federation-certificate.js';

export type LocalFederationIdentityStatus =
  | { available: true }
  | { available: false; reason: string };

/** In-memory view of one local signing-key row (epoch milliseconds everywhere). */
interface LocalSigningKeyRow {
  keyId: string;
  publicKey: string;
  privateKey: string;
  createdAt: number;
  notBefore: number;
  notAfter: number;
}

/** Immutable snapshot of the database-backed local identity, cached for the synchronous getters. */
interface LocalKeySnapshot {
  identityDomain: string;
  rootPublicKeyB64: string;
  rootPrivateKeyB64: string;
  rootKeyFingerprint: string;
  keys: Map<string, LocalSigningKeyRow>;
  currentKeyId: string;
  plannedSwitchAt: number | null;
  plannedSuccessorKeyId: string | null;
}

/**
 * Named transaction-scoped advisory lock serializing every local key-lifecycle mutation
 * (bootstrap, switch, recovery planning, cleanup). Bootstrap cannot lock the state row
 * because that row does not exist yet; one named lock keeps a single acquisition order.
 */
const KEY_LIFECYCLE_LOCK = sql`SELECT pg_advisory_xact_lock(907301)`;

const b64 = (value: Uint8Array): string =>
  Buffer.from(value).toString('base64');
const fromB64 = (value: string): Uint8Array =>
  Uint8Array.from(Buffer.from(value, 'base64'));
const normalizeDomain = (domain: string): string =>
  domain.trim().toLowerCase().replace(/\.+$/, '');
const isValidAt = (key: LocalSigningKeyRow, now: number): boolean =>
  key.notBefore <= now && now < key.notAfter;

/**
 * Owns this installation's immutable S2S root identity, its signing-key set, and the
 * database-backed rotation lifecycle. Exactly one key is selected for new outbound
 * signatures at any instant; during a rotation the predecessor stays published and valid
 * for verification until its advertised notAfter, then is removed with its private
 * material. Private key material is stored unencrypted: database access control is the
 * secret boundary.
 *
 * The snapshot is refreshed by the maintenance tick (default 30s). A short staleness
 * window is harmless because a switched-out predecessor remains published and valid for
 * the configured retention, so receivers still authenticate it while the refresh lands.
 */
@Injectable()
export class KeypairService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(KeypairService.name);
  private readonly config: FederationConfig = loadFederationConfig();
  private snapshot: LocalKeySnapshot | undefined;
  private status: LocalFederationIdentityStatus = {
    available: false,
    reason: 'federation identity has not been initialized',
  };
  private maintainTimer: NodeJS.Timeout | undefined;

  constructor(private readonly database: DatabaseService) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.initialize();
  }

  onApplicationShutdown(): void {
    if (this.maintainTimer) clearInterval(this.maintainTimer);
    this.maintainTimer = undefined;
  }

  /** Public for focused startup tests; normal application startup calls it through the Nest hook. */
  async initialize(): Promise<void> {
    try {
      const bootstrapped = await this.bootstrapOrLoad();
      if (!bootstrapped) return;
      try {
        await this.maintainRotation();
      } catch (error) {
        // The identity itself is loadable; only lifecycle advancement failed. Keep the
        // identity available and let the next maintenance tick retry the rotation.
        this.logger.error(
          `S2S signing-key maintenance failed: ${(error as Error).message}`,
        );
      }
      this.status = { available: true };
      if (!this.maintainTimer) {
        this.maintainTimer = setInterval(() => void this.tick(), 30_000);
        this.maintainTimer.unref?.();
      }
      this.logger.log(
        `Loaded S2S identity ${this.getKeyId()} (${this.getRootKeyFingerprint()}) from the database`,
      );
    } catch (error) {
      this.snapshot = undefined;
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
    return this.activeSigningKey().keyId;
  }

  getPrivateKey(): Uint8Array {
    return fromB64(this.activeSigningKey().privateKey);
  }

  getPublicKeyB64(): string {
    return this.activeSigningKey().publicKey;
  }

  getRootPublicKeyB64(): string {
    this.assertAvailable();
    return this.snapshot!.rootPublicKeyB64;
  }

  /** Certificates published in /.well-known/somfp: every key still inside its advertised
   *  validity, ordered deterministically. The planned successor is published before first
   *  use; the predecessor stays published until its notAfter. */
  getSigningKeyCertificates(): SigningKeyCertificate[] {
    this.assertAvailable();
    const snapshot = this.snapshot!;
    const now = Date.now();
    const rootPrivateKey = fromB64(snapshot.rootPrivateKeyB64);
    return [...snapshot.keys.values()]
      .filter((key) => key.notAfter > now)
      .sort((a, b) => a.notBefore - b.notBefore || (a.keyId < b.keyId ? -1 : 1))
      .map((key) => {
        const unsigned = {
          keyId: key.keyId,
          ed25519: key.publicKey,
          notBefore: key.notBefore,
          notAfter: key.notAfter,
        };
        return {
          ...unsigned,
          authorizationSignature: Buffer.from(
            ed25519.sign(
              Buffer.from(signingCertificateStatement(unsigned)),
              rootPrivateKey,
            ),
          ).toString('base64'),
        };
      });
  }

  getCreatedAt(): number {
    return this.activeSigningKey().createdAt;
  }

  getRootKeyFingerprint(): string {
    this.assertAvailable();
    return this.snapshot!.rootKeyFingerprint;
  }

  private async tick(): Promise<void> {
    try {
      await this.maintainRotation();
    } catch (error) {
      this.logger.warn(
        `S2S signing-key maintenance failed: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Loads the identity row or bootstraps a fresh one. When federation history exists but
   * the identity row is missing, startup fails closed instead of silently replacing a
   * pinned identity.
   */
  private async bootstrapOrLoad(): Promise<boolean> {
    const domain = normalizeDomain(this.config.domain);
    return this.database.db.transaction(async (tx) => {
      await tx.execute(KEY_LIFECYCLE_LOCK);
      const anchor = await tx.query.localFederationIdentity.findFirst();
      if (anchor) {
        if (normalizeDomain(anchor.domain) !== domain) {
          this.disable(
            `SOMS_DOMAIN=${domain} does not match the database identity domain=${anchor.domain}`,
          );
          return false;
        }
        this.snapshot = await this.loadSnapshot(tx, anchor);
        return true;
      }

      if (await this.hasFederationHistory(tx)) {
        this.disable(
          'federation history exists but the local identity row is missing; restore the database from backup',
        );
        return false;
      }
      this.snapshot = await this.generateIdentity(tx, domain);
      this.logger.warn(
        'Generated a new database-backed S2S identity. BACK THE DATABASE UP — root-key loss requires every peer to approve this server again',
      );
      return true;
    });
  }

  private async loadSnapshot(
    tx: Parameters<Parameters<DatabaseService['db']['transaction']>[0]>[0],
    anchor: {
      domain: string;
      rootKeyFingerprint: string;
      rootPublicKey: string;
      rootPrivateKey: string;
    },
  ): Promise<LocalKeySnapshot> {
    const rootPublicKey = anchor.rootPublicKey;
    const rootPrivateKey = anchor.rootPrivateKey;
    const derived = Buffer.from(
      ed25519.getPublicKey(fromB64(rootPrivateKey)),
    ).toString('base64');
    if (derived !== rootPublicKey) {
      throw new Error('stored root public key does not match its private key');
    }
    const fingerprint = this.fingerprint(rootPublicKey);
    if (fingerprint !== anchor.rootKeyFingerprint) {
      throw new Error(
        'stored root key fingerprint does not match key material',
      );
    }

    const keys = await this.loadKeyRows(tx, anchor.domain);
    const state = await tx.query.localFederationSigningState.findFirst();
    if (!state || normalizeDomain(state.domain) !== anchor.domain) {
      throw new Error('local signing selection state is missing');
    }
    if (!keys.has(state.currentKeyId)) {
      throw new Error('current signing key row is missing');
    }
    if (state.plannedSuccessorKeyId && !keys.has(state.plannedSuccessorKeyId)) {
      throw new Error('planned successor signing key row is missing');
    }
    if (state.plannedSuccessorKeyId) {
      const successor = keys.get(state.plannedSuccessorKeyId)!;
      if (
        state.plannedSwitchAt === null ||
        successor.notBefore + this.config.signingKey.clockSkewBudgetMs >
          state.plannedSwitchAt.getTime()
      ) {
        throw new Error('planned switch violates the clock-skew budget');
      }
    }
    return {
      identityDomain: anchor.domain,
      rootPublicKeyB64: rootPublicKey,
      rootPrivateKeyB64: rootPrivateKey,
      rootKeyFingerprint: fingerprint,
      keys,
      currentKeyId: state.currentKeyId,
      plannedSwitchAt: state.plannedSwitchAt?.getTime() ?? null,
      plannedSuccessorKeyId: state.plannedSuccessorKeyId ?? null,
    };
  }

  private async generateIdentity(
    tx: Parameters<Parameters<DatabaseService['db']['transaction']>[0]>[0],
    domain: string,
  ): Promise<LocalKeySnapshot> {
    const rootPrivateKey = ed25519.utils.randomSecretKey();
    const rootPublicKey = ed25519.getPublicKey(rootPrivateKey);
    const rootPublicKeyB64 = b64(rootPublicKey);
    const fingerprint = this.fingerprint(rootPublicKeyB64);
    const now = Date.now();
    const initial = this.generateSigningKey(
      domain,
      now,
      now + this.config.signingKey.lifetimeMs,
    );

    await tx.insert(localFederationIdentity).values({
      domain,
      rootKeyFingerprint: fingerprint,
      rootPublicKey: rootPublicKeyB64,
      rootPrivateKey: b64(rootPrivateKey),
      createdAt: new Date(now),
    });
    await this.insertSigningKey(tx, domain, initial);
    await tx.insert(localFederationSigningState).values({
      domain,
      currentKeyId: initial.keyId,
      plannedSwitchAt: null,
      plannedSuccessorKeyId: null,
      updatedAt: new Date(now),
    });

    const keys = new Map([[initial.keyId, initial]]);
    return {
      identityDomain: domain,
      rootPublicKeyB64: rootPublicKeyB64,
      rootPrivateKeyB64: b64(rootPrivateKey),
      rootKeyFingerprint: fingerprint,
      keys,
      currentKeyId: initial.keyId,
      plannedSwitchAt: null,
      plannedSuccessorKeyId: null,
    };
  }

  /** Advances the rotation lifecycle: due switches, recovery from an expired current key,
   *  successor planning, and expired-key cleanup. Mutations run in one transaction under
   *  the key-lifecycle advisory lock, so concurrent instances cannot double-switch. */
  private async maintainRotation(): Promise<void> {
    const domain = normalizeDomain(this.config.domain);
    await this.database.db.transaction(async (tx) => {
      await tx.execute(KEY_LIFECYCLE_LOCK);
      const keys = await this.loadKeyRows(tx, domain);
      const state = await tx.query.localFederationSigningState.findFirst();
      if (!state || normalizeDomain(state.domain) !== domain) {
        throw new Error('local signing selection state is missing');
      }

      const now = Date.now();
      let currentKeyId = state.currentKeyId;
      let plannedSwitchAt = state.plannedSwitchAt?.getTime() ?? null;
      let plannedSuccessorKeyId = state.plannedSuccessorKeyId ?? null;
      let changed = false;

      const currentKey = keys.get(currentKeyId);
      if (!currentKey) throw new Error('current signing key row is missing');
      const successorKey = plannedSuccessorKeyId
        ? keys.get(plannedSuccessorKeyId)
        : undefined;
      const successorUsable =
        successorKey !== undefined &&
        plannedSwitchAt !== null &&
        isValidAt(successorKey, now);

      const switchDue =
        successorUsable &&
        successorKey !== undefined &&
        plannedSwitchAt !== null &&
        now >= plannedSwitchAt;
      const currentExpired = !isValidAt(currentKey, now);

      if (switchDue || (currentExpired && successorUsable)) {
        currentKeyId = successorKey!.keyId;
        plannedSwitchAt = null;
        plannedSuccessorKeyId = null;
        changed = true;
        this.logger.log(
          `Switched local S2S signing key to ${currentKeyId} under the unchanged root`,
        );
      } else if (currentExpired) {
        // No valid successor either (for example after a long outage): recover under the
        // unchanged root with a fresh immediately-valid key. Peers refresh on key miss
        // and accept it because the pinned root still authorizes it.
        const recovery = this.generateSigningKey(
          domain,
          now,
          now + this.config.signingKey.lifetimeMs,
        );
        await this.insertSigningKey(tx, domain, recovery);
        keys.set(recovery.keyId, recovery);
        currentKeyId = recovery.keyId;
        plannedSwitchAt = null;
        plannedSuccessorKeyId = null;
        changed = true;
        this.logger.warn(
          `Current signing key expired without a valid successor; generated recovery key ${recovery.keyId}`,
        );
      } else if (
        successorKey &&
        !isValidAt(successorKey, now) &&
        now >= (plannedSwitchAt ?? now)
      ) {
        // A plan whose successor can no longer serve is void; replan below.
        plannedSwitchAt = null;
        plannedSuccessorKeyId = null;
        changed = true;
        this.logger.warn(
          'Voided a local signing-key plan whose successor is no longer usable',
        );
      }

      if (!plannedSuccessorKeyId) {
        const current = keys.get(currentKeyId)!;
        const remaining = current.notAfter - now;
        if (
          remaining <=
          this.config.signingKey.successorPrepublicationMs +
            this.config.signingKey.predecessorRetentionMs
        ) {
          const successor = this.generateSigningKey(
            domain,
            now,
            now + this.config.signingKey.lifetimeMs,
          );
          await this.insertSigningKey(tx, domain, successor);
          keys.set(successor.keyId, successor);
          plannedSuccessorKeyId = successor.keyId;
          plannedSwitchAt = Math.max(
            current.notAfter - this.config.signingKey.predecessorRetentionMs,
            now + this.config.signingKey.clockSkewBudgetMs,
          );
          changed = true;
          this.logger.log(
            `Planned S2S signing-key switch to ${successor.keyId} at ${new Date(plannedSwitchAt).toISOString()}`,
          );
        }
      }

      // Remove expired keys with their private material. The current key and the planned
      // successor are always retained; a predecessor stays until its advertised notAfter.
      const retained = [
        currentKeyId,
        ...(plannedSuccessorKeyId ? [plannedSuccessorKeyId] : []),
      ];
      const expired = [...keys.values()].filter(
        (key) => !retained.includes(key.keyId) && now >= key.notAfter,
      );
      if (expired.length > 0) {
        await tx.execute(
          sql`DELETE FROM "LocalFederationSigningKey" WHERE "keyId" = ANY(${expired.map((key) => key.keyId)})`,
        );
        for (const key of expired) keys.delete(key.keyId);
      }

      if (changed) {
        await tx.update(localFederationSigningState).set({
          currentKeyId,
          plannedSwitchAt:
            plannedSwitchAt === null ? null : new Date(plannedSwitchAt),
          plannedSuccessorKeyId,
          updatedAt: new Date(now),
        });
      }

      const root = await tx.query.localFederationIdentity.findFirst();
      if (!root) {
        throw new Error('local identity row disappeared');
      }
      this.snapshot = {
        identityDomain: domain,
        rootPublicKeyB64: root.rootPublicKey,
        rootPrivateKeyB64: root.rootPrivateKey,
        rootKeyFingerprint: root.rootKeyFingerprint,
        keys,
        currentKeyId,
        plannedSwitchAt,
        plannedSuccessorKeyId,
      };
    });
  }

  private async loadKeyRows(
    tx: Parameters<Parameters<DatabaseService['db']['transaction']>[0]>[0],
    domain: string,
  ): Promise<Map<string, LocalSigningKeyRow>> {
    const rows = await tx.query.localFederationSigningKey.findMany();
    const keys = new Map<string, LocalSigningKeyRow>();
    for (const row of rows) {
      if (row.domain !== domain) continue;
      keys.set(row.keyId, {
        keyId: row.keyId,
        publicKey: row.publicKey,
        privateKey: row.privateKey,
        createdAt: row.createdAt.getTime(),
        notBefore: row.notBefore.getTime(),
        notAfter: row.notAfter.getTime(),
      });
    }
    return keys;
  }

  private async insertSigningKey(
    tx: Parameters<Parameters<DatabaseService['db']['transaction']>[0]>[0],
    domain: string,
    key: LocalSigningKeyRow,
  ): Promise<void> {
    await tx.insert(localFederationSigningKey).values({
      domain,
      keyId: key.keyId,
      publicKey: key.publicKey,
      privateKey: key.privateKey,
      createdAt: new Date(key.createdAt),
      notBefore: new Date(key.notBefore),
      notAfter: new Date(key.notAfter),
    });
  }

  private generateSigningKey(
    domain: string,
    notBefore: number,
    notAfter: number,
  ): LocalSigningKeyRow {
    const privateKey = ed25519.utils.randomSecretKey();
    const publicKey = ed25519.getPublicKey(privateKey);
    // Opaque KeyName satisfying the KeyId grammar; never reused under the same root.
    const keyId = `${domain}/k-${randomBytes(15).toString('base64url')}`;
    return {
      keyId,
      publicKey: b64(publicKey),
      privateKey: b64(privateKey),
      createdAt: notBefore,
      notBefore,
      notAfter,
    };
  }

  private async hasFederationHistory(
    tx: Parameters<Parameters<DatabaseService['db']['transaction']>[0]>[0],
  ): Promise<boolean> {
    const result = await tx.execute<{ hasHistory: boolean }>(sql`
      SELECT
        EXISTS (SELECT 1 FROM "FederatedPeer" LIMIT 1)
        OR EXISTS (SELECT 1 FROM "IdentityNamespace" WHERE id <> 0 LIMIT 1)
        OR EXISTS (SELECT 1 FROM "FederatedPeerEvent" LIMIT 1)
        OR EXISTS (SELECT 1 FROM "S2SKeyCache" LIMIT 1)
        AS "hasHistory"
    `);
    return result.rows[0]?.hasHistory === true;
  }

  /** The single key used for new outbound signatures; refuses to sign outside validity. */
  private activeSigningKey(): LocalSigningKeyRow {
    this.assertAvailable();
    const snapshot = this.snapshot!;
    const key = snapshot.keys.get(snapshot.currentKeyId);
    if (!key) {
      throw new BusinessException(
        BusinessCode.FEDERATION_LOCAL_IDENTITY_LOST,
        'current signing key missing from local state',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const now = Date.now();
    if (!isValidAt(key, now)) {
      throw new BusinessException(
        BusinessCode.FEDERATION_LOCAL_IDENTITY_LOST,
        `current signing key ${key.keyId} is outside its validity interval`,
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return key;
  }

  private fingerprint(publicKeyB64: string): string {
    return `sha256:${createHash('sha256')
      .update(fromB64(publicKeyB64))
      .digest('base64url')}`;
  }

  private disable(reason: string): void {
    this.status = { available: false, reason };
    this.logger.error(`Federation disabled: ${reason}`);
  }
}
