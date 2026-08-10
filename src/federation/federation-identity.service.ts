import { HttpStatus, Injectable } from '@nestjs/common';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, lt } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import { isUniqueViolation } from '../database/database-error.js';
import * as tables from '../database/schema.js';
import { KeypairService } from './keypair.service.js';
import { loadFederationConfig } from './federation.config.js';
import { FEDERATION_PROTOCOL_VERSION } from './federation-protocol.js';

export interface FederationIdentityClaim {
  protocolVersion: typeof FEDERATION_PROTOCOL_VERSION;
  originDomain: string;
  recipientDomain: string;
  pairwiseServerId: string;
  rootKeyFingerprint: string;
  nonce: string;
  /** Unix epoch milliseconds. */
  issuedAt: number;
  /** Decimal bigint; present only on the one-time /ignite exchange. */
  startChangeId?: string;
}

export interface SignedFederationIdentity extends FederationIdentityClaim {
  keyId: string;
  signature: string;
}

const normalizeDomain = (value: string): string =>
  value.trim().toLowerCase().replace(/\.+$/, '');
const CLAIM_MAX_AGE_MS = 5 * 60_000;

@Injectable()
export class FederationIdentityService {
  private readonly config = loadFederationConfig();

  constructor(
    private readonly database: DatabaseService,
    private readonly keypair: KeypairService,
  ) {}

  createClaim(
    peerDomain: string,
    nonce = randomBytes(24).toString('base64url'),
    startChangeId?: bigint,
  ): FederationIdentityClaim {
    return {
      protocolVersion: FEDERATION_PROTOCOL_VERSION,
      originDomain: normalizeDomain(this.config.domain),
      recipientDomain: normalizeDomain(peerDomain),
      pairwiseServerId: this.keypair.getPairwiseServerId(peerDomain),
      rootKeyFingerprint: this.keypair.getRootKeyFingerprint(),
      nonce,
      issuedAt: Date.now(),
      ...(startChangeId === undefined
        ? {}
        : { startChangeId: startChangeId.toString() }),
    };
  }

  signClaim(claim: FederationIdentityClaim): SignedFederationIdentity {
    const signature = ed25519.sign(
      new TextEncoder().encode(this.serializeClaim(claim)),
      this.keypair.getPrivateKey(),
    );
    return {
      ...claim,
      keyId: this.keypair.getKeyId(),
      signature: Buffer.from(signature).toString('base64'),
    };
  }

  validateClaim(
    value: unknown,
    expectedOrigin: string,
    expectedRecipient: string,
    requireStartChangeId = false,
  ): FederationIdentityClaim {
    const claim = value as Partial<FederationIdentityClaim> | null;
    const issuedAt = claim?.issuedAt;
    if (
      claim?.protocolVersion !== FEDERATION_PROTOCOL_VERSION ||
      typeof claim.originDomain !== 'string' ||
      typeof claim.recipientDomain !== 'string' ||
      typeof claim.pairwiseServerId !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(claim.pairwiseServerId) ||
      typeof claim.rootKeyFingerprint !== 'string' ||
      !/^sha256:[A-Za-z0-9_-]{43}$/.test(claim.rootKeyFingerprint) ||
      typeof claim.nonce !== 'string' ||
      !/^[A-Za-z0-9_-]{22,128}$/.test(claim.nonce) ||
      typeof issuedAt !== 'number' ||
      !Number.isSafeInteger(issuedAt) ||
      issuedAt < 0 ||
      Math.abs(Date.now() - issuedAt) > CLAIM_MAX_AGE_MS ||
      normalizeDomain(claim.originDomain) !== normalizeDomain(expectedOrigin) ||
      normalizeDomain(claim.recipientDomain) !==
        normalizeDomain(expectedRecipient) ||
      (claim.startChangeId !== undefined &&
        !/^(0|[1-9][0-9]*)$/.test(claim.startChangeId)) ||
      (requireStartChangeId && claim.startChangeId === undefined)
    ) {
      throw this.invalidProof('invalid or stale federation identity claim');
    }
    return claim as FederationIdentityClaim;
  }

  verifySignedClaim(
    value: unknown,
    expectedOrigin: string,
    expectedRecipient: string,
    expectedNonce: string,
    publicKey: Uint8Array,
  ): SignedFederationIdentity {
    const signed = value as Partial<SignedFederationIdentity> | null;
    const claim = this.validateClaim(signed, expectedOrigin, expectedRecipient);
    if (
      claim.nonce !== expectedNonce ||
      typeof signed?.keyId !== 'string' ||
      normalizeDomain(signed.keyId.split('/')[0] ?? '') !==
        normalizeDomain(expectedOrigin) ||
      typeof signed.signature !== 'string'
    ) {
      throw this.invalidProof('identity response binding is invalid');
    }
    let valid = false;
    try {
      valid = ed25519.verify(
        Uint8Array.from(Buffer.from(signed.signature, 'base64')),
        new TextEncoder().encode(this.serializeClaim(claim)),
        publicKey,
      );
    } catch {
      valid = false;
    }
    if (!valid)
      throw this.invalidProof('identity response signature is invalid');
    return signed as SignedFederationIdentity;
  }

