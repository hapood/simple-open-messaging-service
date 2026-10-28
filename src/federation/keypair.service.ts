import {
  HttpStatus,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ed25519 } from '@noble/curves/ed25519.js';
import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import {
  account,
  identityNamespace,
  localFederationRoot,
  localFederationSigningKey,
  localFederationSigningState,
} from '../database/schema.js';
import {
  loadFederationConfig,
  type SigningKeyLifecycleConfig,
  type RootKeyLifecycleConfig,
} from './federation.config.js';
import {
  signingCertificateStatement,
  type RootKeyEntry,
  type SigningKeyCertificate,
} from './federation-certificate.js';
import type { S2SAddress } from './federation-address.js';
import { ProfileNamespaceChangeStore } from './profile-namespace-change-store.service.js';
import { openSealedBox } from './sealed-box.js';
import { SseService } from '../gateway/sse.service.js';

type KeypairConfig = {
  domain: string;
  signingKey: SigningKeyLifecycleConfig;
  rootKey: RootKeyLifecycleConfig;
};

export type LocalFederationIdentityStatus =
  | { available: true }
  | { available: false; reason: string };

/** In-memory view of one local signing-key row (epoch milliseconds everywhere). */
interface LocalSigningKeyRow {
  keyName: string;
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
  rootPublicKey: string;
  rootPrivateKey: string;
  notBefore: number;
  notAfter: number;
  claimable: boolean;
  unpublishedAt: number | null;
}

/** Public administration view of a retained root epoch. Private material is never exposed. */
export interface LocalRootEpochView {
  id: number;
  domain: string;
  rootPublicKey: string;
  notBefore: number;
  notAfter: number;
  claimable: boolean;
  unpublishedAt: number | null;
  signingKeyCount: number;
  claimableKeyCount: number;
}

/** Result of an administrator-triggered root rotation. `clientChangeId` is
 *  the allocated client change position (decimal string) that announced the
 *  new (0, 0) binding to devices. */
export interface RootRotationResult {
  previousRootId: number;
  newRootId: number;
  newRootPublicKey: string;
  clientChangeId: string;
}

