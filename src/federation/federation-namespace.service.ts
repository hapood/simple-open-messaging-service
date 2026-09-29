import { Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import { federatedPeer, identityNamespace } from '../database/schema.js';

export interface FederationContext {
  domain: string;
  namespaceId: number;
  peerAssignedLocalNamespaceId: number;
  rootKeyFingerprint: string;
}

export interface VerifiedFederationNamespace {
  domain: string;
  namespaceId: number;
  peerAssignedLocalNamespaceId: number | null;
  rootKeyFingerprint: string;
}

export interface RetiredFederationNamespace {
  domain: string;
  namespaceId: number;
}

/** Owns the boundary between a stable public peer domain and locally verified identity epochs. */
@Injectable()
export class FederationNamespaceService {
  constructor(private readonly database: DatabaseService) {}

  async captureActive(domain: string): Promise<FederationContext> {
    return this.database.db.transaction((tx) =>
      this.captureActiveInTx(tx, domain),
    );
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

  async captureVerifiedInTx(
    tx: DatabaseTransaction,
    domain: string,
  ): Promise<VerifiedFederationNamespace> {
    const [row] = await tx
      .select({
        peerDomain: federatedPeer.domain,
        namespaceId: identityNamespace.id,
        peerAssignedLocalNamespaceId:
          identityNamespace.peerAssignedLocalNamespaceId,
        rootKeyFingerprint: identityNamespace.rootKeyFingerprint,
      })
      .from(federatedPeer)
      .innerJoin(
        identityNamespace,
        and(
          eq(identityNamespace.id, federatedPeer.activeNamespaceId),
          eq(identityNamespace.domain, federatedPeer.domain),
          isNull(identityNamespace.retiredAt),
        ),
      )
      .where(eq(federatedPeer.domain, domain))
      .limit(1);
    if (!row || row.rootKeyFingerprint === null) this.unavailable(domain);
    return {
      domain: row.peerDomain,
      namespaceId: row.namespaceId,
      peerAssignedLocalNamespaceId: row.peerAssignedLocalNamespaceId,
      rootKeyFingerprint: row.rootKeyFingerprint,
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
          eq(identityNamespace.domain, context.domain),
          eq(identityNamespace.rootKeyFingerprint, context.rootKeyFingerprint),
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
      .select({ activeNamespaceId: federatedPeer.activeNamespaceId })
      .from(federatedPeer)
      .where(eq(federatedPeer.domain, domain))
      .for('no key update')
      .limit(1);
    if (
      peer?.activeNamespaceId === null ||
      peer?.activeNamespaceId === undefined
    )
      this.unavailable(domain);
    const [updated] = await tx
      .update(identityNamespace)
      .set({ peerAssignedLocalNamespaceId })
      .where(
        and(
          eq(identityNamespace.id, peer.activeNamespaceId),
          eq(identityNamespace.domain, domain),
          isNull(identityNamespace.retiredAt),
        ),
      )
      .returning({ id: identityNamespace.id });
    if (!updated) this.unavailable(domain);
  }

  /** Pins the first verified identity after discovery/reset, or validates the current active pin. */
  async activateVerifiedInTx(
    tx: DatabaseTransaction,
    identity: {
      domain: string;
      rootKeyFingerprint: string;
      rootPublicKey: string;
      identityPinnedAt: Date;
    },
  ): Promise<VerifiedFederationNamespace> {
    const [peer] = await tx
      .select({ activeNamespaceId: federatedPeer.activeNamespaceId })
      .from(federatedPeer)
      .where(eq(federatedPeer.domain, identity.domain))
      .for('no key update')
      .limit(1);
    if (!peer) this.unavailable(identity.domain);

    if (peer.activeNamespaceId !== null) {
      const [active] = await tx
        .select()
        .from(identityNamespace)
        .where(
          and(
            eq(identityNamespace.id, peer.activeNamespaceId),
            eq(identityNamespace.domain, identity.domain),
            isNull(identityNamespace.retiredAt),
          ),
        )
        .limit(1);
      if (
        !active ||
        active.rootKeyFingerprint !== identity.rootKeyFingerprint ||
        active.rootPublicKey !== identity.rootPublicKey
      ) {
        throw new BusinessException(
          BusinessCode.FEDERATION_IDENTITY_MISMATCH,
          `${identity.domain} does not match its active federation namespace`,
        );
      }
      return {
        domain: identity.domain,
        namespaceId: active.id,
        peerAssignedLocalNamespaceId: active.peerAssignedLocalNamespaceId,
        rootKeyFingerprint: identity.rootKeyFingerprint,
      };
    }

    const [created] = await tx
      .insert(identityNamespace)
      .values(identity)
      .returning({ id: identityNamespace.id });
    if (!created || created.id <= 0)
      throw new Error('failed to allocate a federation namespace');
    await tx
      .update(federatedPeer)
      .set({ activeNamespaceId: created.id })
      .where(eq(federatedPeer.domain, identity.domain));
    return {
      domain: identity.domain,
      namespaceId: created.id,
      peerAssignedLocalNamespaceId: null,
      rootKeyFingerprint: identity.rootKeyFingerprint,
    };
  }

  async retireActiveInTx(
    tx: DatabaseTransaction,
    domain: string,
    retiredAt = new Date(),
  ): Promise<RetiredFederationNamespace> {
    const [peer] = await tx
      .select({ activeNamespaceId: federatedPeer.activeNamespaceId })
      .from(federatedPeer)
      .where(eq(federatedPeer.domain, domain))
      .for('no key update')
      .limit(1);
    if (!peer?.activeNamespaceId) this.unavailable(domain);
    await tx
      .update(identityNamespace)
      .set({ retiredAt })
      .where(
        and(
          eq(identityNamespace.id, peer.activeNamespaceId),
          eq(identityNamespace.domain, domain),
          isNull(identityNamespace.retiredAt),
        ),
      );
    await tx
      .update(federatedPeer)
      .set({ activeNamespaceId: null })
      .where(eq(federatedPeer.domain, domain));
    return { domain, namespaceId: peer.activeNamespaceId };
  }

  private unavailable(domain: string): never {
    throw new BusinessException(
      BusinessCode.FEDERATION_PEER_IDENTITY_LOST,
      `federation peer ${domain} has no active namespace`,
    );
  }
}