  async consumeNonce(
    originDomain: string,
    claim: FederationIdentityClaim,
  ): Promise<void> {
    try {
      await this.database.db.transaction((tx) =>
        this.consumeNonceInTx(tx, originDomain, claim),
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw this.invalidProof('identity nonce was already used');
      }
      throw error;
    }
  }

  async consumeNonceInTx(
    tx: DatabaseTransaction,
    originDomain: string,
    claim: FederationIdentityClaim,
  ): Promise<void> {
    const issuedAt = new Date(claim.issuedAt);
    await tx
      .delete(tables.s2SIdentityNonce)
      .where(lt(tables.s2SIdentityNonce.expiresAt, new Date()));
    await tx.insert(tables.s2SIdentityNonce).values({
      originDomain: normalizeDomain(originDomain),
      nonceHash: createHash('sha256').update(claim.nonce).digest('hex'),
      issuedAt,
      expiresAt: new Date(issuedAt.getTime() + CLAIM_MAX_AGE_MS),
    });
  }

  async pinOrVerify(
    domain: string,
    claim: FederationIdentityClaim,
    legacyContinuityProven = false,
  ): Promise<void> {
    const mismatchReason = await this.database.db.transaction((tx) =>
      this.pinOrVerifyInTx(tx, domain, claim, legacyContinuityProven),
    );
    if (mismatchReason) this.throwIdentityMismatch(mismatchReason);
  }

