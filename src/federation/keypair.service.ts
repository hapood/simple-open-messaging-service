import {
  HttpStatus,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ed25519 } from '@noble/curves/ed25519.js';
import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { DatabaseService } from '../database/database.service.js';
import {
  localFederationRoot,
  localFederationSigningKey,
  localFederationSigningState,
} from '../database/schema.js';
import {
  loadFederationConfig,
  type FederationConfig,
} from './federation.config.js';
import {
  signingCertificateStatement,
  type RootKeyEntry,
  type SigningKeyCertificate,
} from './federation-certificate.js';
import { openSealedBox } from './sealed-box.js';

export type LocalFederationIdentityStatus =
  | { available: true }
  | { available: false; reason: string };

/** In-memory view of one local signing-key row (epoch milliseconds everywhere). */
interface LocalSigningKeyRow {
  keyId: string;
  rootId: number;
  publicKey: string;
  privateKey: string;
  createdAt: number;
  notBefore: number;
  notAfter: number;
}

/** In-memory view of one local root-identity epoch. */
interface LocalRootRow {
  id: number;
  domain: string;
  rootPublicKey: string;
  rootPrivateKey: string;
  notBefore: number;
  notAfter: number;
  claimable: boolean;
  unpublishedAt: number | null;
}

/** Result of an administrator-triggered root rotation. */
export interface RootRotationResult {
  previousRootId: number;
  newRootId: number;
  newRootPublicKey: string;
}

/** Immutable snapshot of the database-backed local identity, cached for the synchronous getters. */
interface LocalKeySnapshot {
  identityDomain: string;
  roots: Map<number, LocalRootRow>;
  claimableRootId: number;
  keys: Map<string, LocalSigningKeyRow>;
  currentKeyId: string;
  plannedSwitchAt: number | null;
  plannedSuccessorKeyId: string | null;
}

/**
 * Named transaction-scoped advisory lock serializing every local key-lifecycle mutation
 * (bootstrap, switch, root rotation, recovery planning, predecessor unpublishing).
 * Bootstrap cannot lock the state row because that row does not exist yet; one named
 * lock keeps a single acquisition order.
 */
const KEY_LIFECYCLE_LOCK = sql`SELECT pg_advisory_xact_lock(907301)`;

const b64 = (value: Uint8Array): string =>
  Buffer.from(value).toString('base64');
const fromB64 = (value: string): Uint8Array =>
  Uint8Array.from(Buffer.from(value, 'base64'));
const normalizeDomain = (domain: string): string =>
  domain.trim().toLowerCase().replace(/\.+$/, '');
const isValidAt = (
  key: { notBefore: number; notAfter: number },
  now: number,
): boolean => key.notBefore <= now && now < key.notAfter;