/** Immutable snapshot of the database-backed local identity, cached for the synchronous getters. */
interface LocalKeySnapshot {
  identityDomain: string;
  roots: Map<number, LocalRootRow>;
  claimableRootId: number;
  keys: Map<string, LocalSigningKeyRow>;
  currentKeyName: string;
  plannedSwitchAt: number | null;
  plannedSuccessorKeyName: string | null;
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
 * rotation; rotation itself never cleans up.
 *
 * The snapshot is refreshed by the maintenance tick — at most every 30s, and earlier
 * when a persisted lifecycle event (successor prepublication, planned switch,
 * predecessor expiry) falls due sooner. A short staleness window is harmless because
 * a switched-out predecessor remains published and valid for the configured retention,
 * so receivers still authenticate it while the refresh lands.
 */
@Injectable()
export class KeypairService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KeypairService.name);
  private readonly config: KeypairConfig = loadFederationConfig();
  private snapshot: LocalKeySnapshot | undefined;
  private status: LocalFederationIdentityStatus = {
    available: false,
    reason: 'federation identity has not been initialized',
  };
  private maintainTimer: NodeJS.Timeout | undefined;
  private initializationPromise: Promise<void> | undefined;

  constructor(
    private readonly database: DatabaseService,
    private readonly changes: ProfileNamespaceChangeStore,
    private readonly sse: SseService,
  ) {}

  /** Initialize in onModuleInit, not onApplicationBootstrap: the persisted identity domain is
   *  boot-input for other modules' init-phase work (e.g. SettingsService's VAPID subject), and
   *  Nest runs every onModuleInit before any onApplicationBootstrap. Ordering within the phase is
   *  guaranteed by the SettingsModule → FederationModule import edge. */
  async onModuleInit(): Promise<void> {
    await this.initialize();
  }

  onModuleDestroy(): void {
    if (this.maintainTimer) clearTimeout(this.maintainTimer);
    this.maintainTimer = undefined;
  }

  /** Public for focused startup tests; normal application startup calls it through the Nest hook. */
  async initialize(): Promise<void> {
    if (!this.initializationPromise) {
      this.initializationPromise = this.initializeOnce();
    }
    return this.initializationPromise;
  }

  /** Waits for the singleton startup lifecycle and requires a usable local identity. */
  async waitUntilInitialized(): Promise<void> {
    await this.initialize();
    this.assertAvailable();
  }

  /** Runs one explicit signing-key maintenance pass after startup initialization. */
  async maintain(): Promise<void> {
    await this.initialize();
    await this.maintainRotation();
  }

  private async initializeOnce(): Promise<void> {
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
      throw error;
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

  /** Runtime local domain loaded from IdentityNamespace(0), never re-read from configuration. */
  getIdentityDomain(): string {
    this.assertAvailable();
    return this.snapshot!.identityDomain;
  }

  /** The wire address of a subject in this publisher's local namespace. */
  localAddress(account: string): S2SAddress {
    return { account, domain: this.getIdentityDomain() };
  }

  getKeyId(): string {
    const key = this.activeSigningKey();
    return `${this.getIdentityDomain()}/${key.keyName}`;
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
   *  listed until an operator unpublishes it after peer adoption — rotation
   *  itself never cleans up. */
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
  getRootEpochs(): LocalRootEpochView[] {
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
          id: root.id,
          rootPublicKey: root.rootPublicKey,
          notBefore: root.notBefore,
          notAfter: root.notAfter,
          claimable: root.claimable,
          unpublishedAt: root.unpublishedAt,
          domain: snapshot.identityDomain,
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
      .sort(
        (a, b) => a.notBefore - b.notBefore || (a.keyName < b.keyName ? -1 : 1),
      )
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
   *  Returns canonical padded base64 of the recovered bytes; throws the wire-mapped
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
    return Buffer.from(opened).toString('base64');
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
    const rotation = await this.database.db.transaction(async (tx) => {
      await tx.execute(KEY_LIFECYCLE_LOCK);
      const snapshot = await this.reloadSnapshot(tx);
      if (!snapshot) throw new Error('local identity rows disappeared');
      const previous = this.claimableRootOf(snapshot);
      const now = Date.now();
      const rootPrivateKey = ed25519.utils.randomSecretKey();
      const rootPublicKey = ed25519.getPublicKey(rootPrivateKey);
      const rootPublicKeyB64 = b64(rootPublicKey);
      const rootNotAfter = now + this.config.rootKey.lifetimeMs;
      // Release the previous epoch's claim before inserting the replacement:
      // the partial unique index LocalFederationRoot_one_claimable_key allows at
      // most one claimable local root, and both statements share this
      // transaction, so committed state always has exactly one claimable epoch.
      await tx
        .update(localFederationRoot)
        .set({ claimable: false })
        .where(eq(localFederationRoot.id, previous.id));
      const [insertedRoot] = await tx
        .insert(localFederationRoot)
        .values({
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
        now,
        Math.min(now + this.config.signingKey.lifetimeMs, rootNotAfter),
      );
      await this.insertSigningKey(tx, initial);
      await tx
        .update(localFederationSigningState)
        .set({
          currentKeyName: initial.keyName,
          plannedSwitchAt: null,
          plannedSuccessorKeyName: null,
          updatedAt: new Date(now),
        })
        .where(eq(localFederationSigningState.id, 0));
      const next = await this.reloadSnapshot(tx);
      if (!next) throw new Error('local identity rows disappeared');
      // Notify local clients of the new self binding. Remote identity adoption
      // follows the verified root-rotation exchange, not the namespace feed.
      const clientChangeId = await this.changes.recordClientChangeInTx(tx, {
        publisherNamespaceId: 0,
        profileNamespaceId: 0,
      });
      this.logger.warn(
        `Rotated S2S root identity: ${previous.rootPublicKey.slice(0, 12)}… -> ${rootPublicKeyB64.slice(0, 12)}…; predecessor-authorized certificates are revoked by this switch`,
      );
      return {
        previousRootId: previous.id,
        newRootId: insertedRoot.id,
        newRootPublicKey: rootPublicKeyB64,
        clientChangeId,
        snapshot: next,
      };
    });
    this.snapshot = rotation.snapshot;
    this.sse.notifyProfileNamespaceChange(rotation.clientChangeId);
    return {
      previousRootId: rotation.previousRootId,
      newRootId: rotation.newRootId,
      newRootPublicKey: rotation.newRootPublicKey,
      clientChangeId: rotation.clientChangeId.toString(),
    };
  }

  /**
   * Remove a rotated-out root from the published roots group. Only legal after
   * every recognized peer adopted the rotation (or the rotation is abandoned);
   * refuses to unpublish the claimable root and any still-valid root.
   */
  async unpublishRoot(rootId: number): Promise<void> {
    this.assertAvailable();
    const next = await this.database.db.transaction(async (tx) => {
      await tx.execute(KEY_LIFECYCLE_LOCK);
      const snapshot = await this.reloadSnapshot(tx);
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
      const reloaded = await this.reloadSnapshot(tx);
      if (!reloaded) throw new Error('local identity rows disappeared');
      return reloaded;
    });
    this.snapshot = next;
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
    const current = snapshot.keys.get(snapshot.currentKeyName);
    if (current) {
      events.push(current.notAfter);
      if (!snapshot.plannedSuccessorKeyName) {
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
    // Configuration is only the startup input. Once this transaction commits,
    // namespace 0 is the authoritative local-domain record for runtime reads.
    const domain = this.config.domain;
    const loaded = await this.database.db.transaction(async (tx) => {
      await tx.execute(KEY_LIFECYCLE_LOCK);
      const localNamespace = await tx.query.identityNamespace.findFirst({
        where: eq(identityNamespace.id, 0),
        columns: { id: true },
      });
      if (!localNamespace) {
        await tx.insert(identityNamespace).values({
          id: 0,
          domain,
          rootPublicKey: null,
          identityPinnedAt: null,
          signingKeyCreatedAt: 0,
        });
      } else {
        await this.rebindLocalDomainInTx(tx, domain);
      }
      const snapshot = await this.reloadSnapshot(tx);
      if (snapshot) return snapshot;

      if (await this.hasFederationHistory(tx)) {
        this.disable(
          'federation history exists but the local root-identity rows are missing; restore the database from backup',
        );
        return null;
      }
      const generated = await this.generateIdentity(tx);
      this.logger.warn(
        'Generated a new database-backed S2S identity. BACK THE DATABASE UP — root-key loss requires every peer to approve this server again',
      );
      return generated;
    });
    if (!loaded) return false;
    this.snapshot = loaded;
    return true;
  }

  /**
   * Changes only the local namespace binding and its announcements. Key material,
   * validity intervals, and rotation plans are independent of domain changes.
   * Wire KeyIds and root authorization signatures use the current namespace domain.
   */
  private async rebindLocalDomainInTx(
    tx: DatabaseTransaction,
    nextDomain: string,
  ): Promise<void> {
    const localNamespace = await tx.query.identityNamespace.findFirst({
      where: eq(identityNamespace.id, 0),
      columns: { domain: true },
    });
    if (!localNamespace) throw new Error('local namespace is missing');
    if (localNamespace.domain === nextDomain) return;

    await tx
      .update(identityNamespace)
      .set({ domain: nextDomain })
      .where(eq(identityNamespace.id, 0));
    await tx
      .update(account)
      .set({ updatedAt: new Date() })
      .where(eq(account.namespaceId, 0));
    await this.changes.recordClientChangeInTx(tx, {
      publisherNamespaceId: 0,
      profileNamespaceId: 0,
    });
    this.logger.warn(
      `Re-bound local federation domain ${localNamespace.domain} -> ${nextDomain}; peers must confirm the new domain through Recognize and Health`,
    );
  }

  /** Reload every root epoch and signing-key row; null when the tables are empty. */
  private async reloadSnapshot(
    tx: DatabaseTransaction,
  ): Promise<LocalKeySnapshot | null> {
    const localNamespace = await tx.query.identityNamespace.findFirst({
      where: eq(identityNamespace.id, 0),
      columns: { domain: true },
    });
    if (!localNamespace) throw new Error('local namespace is missing');
    const roots = await tx.query.localFederationRoot.findMany();
    const keys = await tx.query.localFederationSigningKey.findMany();
    const state = await tx.query.localFederationSigningState.findFirst({
      where: eq(localFederationSigningState.id, 0),
    });
    const rootRows = new Map<number, LocalRootRow>();
    let claimableRootId: number | null = null;
    for (const row of roots) {
      rootRows.set(row.id, {
        id: row.id,
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
    if (!state) {
      throw new Error('local signing selection state is missing');
    }
    const keyRows = new Map<string, LocalSigningKeyRow>();
    for (const row of keys) {
      if (!rootRows.has(row.rootId)) continue;
      keyRows.set(row.keyName, {
        keyName: row.keyName,
        rootId: row.rootId,
        publicKey: row.publicKey,
        privateKey: row.privateKey,
        createdAt: row.createdAt.getTime(),
        notBefore: row.notBefore.getTime(),
        notAfter: row.notAfter.getTime(),
      });
    }
    if (!keyRows.has(state.currentKeyName)) {
      throw new Error('current signing key row is missing');
    }
    if (
      state.plannedSuccessorKeyName &&
      !keyRows.has(state.plannedSuccessorKeyName)
    ) {
      throw new Error('planned successor signing key row is missing');
    }
    if (state.plannedSuccessorKeyName) {
      const successor = keyRows.get(state.plannedSuccessorKeyName)!;
      if (
        state.plannedSwitchAt === null ||
        successor.notBefore + this.config.signingKey.clockSkewBudgetMs >
          state.plannedSwitchAt.getTime()
      ) {
        throw new Error('planned switch violates the clock-skew budget');
      }
    }
    if (keyRows.get(state.currentKeyName)!.rootId !== claimableRootId) {
      throw new Error(
        'current signing key is not authorized by the claimable root',
      );
    }
    return {
      identityDomain: localNamespace.domain,
      roots: rootRows,
      claimableRootId,
      keys: keyRows,
      currentKeyName: state.currentKeyName,
      plannedSwitchAt: state.plannedSwitchAt?.getTime() ?? null,
      plannedSuccessorKeyName: state.plannedSuccessorKeyName ?? null,
    };
  }

  private async generateIdentity(
    tx: DatabaseTransaction,
  ): Promise<LocalKeySnapshot> {
    const now = Date.now();
    const rootNotAfter = now + this.config.rootKey.lifetimeMs;
    const rootPrivateKey = ed25519.utils.randomSecretKey();
    const rootPublicKey = ed25519.getPublicKey(rootPrivateKey);
    const rootPublicKeyB64 = b64(rootPublicKey);

    const [insertedRoot] = await tx
      .insert(localFederationRoot)
      .values({
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
      now,
      Math.min(now + this.config.signingKey.lifetimeMs, rootNotAfter),
    );
    await this.insertSigningKey(tx, initial);
    await tx.insert(localFederationSigningState).values({
      id: 0,
      currentKeyName: initial.keyName,
      plannedSwitchAt: null,
      plannedSuccessorKeyName: null,
      updatedAt: new Date(now),
    });

    const snapshot = await this.reloadSnapshot(tx);
    if (!snapshot) throw new Error('local identity rows disappeared');
    return snapshot;
  }

  /** Advances the signing-key rotation lifecycle: due switches, recovery from an
   *  expired current key, successor planning. Mutations run in one transaction
   *  under the key-lifecycle advisory lock, so concurrent instances cannot
   *  double-switch. Expired key rows are never deleted: retained key history
   *  keeps sealed challenges openable forever. */
  private async maintainRotation(): Promise<void> {
    if (!this.snapshot) throw new Error('local identity has not been loaded');
    const next = await this.database.db.transaction(async (tx) => {
      await tx.execute(KEY_LIFECYCLE_LOCK);
      const snapshot = await this.reloadSnapshot(tx);
      if (!snapshot) throw new Error('local identity rows disappeared');
      const claimableRoot = this.claimableRootOf(snapshot);
      if (claimableRoot.notAfter <= Date.now()) {
        throw new Error(
          'the claimable root epoch has expired; rotate the root identity to restore signing',
        );
      }
      const keys = snapshot.keys;
      const now = Date.now();
      let currentKeyName = snapshot.currentKeyName;
      let plannedSwitchAt = snapshot.plannedSwitchAt;
      let plannedSuccessorKeyName = snapshot.plannedSuccessorKeyName;
      let changed = false;

      const currentKey = keys.get(currentKeyName);
      if (!currentKey) throw new Error('current signing key row is missing');
      const successorKey = plannedSuccessorKeyName
        ? keys.get(plannedSuccessorKeyName)
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
        currentKeyName = successorKey!.keyName;
        plannedSwitchAt = null;
        plannedSuccessorKeyName = null;
        changed = true;
        this.logger.log(
          `Switched local S2S signing key to ${currentKeyName} under the unchanged root`,
        );
      } else if (currentExpired) {
        // No valid successor either (for example after a long outage): recover under the
        // claimable root with a fresh immediately-valid key. Peers refresh on key miss
        // and accept it because the pinned root still authorizes it.
        const recovery = this.generateSigningKey(
          claimableRoot.id,
          now,
          Math.min(
            now + this.config.signingKey.lifetimeMs,
            claimableRoot.notAfter,
          ),
        );
        await this.insertSigningKey(tx, recovery);
        keys.set(recovery.keyName, recovery);
        currentKeyName = recovery.keyName;
        plannedSwitchAt = null;
        plannedSuccessorKeyName = null;
        changed = true;
        this.logger.warn(
          `Current signing key expired without a valid successor; generated recovery key ${recovery.keyName}`,
        );
      } else if (
        successorKey &&
        !isValidAt(successorKey, now) &&
        now >= (plannedSwitchAt ?? now)
      ) {
        // A plan whose successor can no longer serve is void; replan below.
        plannedSwitchAt = null;
        plannedSuccessorKeyName = null;
        changed = true;
        this.logger.warn(
          'Voided a local signing-key plan whose successor is no longer usable',
        );
      }

      if (!plannedSuccessorKeyName) {
        const current = keys.get(currentKeyName)!;
        const remaining = current.notAfter - now;
        if (
          remaining <=
          this.config.signingKey.successorPrepublicationMs +
            this.config.signingKey.predecessorRetentionMs
        ) {
          const successor = this.generateSigningKey(
            claimableRoot.id,
            now,
            Math.min(
              now + this.config.signingKey.lifetimeMs,
              claimableRoot.notAfter,
            ),
          );
          await this.insertSigningKey(tx, successor);
          keys.set(successor.keyName, successor);
          plannedSuccessorKeyName = successor.keyName;
          plannedSwitchAt = Math.max(
            current.notAfter - this.config.signingKey.predecessorRetentionMs,
            now + this.config.signingKey.clockSkewBudgetMs,
          );
          changed = true;
          this.logger.log(
            `Planned S2S signing-key switch to ${successor.keyName} at ${new Date(plannedSwitchAt).toISOString()}`,
          );
        }
      }

      if (changed) {
        await tx
          .update(localFederationSigningState)
          .set({
            currentKeyName,
            plannedSwitchAt:
              plannedSwitchAt === null ? null : new Date(plannedSwitchAt),
            plannedSuccessorKeyName,
            updatedAt: new Date(now),
          })
          .where(eq(localFederationSigningState.id, 0));
      }

      return {
        identityDomain: snapshot.identityDomain,
        roots: snapshot.roots,
        claimableRootId: snapshot.claimableRootId,
        keys,
        currentKeyName,
        plannedSwitchAt,
        plannedSuccessorKeyName,
      };
    });
    this.snapshot = next;
  }

  private toCertificate(
    key: LocalSigningKeyRow,
    snapshot: LocalKeySnapshot,
  ): SigningKeyCertificate {
    const root = snapshot.roots.get(key.rootId)!;
    const unsigned = {
      keyId: `${snapshot.identityDomain}/${key.keyName}`,
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
    tx: DatabaseTransaction,
    key: LocalSigningKeyRow,
  ): Promise<void> {
    await tx.insert(localFederationSigningKey).values({
      rootId: key.rootId,
      keyName: key.keyName,
      publicKey: key.publicKey,
      privateKey: key.privateKey,
      createdAt: new Date(key.createdAt),
      notBefore: new Date(key.notBefore),
      notAfter: new Date(key.notAfter),
    });
  }

  private generateSigningKey(
    rootId: number,
    notBefore: number,
    notAfter: number,
  ): LocalSigningKeyRow {
    const privateKey = ed25519.utils.randomSecretKey();
    const publicKey = ed25519.getPublicKey(privateKey);
    // Opaque KeyName satisfying the KeyId grammar; never reused under the same root.
    const keyName = `k-${randomBytes(15).toString('base64url')}`;
    return {
      keyName,
      rootId,
      publicKey: b64(publicKey),
      privateKey: b64(privateKey),
      createdAt: notBefore,
      notBefore,
      notAfter,
    };
  }

  private async hasFederationHistory(
    tx: DatabaseTransaction,
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
    const key = snapshot.keys.get(snapshot.currentKeyName);
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
        `current signing key ${key.keyName} is outside its validity interval`,
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