  async pinOrVerifyInTx(
    tx: DatabaseTransaction,
    domain: string,
    claim: FederationIdentityClaim,
    legacyContinuityProven = false,
  ): Promise<string | undefined> {
    const normalized = normalizeDomain(domain);
    // Serialize identity promotion with admin block/reset. Without this row lock an ignite transaction
    // can read `trusted`, an admin can commit `blocked`, and the stale ignite UPSERT can then overwrite
    // the durable policy decision back to `trusted`.
    const [peer] = await tx
      .select()
      .from(tables.federatedPeer)
      .where(eq(tables.federatedPeer.domain, normalized))
      .for('update')
      .limit(1);
    const reset = await tx.query.federatedPeerReset.findFirst({
      where: eq(tables.federatedPeerReset.domain, normalized),
    });
    if (!peer && reset && !reset.reinitPending) {
      throw new BusinessException(
        BusinessCode.FEDERATION_PEER_IDENTITY_LOST,
        `${normalized} was reset and is not allowed to rejoin`,
        HttpStatus.LOCKED,
      );
    }
    if (
      peer?.trustLevel === 'identity_lost' ||
      peer?.trustLevel === 'reset_in_progress'
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_PEER_IDENTITY_LOST,
        `${normalized} identity is locked pending reset`,
        HttpStatus.LOCKED,
      );
    }
    if (peer?.trustLevel === 'blocked') {
      throw new BusinessException(
        BusinessCode.FEDERATION_PEER_BLOCKED,
        `${normalized} is blocked by an admin`,
        HttpStatus.FORBIDDEN,
      );
    }
    const pinned =
      peer?.identityPinnedAt !== null && peer?.identityPinnedAt !== undefined;
    const mismatch =
      pinned &&
      (peer.pairwiseServerId !== claim.pairwiseServerId ||
        peer.rootKeyFingerprint !== claim.rootKeyFingerprint);
    if (mismatch || (peer && !pinned && !legacyContinuityProven)) {
      const reason = mismatch
        ? 'peer presented an identity different from the pinned identity'
        : 'existing peer identity could not be matched to its pre-upgrade cached key';
      await tx
        .update(tables.federatedPeer)
        .set({
          trustLevel: 'identity_lost',
          identityLostAt: new Date(),
          identityLostReason: reason,
        })
        .where(eq(tables.federatedPeer.domain, normalized));
      await tx.insert(tables.federatedPeerEvent).values({
        domain: normalized,
        type: 'identity_lost',
        reason,
      });
      return reason;
    }
    const now = new Date();
    await tx
      .insert(tables.federatedPeer)
      .values({
        domain: normalized,
        trustLevel: 'trusted',
        pairwiseServerId: claim.pairwiseServerId,
        rootKeyFingerprint: claim.rootKeyFingerprint,
        identityPinnedAt: now,
        trustedAt: now,
        lastSuccessAt: now,
      })
      .onConflictDoUpdate({
        target: tables.federatedPeer.domain,
        set: {
          trustLevel: 'trusted',
          pairwiseServerId: claim.pairwiseServerId,
          rootKeyFingerprint: claim.rootKeyFingerprint,
          identityPinnedAt: peer?.identityPinnedAt ?? now,
          identityLostAt: null,
          identityLostReason: null,
          // Preserve the first time this continuity edge became trusted. Recovery and ordinary
          // identity refresh advance lastSuccessAt but do not rewrite its historical start time.
          trustedAt: peer?.trustedAt ?? now,
          lastSuccessAt: now,
          demotedAt: null,
          demoteReason: null,
        },
      });
    if (!peer && reset?.reinitPending) {
      // Completing the destructive admin reset authorizes exactly one fresh identity bootstrap.
      // From this point onward the newly pinned peer must pass normal continuity checks; deleting
      // rows cannot reopen /init.
      await tx
        .update(tables.federatedPeerReset)
        .set({ reinitPending: false })
        .where(eq(tables.federatedPeerReset.domain, normalized));
    }
    if (!peer) {
      await tx
        .insert(tables.federatedPeerEvent)
        .values({ domain: normalized, type: 'discovered' });
    }
    if (!peer || peer.trustLevel !== 'trusted') {
      await tx
        .insert(tables.federatedPeerEvent)
        .values({ domain: normalized, type: 'trusted' });
    }
    return undefined;
  }

  throwIdentityMismatch(reason: string): never {
    throw new BusinessException(
      BusinessCode.FEDERATION_IDENTITY_MISMATCH,
      reason,
      HttpStatus.CONFLICT,
    );
  }

  throwNonceReplay(): never {
    throw this.invalidProof('identity nonce was already used');
  }

  /** Read before any well-known refresh so an upgraded peer cannot replace its own continuity evidence. */
  async getPreUpgradeCachedKey(
    domain: string,
    keyId: string,
  ): Promise<string | undefined> {
    const [peer, cached] = await Promise.all([
      this.database.db.query.federatedPeer.findFirst({
        columns: { identityPinnedAt: true },
        where: eq(tables.federatedPeer.domain, normalizeDomain(domain)),
      }),
      this.database.db.query.s2SKeyCache.findFirst({
        columns: { publicKey: true },
        where: and(
          eq(tables.s2SKeyCache.domain, normalizeDomain(domain)),
          eq(tables.s2SKeyCache.keyId, keyId),
        ),
      }),
    ]);
    if (!peer || peer.identityPinnedAt) return undefined;
    return cached?.publicKey;
  }

  async getPreUpgradeCachedKeys(domain: string): Promise<string[]> {
    const peer = await this.database.db.query.federatedPeer.findFirst({
      columns: { identityPinnedAt: true },
      where: eq(tables.federatedPeer.domain, normalizeDomain(domain)),
    });
    if (!peer || peer.identityPinnedAt) return [];
    const cached = await this.database.db.query.s2SKeyCache.findMany({
      columns: { publicKey: true },
      where: eq(tables.s2SKeyCache.domain, normalizeDomain(domain)),
    });
    return cached.map((row) => row.publicKey);
  }

  async requireIdentityEndpointPeer(domain: string): Promise<void> {
    const peer = await this.database.db.query.federatedPeer.findFirst({
      columns: { trustLevel: true },
      where: eq(tables.federatedPeer.domain, normalizeDomain(domain)),
    });
    if (!peer || !['trusted', 'demoted'].includes(peer.trustLevel)) {
      const locked =
        peer?.trustLevel === 'identity_lost' ||
        peer?.trustLevel === 'reset_in_progress';
      throw new BusinessException(
        locked
          ? BusinessCode.FEDERATION_PEER_IDENTITY_LOST
          : BusinessCode.FEDERATION_PEER_NOT_TRUSTED,
        locked
          ? `${domain} identity is locked pending reset`
          : `${domain} is not a known peer`,
        locked ? HttpStatus.LOCKED : HttpStatus.UNAUTHORIZED,
      );
    }
  }

  /** A valid signed identity request from a known demoted peer proves the pinned key is still held.
   * Promote that inbound trust edge before returning the nonce-bound response, so identity itself is
   * the recovery barrier and the peer can immediately pull its feeds. */
  async markIdentityEndpointRecovered(domain: string): Promise<void> {
    const normalized = normalizeDomain(domain);
    await this.database.db.transaction(async (tx) => {
      const [recovered] = await tx
        .update(tables.federatedPeer)
        .set({
          trustLevel: 'trusted',
          demotedAt: null,
          demoteReason: null,
          lastSuccessAt: new Date(),
        })
        .where(
          and(
            eq(tables.federatedPeer.domain, normalized),
            eq(tables.federatedPeer.trustLevel, 'demoted'),
          ),
        )
        .returning({ domain: tables.federatedPeer.domain });
      if (recovered) {
        await tx.insert(tables.federatedPeerEvent).values({
          domain: normalized,
          type: 'recovered',
          reason: 'pinned identity request verified',
        });
      }
    });
  }

  private serializeClaim(claim: FederationIdentityClaim): string {
    return JSON.stringify({
      protocolVersion: claim.protocolVersion,
      originDomain: normalizeDomain(claim.originDomain),
      recipientDomain: normalizeDomain(claim.recipientDomain),
      pairwiseServerId: claim.pairwiseServerId,
      rootKeyFingerprint: claim.rootKeyFingerprint,
      nonce: claim.nonce,
      issuedAt: claim.issuedAt,
      ...(claim.startChangeId === undefined
        ? {}
        : { startChangeId: claim.startChangeId }),
    });
  }

  private invalidProof(message: string): BusinessException {
    return new BusinessException(
      BusinessCode.FEDERATION_IDENTITY_PROOF_INVALID,
      message,
      HttpStatus.UNAUTHORIZED,
    );
  }
}