/**
 * Owns this installation's root-identity epochs, their signing-key sets, and the
 * database-backed rotation lifecycle. Exactly one key is selected for new outbound
 * signatures at any instant; during a signing-key rotation the predecessor stays
 * published and valid for verification until its advertised notAfter. Root epochs
 * and signing keys — private material included — are retained forever: sealed
 * challenges under retired keys must stay openable (Transport and Security 1.5).
 * Private key material is stored unencrypted: database access control is the
 * secret boundary.
 *
 * A root rotation switches claim to a successor epoch immediately; predecessor-
 * authorized certificates are removed from the published set in the same commit,
 * which is the revocation channel. The predecessor root entry stays published
 * until an operator unpublishes it after every recognized peer adopted the
 * rotation.
 *
 * The snapshot is refreshed by the maintenance tick — at most every 30s, and earlier
 * when a persisted lifecycle event (successor prepublication, planned switch,
 * predecessor expiry) falls due sooner. A short staleness window is harmless because
 * a switched-out predecessor remains published and valid for the configured retention,
 * so receivers still authenticate it while the refresh lands.
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
    if (this.maintainTimer) clearTimeout(this.maintainTimer);
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
      this.scheduleNextMaintenance();
      this.logger.log(
        `Loaded S2S identity ${this.getKeyId()} under root ${this.getRootPublicKeyB64().slice(0, 12)}… from the database`,
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

  /** The claimable root public key — the value claimed in outbound S2S-Root-Key. */
  getRootPublicKeyB64(): string {
    this.assertAvailable();
    return this.claimableRoot().rootPublicKey;
  }

  /** The published roots group (Transport and Security 1.1): every root epoch not
   *  yet unpublished, deterministically ordered. A rotated-out predecessor stays
   *  listed until an operator unpublishes it after peer adoption. */
  getRootGroup(): RootKeyEntry[] {
    this.assertAvailable();
    const snapshot = this.snapshot!;
    return [...snapshot.roots.values()]
      .filter((root) => root.unpublishedAt === null)
      .sort((a, b) => a.notBefore - b.notBefore || a.id - b.id)
      .map((root) => ({
        ed25519: root.rootPublicKey,
        notBefore: root.notBefore,
        notAfter: root.notAfter,
      }));
  }

  /** All local root epochs, including unpublished ones, for the admin console.
   *  Never served on the wire. */
  getRootEpochs(): Array<
    LocalRootRow & { signingKeyCount: number; claimableKeyCount: number }
  > {
    this.assertAvailable();
    const snapshot = this.snapshot!;
    return [...snapshot.roots.values()]
      .sort((a, b) => b.id - a.id)
      .map((root) => {
        const keys = [...snapshot.keys.values()].filter(
          (key) => key.rootId === root.id,
        );
        const now = Date.now();
        return {
          ...root,
          signingKeyCount: keys.length,
          claimableKeyCount: keys.filter(
            (key) =>
              key.notAfter > now &&
              root.claimable &&
              root.unpublishedAt === null,
          ).length,
        };
      });
  }

  /** Certificates published in /.well-known/somfp keys[]: every key still inside
   *  its advertised validity whose authorizing root is the claimable epoch. The
   *  planned successor is published before first use; the predecessor stays
   *  published until its notAfter. After a root rotation only
   *  successor-authorized certificates remain — their removal is the revocation
   *  channel. */
  getSigningKeyCertificates(): SigningKeyCertificate[] {
    this.assertAvailable();
    const snapshot = this.snapshot!;
    const now = Date.now();
    return [...snapshot.keys.values()]
      .filter((key) => {
        const root = snapshot.roots.get(key.rootId);
        return root !== undefined && root.claimable && key.notAfter > now;
      })
      .sort((a, b) => a.notBefore - b.notBefore || (a.keyId < b.keyId ? -1 : 1))
      .map((key) => this.toCertificate(key, snapshot));
  }

  getCreatedAt(): number {
    return this.activeSigningKey().createdAt;
  }

  /** Look up a retained private key by its public counterpart — root or signing
   *  key, current or retired — for the sealed-challenge oracle. Unknown keys
   *  return null. */
  getRetainedPrivateKey(publicKeyB64: string): Uint8Array | null {
    if (!this.status.available) return null;
    const snapshot = this.snapshot!;
    for (const root of snapshot.roots.values()) {
      if (root.rootPublicKey === publicKeyB64)
        return fromB64(root.rootPrivateKey);
    }
    for (const key of snapshot.keys.values()) {
      if (key.publicKey === publicKeyB64) return fromB64(key.privateKey);
    }
    return null;
  }

  /** Whether a public key belongs to this server's retained key history. */
  isRetainedPublicKey(publicKeyB64: string): boolean {
    return this.getRetainedPrivateKey(publicKeyB64) !== null;
  }

  /** Validate and open one card lookup challenge (Profiles 2.1/3): the
   *  `publicKey` names a retained key, `challenge` is a sealed box under it.
   *  Returns the recovered plaintext exactly; throws the wire-mapped
   *  business errors for unrecognized keys and malformed challenges. */
  openCardChallenge(publicKey: string, challenge: string): string {
    if (
      !/^[A-Za-z0-9+/]{43}=$/.test(publicKey) ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(challenge) ||
      challenge.length < 48 ||
      challenge.length > 8192
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'malformed card challenge parameters',
        HttpStatus.BAD_REQUEST,
      );
    }
    const privateKey = this.getRetainedPrivateKey(publicKey);
    if (!privateKey) {
      throw new BusinessException(
        BusinessCode.FEDERATION_PUBLIC_KEY_UNRECOGNIZED,
        "the supplied public key is not part of this server's retained key history",
        HttpStatus.BAD_REQUEST,
      );
    }
    const opened = openSealedBox(
      Uint8Array.from(Buffer.from(challenge, 'base64')),
      privateKey,
    );
    if (!opened || opened.length > 4096) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'the card challenge does not open under the supplied key',
        HttpStatus.BAD_REQUEST,
      );
    }
    return Buffer.from(opened).toString('utf8');
  }

  /**
   * Administrator-triggered root rotation (immediate cutover). Generates a
   * successor root epoch with a fresh signing key, flips claim in one
   * transaction, and leaves the predecessor published (but no longer
   * authorizing any published certificate) for peers that have not adopted
   * yet. The caller must operator-verify predecessor possession evidence
   * before invoking this on the receiving side; on the rotating side this is
   * the deliberate act itself.
   */
  async rotateRoot(): Promise<RootRotationResult> {
    this.assertAvailable();
    const domain = normalizeDomain(this.config.domain);
    return this.database.db.transaction(async (tx) => {
      await tx.execute(KEY_LIFECYCLE_LOCK);
      const snapshot = await this.reloadSnapshot(tx, domain);
      if (!snapshot) throw new Error('local identity rows disappeared');
      const previous = this.claimableRootOf(snapshot);
      const now = Date.now();
      const rootPrivateKey = ed25519.utils.randomSecretKey();
      const rootPublicKey = ed25519.getPublicKey(rootPrivateKey);
      const rootPublicKeyB64 = b64(rootPublicKey);
      const rootNotAfter = now + this.config.rootKey.lifetimeMs;
      const [insertedRoot] = await tx
        .insert(localFederationRoot)
        .values({
          domain,
          rootPublicKey: rootPublicKeyB64,
          rootPrivateKey: b64(rootPrivateKey),
          notBefore: new Date(now),
          notAfter: new Date(rootNotAfter),
          claimable: true,
        })
        .returning({ id: localFederationRoot.id });
      if (!insertedRoot) throw new Error('root epoch insert returned no row');
      const initial = this.generateSigningKey(
        insertedRoot.id,
        domain,
        now,
        Math.min(now + this.config.signingKey.lifetimeMs, rootNotAfter),
      );
      await this.insertSigningKey(tx, initial);
      await tx
        .update(localFederationRoot)
        .set({ claimable: false })
        .where(eq(localFederationRoot.id, previous.id));
      await tx
        .update(localFederationSigningState)
        .set({
          currentKeyId: initial.keyId,
          plannedSwitchAt: null,
          plannedSuccessorKeyId: null,
          updatedAt: new Date(now),
        })
        .where(eq(localFederationSigningState.domain, domain));
      const next = await this.reloadSnapshot(tx, domain);
      if (!next) throw new Error('local identity rows disappeared');
      this.snapshot = next;
      this.logger.warn(
        `Rotated S2S root identity: ${previous.rootPublicKey.slice(0, 12)}… -> ${rootPublicKeyB64.slice(0, 12)}…; predecessor-authorized certificates are revoked by this switch`,
      );
      return {
        previousRootId: previous.id,
        newRootId: insertedRoot.id,
        newRootPublicKey: rootPublicKeyB64,
      };
    });
  }

  /**
   * Remove a rotated-out root from the published roots group. Only legal after
   * every recognized peer adopted the rotation (or the rotation is abandoned);
   * refuses to unpublish the claimable root and any still-valid root.
   */
  async unpublishRoot(rootId: number): Promise<void> {
    this.assertAvailable();
    const domain = normalizeDomain(this.config.domain);
    await this.database.db.transaction(async (tx) => {
      await tx.execute(KEY_LIFECYCLE_LOCK);
      const snapshot = await this.reloadSnapshot(tx, domain);
      if (!snapshot) throw new Error('local identity rows disappeared');
      const root = snapshot.roots.get(rootId);
      if (!root) throw new Error(`root epoch ${rootId} does not exist`);
      if (root.claimable) {
        throw new Error('the claimable root cannot be unpublished');
      }
      if (root.notAfter > Date.now()) {
        throw new Error(
          'a still-valid predecessor root must stay published until peers adopted the rotation; rotate first, then unpublish after adoption',
        );
      }
      await tx
        .update(localFederationRoot)
        .set({ unpublishedAt: new Date() })
        .where(eq(localFederationRoot.id, rootId));
      const next = await this.reloadSnapshot(tx, domain);
      if (next) this.snapshot = next;
    });
  }

  private tick(): Promise<void> {
    return this.maintainRotation()
      .catch((error) => {
        this.logger.warn(
          `S2S signing-key maintenance failed: ${(error as Error).message}`,
        );
      })
      .finally(() => this.scheduleNextMaintenance());
  }

  /** Self-scheduling maintenance: at most 30s between ticks, and sooner when the
   *  persisted plan makes a lifecycle event imminent, so no event ever waits behind
   *  the cap. Each event clears itself when the rotation it schedules completes, so
   *  the early-run floor can never busy-loop. */
  private scheduleNextMaintenance(): void {
    if (this.maintainTimer) clearTimeout(this.maintainTimer);
    const timer = setTimeout(
      () => void this.tick(),
      this.nextMaintenanceDelay(),
    );
    timer.unref?.();
    this.maintainTimer = timer;
  }

  /** Milliseconds until the next tick: the earliest upcoming lifecycle event minus a
   *  small margin, capped at 30s, floored to keep an already-due event prompt. Events
   *  observed from the snapshot: the successor-planning deadline for the current key,
   *  the planned switch time, the claimable root's expiry, and the current key's own
   *  expiry (expired-current recovery). */
  private nextMaintenanceDelay(): number {
    const CAP_MS = 30_000;
    const MARGIN_MS = 250;
    const FLOOR_MS = 200;
    const snapshot = this.snapshot;
    const now = Date.now();
    if (!snapshot) return CAP_MS;
    const events: number[] = [];
    const claimableRoot = this.claimableRootOf(snapshot);
    events.push(claimableRoot.notAfter);
    const current = snapshot.keys.get(snapshot.currentKeyId);
    if (current) {
      events.push(current.notAfter);
      if (!snapshot.plannedSuccessorKeyId) {
        events.push(
          current.notAfter -
            (this.config.signingKey.successorPrepublicationMs +
              this.config.signingKey.predecessorRetentionMs),
        );
      }
    }
    if (snapshot.plannedSwitchAt !== null)
      events.push(snapshot.plannedSwitchAt);
    if (events.some((time) => time <= now)) return FLOOR_MS;
    const next = Math.min(CAP_MS, Math.min(...events) - now - MARGIN_MS);
    return Math.max(FLOOR_MS, next);
  }

  /**
   * Loads the identity epochs or bootstraps a fresh one. When federation history
   * exists but the root table is empty, startup fails closed instead of silently
   * replacing a pinned identity.
   */
  private async bootstrapOrLoad(): Promise<boolean> {
    const domain = normalizeDomain(this.config.domain);
    return this.database.db.transaction(async (tx) => {
      await tx.execute(KEY_LIFECYCLE_LOCK);
      const snapshot = await this.reloadSnapshot(tx, domain);
      if (snapshot) {
        this.snapshot = snapshot;
        return true;
      }

      const foreignRoot = await tx.query.localFederationRoot.findFirst();
      if (foreignRoot && normalizeDomain(foreignRoot.domain) !== domain) {
        this.disable(
          `SOMS_DOMAIN=${domain} does not match the database identity domain=${foreignRoot.domain}`,
        );
        return false;
      }

      if (await this.hasFederationHistory(tx)) {
        this.disable(
          'federation history exists but the local root-identity rows are missing; restore the database from backup',
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

  /** Reload every root epoch and signing-key row; null when the tables are empty. */
  private async reloadSnapshot(
    tx: Parameters<Parameters<DatabaseService['db']['transaction']>[0]>[0],
    domain: string,
  ): Promise<LocalKeySnapshot | null> {
    const roots = await tx.query.localFederationRoot.findMany();
    const keys = await tx.query.localFederationSigningKey.findMany();
    const state = await tx.query.localFederationSigningState.findFirst();
    const rootRows = new Map<number, LocalRootRow>();
    let claimableRootId: number | null = null;
    for (const row of roots) {
      if (normalizeDomain(row.domain) !== domain) continue;
      rootRows.set(row.id, {
        id: row.id,
        domain: row.domain,
        rootPublicKey: row.rootPublicKey,
        rootPrivateKey: row.rootPrivateKey,
        notBefore: row.notBefore.getTime(),
        notAfter: row.notAfter.getTime(),
        claimable: row.claimable,
        unpublishedAt: row.unpublishedAt?.getTime() ?? null,
      });
      if (row.claimable) {
        if (claimableRootId !== null) {
          throw new Error('multiple claimable root epochs found');
        }
        claimableRootId = row.id;
      }
    }
    if (rootRows.size === 0) return null;
    if (claimableRootId === null) {
      throw new Error('no claimable root epoch found');
    }
    if (!state || normalizeDomain(state.domain) !== domain) {
      throw new Error('local signing selection state is missing');
    }
    const keyRows = new Map<string, LocalSigningKeyRow>();
    for (const row of keys) {
      if (!rootRows.has(row.rootId)) continue;
      keyRows.set(row.keyId, {
        keyId: row.keyId,
        rootId: row.rootId,
        publicKey: row.publicKey,
        privateKey: row.privateKey,
        createdAt: row.createdAt.getTime(),
        notBefore: row.notBefore.getTime(),
        notAfter: row.notAfter.getTime(),
      });
    }
    if (!keyRows.has(state.currentKeyId)) {
      throw new Error('current signing key row is missing');
    }
    if (
      state.plannedSuccessorKeyId &&
      !keyRows.has(state.plannedSuccessorKeyId)
    ) {
      throw new Error('planned successor signing key row is missing');
    }
    if (state.plannedSuccessorKeyId) {
      const successor = keyRows.get(state.plannedSuccessorKeyId)!;
      if (
        state.plannedSwitchAt === null ||
        successor.notBefore + this.config.signingKey.clockSkewBudgetMs >
          state.plannedSwitchAt.getTime()
      ) {
        throw new Error('planned switch violates the clock-skew budget');
      }
    }
    if (keyRows.get(state.currentKeyId)!.rootId !== claimableRootId) {
      throw new Error(
        'current signing key is not authorized by the claimable root',
      );
    }
    return {
      identityDomain: domain,
      roots: rootRows,
      claimableRootId,
      keys: keyRows,
      currentKeyId: state.currentKeyId,
      plannedSwitchAt: state.plannedSwitchAt?.getTime() ?? null,
      plannedSuccessorKeyId: state.plannedSuccessorKeyId ?? null,
    };
  }

  private async generateIdentity(
    tx: Parameters<Parameters<DatabaseService['db']['transaction']>[0]>[0],
    domain: string,
  ): Promise<LocalKeySnapshot> {
    const now = Date.now();
    const rootNotAfter = now + this.config.rootKey.lifetimeMs;
    const rootPrivateKey = ed25519.utils.randomSecretKey();
    const rootPublicKey = ed25519.getPublicKey(rootPrivateKey);
    const rootPublicKeyB64 = b64(rootPublicKey);

    const [insertedRoot] = await tx
      .insert(localFederationRoot)
      .values({
        domain,
        rootPublicKey: rootPublicKeyB64,
        rootPrivateKey: b64(rootPrivateKey),
        notBefore: new Date(now),
        notAfter: new Date(rootNotAfter),
        claimable: true,
      })
      .returning({ id: localFederationRoot.id });
    if (!insertedRoot) throw new Error('root epoch insert returned no row');

    const initial = this.generateSigningKey(
      insertedRoot.id,
      domain,
      now,
      Math.min(now + this.config.signingKey.lifetimeMs, rootNotAfter),
    );
    await this.insertSigningKey(tx, initial);
    await tx.insert(localFederationSigningState).values({
      domain,
      currentKeyId: initial.keyId,
      plannedSwitchAt: null,
      plannedSuccessorKeyId: null,
      updatedAt: new Date(now),
    });

    return {
      identityDomain: domain,
      roots: new Map([
        [
          insertedRoot.id,
          {
            id: insertedRoot.id,
            domain,
            rootPublicKey: rootPublicKeyB64,
            rootPrivateKey: b64(rootPrivateKey),
            notBefore: now,
            notAfter: rootNotAfter,
            claimable: true,
            unpublishedAt: null,
          },
        ],
      ]),
      claimableRootId: insertedRoot.id,
      keys: new Map([[initial.keyId, initial]]),
      currentKeyId: initial.keyId,
      plannedSwitchAt: null,
      plannedSuccessorKeyId: null,
    };
  }

  /** Advances the signing-key rotation lifecycle: due switches, recovery from an
   *  expired current key, successor planning. Mutations run in one transaction
   *  under the key-lifecycle advisory lock, so concurrent instances cannot
   *  double-switch. Expired key rows are never deleted: retained key history
   *  keeps sealed challenges openable forever. */
  private async maintainRotation(): Promise<void> {
    const domain = normalizeDomain(this.config.domain);
    await this.database.db.transaction(async (tx) => {
      await tx.execute(KEY_LIFECYCLE_LOCK);
      const snapshot = await this.reloadSnapshot(tx, domain);
      if (!snapshot) throw new Error('local identity rows disappeared');
      const claimableRoot = this.claimableRootOf(snapshot);
      if (claimableRoot.notAfter <= Date.now()) {
        throw new Error(
          'the claimable root epoch has expired; rotate the root identity to restore signing',
        );
      }
      const keys = snapshot.keys;
      const state = {
        currentKeyId: snapshot.currentKeyId,
        plannedSwitchAt: snapshot.plannedSwitchAt,
        plannedSuccessorKeyId: snapshot.plannedSuccessorKeyId,
      };

      const now = Date.now();
      let currentKeyId = state.currentKeyId;
      let plannedSwitchAt = state.plannedSwitchAt;
      let plannedSuccessorKeyId = state.plannedSuccessorKeyId;
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
        // claimable root with a fresh immediately-valid key. Peers refresh on key miss
        // and accept it because the pinned root still authorizes it.
        const recovery = this.generateSigningKey(
          claimableRoot.id,
          domain,
          now,
          Math.min(
            now + this.config.signingKey.lifetimeMs,
            claimableRoot.notAfter,
          ),
        );
        await this.insertSigningKey(tx, recovery);
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
            claimableRoot.id,
            domain,
            now,
            Math.min(
              now + this.config.signingKey.lifetimeMs,
              claimableRoot.notAfter,
            ),
          );
          await this.insertSigningKey(tx, successor);
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

      if (changed) {
        await tx
          .update(localFederationSigningState)
          .set({
            currentKeyId,
            plannedSwitchAt:
              plannedSwitchAt === null ? null : new Date(plannedSwitchAt),
            plannedSuccessorKeyId,
            updatedAt: new Date(now),
          })
          .where(eq(localFederationSigningState.domain, domain));
      }

      this.snapshot = {
        identityDomain: domain,
        roots: snapshot.roots,
        claimableRootId: snapshot.claimableRootId,
        keys,
        currentKeyId,
        plannedSwitchAt,
        plannedSuccessorKeyId,
      };
    });
  }

  private toCertificate(
    key: LocalSigningKeyRow,
    snapshot: LocalKeySnapshot,
  ): SigningKeyCertificate {
    const root = snapshot.roots.get(key.rootId)!;
    const unsigned = {
      keyId: key.keyId,
      ed25519: key.publicKey,
      root: root.rootPublicKey,
      notBefore: key.notBefore,
      notAfter: key.notAfter,
    };
    return {
      ...unsigned,
      authorizationSignature: Buffer.from(
        ed25519.sign(
          Buffer.from(signingCertificateStatement(unsigned)),
          fromB64(root.rootPrivateKey),
        ),
      ).toString('base64'),
    };
  }

  private async insertSigningKey(
    tx: Parameters<Parameters<DatabaseService['db']['transaction']>[0]>[0],
    key: LocalSigningKeyRow,
  ): Promise<void> {
    await tx.insert(localFederationSigningKey).values({
      rootId: key.rootId,
      keyId: key.keyId,
      publicKey: key.publicKey,
      privateKey: key.privateKey,
      createdAt: new Date(key.createdAt),
      notBefore: new Date(key.notBefore),
      notAfter: new Date(key.notAfter),
    });
  }

  private generateSigningKey(
    rootId: number,
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
      rootId,
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
        EXISTS (SELECT 1 FROM "IdentityNamespace" WHERE id <> 0 LIMIT 1)
        OR EXISTS (SELECT 1 FROM "S2SKeyCache" LIMIT 1)
        OR EXISTS (SELECT 1 FROM "LocalFederationSigningKey" LIMIT 1)
        OR EXISTS (SELECT 1 FROM "LocalFederationSigningState" LIMIT 1)
        AS "hasHistory"
    `);
    return result.rows[0]?.hasHistory === true;
  }

  /** The single key used for new outbound signatures; refuses to sign outside
   *  validity and outside the claimable root's validity. */
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
    const root = snapshot.roots.get(key.rootId)!;
    const now = Date.now();
    if (!isValidAt(key, now) || !isValidAt(root, now)) {
      throw new BusinessException(
        BusinessCode.FEDERATION_LOCAL_IDENTITY_LOST,
        `current signing key ${key.keyId} is outside its validity interval`,
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return key;
  }

  private claimableRoot(): LocalRootRow {
    return this.claimableRootOf(this.snapshot!);
  }

  private claimableRootOf(snapshot: LocalKeySnapshot): LocalRootRow {
    const root = snapshot.roots.get(snapshot.claimableRootId);
    if (!root || !root.claimable) {
      throw new BusinessException(
        BusinessCode.FEDERATION_LOCAL_IDENTITY_LOST,
        'claimable root epoch missing from local state',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return root;
  }

  private disable(reason: string): void {
    this.status = { available: false, reason };
    this.logger.error(`Federation disabled: ${reason}`);
  }
}
