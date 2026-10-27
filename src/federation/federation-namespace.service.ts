import { Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import { identityNamespace } from '../database/schema.js';
import { ProfileNamespaceFeedService } from './profile-namespace-feed.service.js';
import { ProfileNamespaceService } from './profile-namespace.service.js';

export interface FederationContext {
  domain: string;
  namespaceId: number;
  peerAssignedLocalNamespaceId: number;
  rootPublicKey: string;
}

export interface VerifiedFederationNamespace {
  domain: string;
  namespaceId: number;
  peerAssignedLocalNamespaceId: number | null;
  rootPublicKey: string;
}

export interface RetiredFederationNamespace {
  domain: string;
  namespaceId: number;
}

/** Owns the boundary between a current peer route domain and locally verified identity namespaces. */
@Injectable()
export class FederationNamespaceService {
  constructor(
    private readonly database: DatabaseService,
    private readonly profileNamespaceFeed: ProfileNamespaceFeedService,
    private readonly profileNamespace: ProfileNamespaceService,
  ) {}

  /** Best-effort namespace id → current domain binding for display and routing hints. Null when
   *  unknown or soft-retired. Authorization paths must capture a full verified context instead of
   *  trusting this lookup. */
  async activePeerDomainForNamespace(
    namespaceId: number,
  ): Promise<string | null> {
    const [peer] = await this.database.db
      .select({ domain: identityNamespace.domain })
      .from(identityNamespace)
      .where(eq(identityNamespace.id, namespaceId))
      .limit(1);
    return peer?.domain ?? null;
  }

  /** Current domain and root key for a contact-card namespace. Unlike the
   *  display-only domain lookup, this requires a live root key because contact
   *  cards are portable federation addresses and must be pinned to the identity
   *  epoch they name. */
  async activeContactCardBindingForNamespace(namespaceId: number): Promise<{
    domain: string;
    publicKey: string;
  } | null> {
    if (namespaceId === 0) return null;
    const [peer] = await this.database.db
      .select({
        domain: identityNamespace.domain,
        rootPublicKey: identityNamespace.rootPublicKey,
        active: identityNamespace.active,
        retiredAt: identityNamespace.retiredAt,
      })
      .from(identityNamespace)
      .where(eq(identityNamespace.id, namespaceId))
      .limit(1);
    return peer?.active && peer.retiredAt === null && peer.rootPublicKey
      ? { domain: peer.domain, publicKey: peer.rootPublicKey }
      : null;
  }

  async captureActive(domain: string): Promise<FederationContext> {
    return this.database.db.transaction((tx) =>
      this.captureActiveInTx(tx, domain),
    );
  }

  /** Captures a known peer by its lifelong namespace id. The id is the
   *  durable identity key: the row's current domain binding is followed even
   *  across a review-approved re-bind, and only reset retirement ends the
   *  identity. Callers with prior knowledge address peers by id, never by a
   *  domain they remember. */
  async captureActiveByIdInTx(
    tx: DatabaseTransaction,
    namespaceId: number,
  ): Promise<FederationContext> {
    const [row] = await tx
      .select({
        domain: identityNamespace.domain,
        namespaceId: identityNamespace.id,
        peerAssignedLocalNamespaceId:
          identityNamespace.peerAssignedLocalNamespaceId,
        rootPublicKey: identityNamespace.rootPublicKey,
        active: identityNamespace.active,
        retiredAt: identityNamespace.retiredAt,
      })
      .from(identityNamespace)
      .where(eq(identityNamespace.id, namespaceId))
      .limit(1);
    if (
      !row ||
      row.retiredAt !== null ||
      !row.active ||
      row.peerAssignedLocalNamespaceId === null ||
      row.rootPublicKey === null
    )
      this.unavailableById(namespaceId);
    const { active: _active, retiredAt: _retiredAt, ...context } = row;
    return {
      ...context,
      peerAssignedLocalNamespaceId: context.peerAssignedLocalNamespaceId!,
      rootPublicKey: context.rootPublicKey!,
    };
  }

  async captureActiveInTx(
    tx: DatabaseTransaction,
    domain: string,
  ): Promise<FederationContext> {
    const row = await this.captureVerifiedInTx(tx, domain);
    if (row.peerAssignedLocalNamespaceId === null) this.unavailable(domain);
    return {
      ...row,
      peerAssignedLocalNamespaceId: row.peerAssignedLocalNamespaceId,
    };
  }

  /** The node's own identity domain (namespace 0), read inside the caller's
   *  transaction. The local namespace row is intentionally inactive (the
   *  active flag only marks federation peers), so first-contact by domain
   *  must resolve it here instead of through captureActiveInTx. */
  async localDomainInTx(tx: DatabaseTransaction): Promise<string> {
    const [row] = await tx
      .select({ domain: identityNamespace.domain })
      .from(identityNamespace)
      .where(eq(identityNamespace.id, 0));
    if (!row) throw new Error('local identity namespace row is missing');
    return row.domain.trim().toLowerCase();
  }

  async captureVerifiedInTx(
    tx: DatabaseTransaction,
    domain: string,
  ): Promise<VerifiedFederationNamespace> {
    const [row] = await tx
      .select({
        domain: identityNamespace.domain,
        namespaceId: identityNamespace.id,
        peerAssignedLocalNamespaceId:
          identityNamespace.peerAssignedLocalNamespaceId,
        rootPublicKey: identityNamespace.rootPublicKey,
      })
      .from(identityNamespace)
      .where(
        and(
          eq(identityNamespace.domain, domain),
          eq(identityNamespace.active, true),
          isNull(identityNamespace.retiredAt),
        ),
      )
      .limit(1);
    if (!row || row.rootPublicKey === null) this.unavailable(domain);
    return {
      domain: row.domain,
      namespaceId: row.namespaceId,
      peerAssignedLocalNamespaceId: row.peerAssignedLocalNamespaceId,
      rootPublicKey: row.rootPublicKey,
    };
  }

  /** A captured context remains valid after retirement so an already-running transaction can end. */
  async requireCapturedInTx(
    tx: DatabaseTransaction,
    context: FederationContext,
  ): Promise<void> {
    const [row] = await tx
      .select({ id: identityNamespace.id })
      .from(identityNamespace)
      .where(
        and(
          eq(identityNamespace.id, context.namespaceId),
          eq(identityNamespace.rootPublicKey, context.rootPublicKey),
        ),
      )
      .limit(1);
    if (!row) {
      throw new BusinessException(
        BusinessCode.FEDERATION_PEER_IDENTITY_LOST,
        `unknown federation namespace ${context.namespaceId} for ${context.domain}`,
      );
    }
  }

  async recordPeerAssignedLocalNamespaceInTx(
    tx: DatabaseTransaction,
    domain: string,
    peerAssignedLocalNamespaceId: number,
  ): Promise<void> {
    const [peer] = await tx
      .select({ id: identityNamespace.id })
      .from(identityNamespace)
      .where(
        and(
          eq(identityNamespace.domain, domain),
          eq(identityNamespace.active, true),
          isNull(identityNamespace.retiredAt),
        ),
      )
      .for('no key update')
      .limit(1);
    if (!peer) this.unavailable(domain);
    const [updated] = await tx
      .update(identityNamespace)
      .set({ peerAssignedLocalNamespaceId })
      .where(eq(identityNamespace.id, peer.id))
      .returning({ id: identityNamespace.id });
    if (!updated) this.unavailable(domain);
  }

  /** Pins the first verified identity after discovery/reset, or validates the current active pin. */
  async activateVerifiedInTx(
    tx: DatabaseTransaction,
    identity: {
      domain: string;
      rootPublicKey: string;
      identityPinnedAt: Date;
      signingKeyCreatedAt: number;
    },
  ): Promise<VerifiedFederationNamespace> {
    const [active] = await tx
      .select()
      .from(identityNamespace)
      .where(
        and(
          eq(identityNamespace.domain, identity.domain),
          eq(identityNamespace.active, true),
          isNull(identityNamespace.retiredAt),
        ),
      )
      .for('no key update')
      .limit(1);

    if (active) {
      if (active.rootPublicKey !== identity.rootPublicKey) {
        throw new BusinessException(
          BusinessCode.FEDERATION_IDENTITY_MISMATCH,
          `${identity.domain} does not match its active federation namespace`,
        );
      }
      return {
        domain: identity.domain,
        namespaceId: active.id,
        peerAssignedLocalNamespaceId: active.peerAssignedLocalNamespaceId,
        rootPublicKey: identity.rootPublicKey,
      };
    }

    const [created] = await tx
      .insert(identityNamespace)
      .values({ ...identity, active: true })
      .returning({ id: identityNamespace.id });
    if (!created || created.id <= 0)
      throw new Error('failed to allocate a federation namespace');
    // A newly allocated namespace item is one feed modification. The entry
    // never matches a consumer's cached row (the id is new); it is recorded
    // for uniformity so every namespace birth advances the shared feed.
    await this.profileNamespaceFeed.recordNamespaceChangeInTx(tx, created.id);
    // Handshake seed: the peer's own binding is known from the
    // hostname-verified domain and root of this activation; updateFeedId 0
    // lets the first feed pull refresh the counter.
    await this.profileNamespace.seedDirectRowInTx(
      tx,
      created.id,
      identity.domain,
      identity.rootPublicKey,
    );
    return {
      domain: identity.domain,
      namespaceId: created.id,
      peerAssignedLocalNamespaceId: null,
      rootPublicKey: identity.rootPublicKey,
    };
  }

  async retireActiveInTx(
    tx: DatabaseTransaction,
    domain: string,
    retiredAt = new Date(),
  ): Promise<RetiredFederationNamespace> {
    const [peer] = await tx
      .select({ id: identityNamespace.id })
      .from(identityNamespace)
      .where(
        and(
          eq(identityNamespace.domain, domain),
          eq(identityNamespace.active, true),
          isNull(identityNamespace.retiredAt),
        ),
      )
      .for('no key update')
      .limit(1);
    if (!peer) this.unavailable(domain);
    await tx
      .update(identityNamespace)
      .set({ retiredAt, active: false })
      .where(eq(identityNamespace.id, peer.id));
    return { domain, namespaceId: peer.id };
  }

  private unavailable(domain: string): never {
    throw new BusinessException(
      BusinessCode.FEDERATION_PEER_IDENTITY_LOST,
      `federation peer ${domain} has no active namespace`,
    );
  }

  private unavailableById(namespaceId: number): never {
    throw new BusinessException(
      BusinessCode.FEDERATION_PEER_IDENTITY_LOST,
      `federation namespace ${namespaceId} is retired or unknown`,
    );
  }
}
