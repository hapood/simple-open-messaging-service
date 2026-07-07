import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ulid } from 'ulid';
import { Prisma } from '../prisma/generated/client.js';
import { PrismaService } from '../prisma.service.js';
import { loadFederationConfig } from './federation.config.js';

/** An @localpart@domain handle split into its parts. */
export interface ParsedHandle {
  localpart: string;
  domain: string;
}

/** Parse "@alice@aaa.com" → { localpart, domain }. Returns null if not handle-shaped. */
export function parseHandle(h: string): ParsedHandle | null {
  const m = /^@([^@]+)@(.+)$/.exec(h);
  return m ? { localpart: m[1], domain: m[2] } : null;
}

/** The on-the-wire S2S envelope (plain JSON). See docs/federation-protocol.md §4. */
export interface S2SEnvelope {
  type: string;
  durability: 'durable' | 'ephemeral';
  id: string; // origin-assigned ULID; dedup key with origin
  origin: string;
  from: string; // @localpart@domain
  to: string[]; // [@localpart@domain, ...]
  ts: number; // ms since epoch
  thread?: string; // federated thread id (thr_<ulid>@<origin>)
  message?: string; // friend.request note (≤255)
  content?: unknown; // message payload (opaque; future E2EE slot)
}

/**
 * Outbound S2S: builds + persists envelopes to S2SOutbox (durable queue). The S2SOutboxWorker
 * (Phase D) drains + signs + POSTs them with backoff. This service is called by the client friend
 * endpoints (Phase D) for outbound friend ops AND by the InboxHandler to fan out a thread.invite
 * when it materializes an origin-side thread on an inbound friend.approve.
 *
 * Identity model: local users have domain="local" (isForeigner=false); federated peers are foreign
 * User stubs (domain=<peer>, isForeigner=true, unusable random hashPwd). Federation handles always
 * use the REAL config.domain for local users (@<uniqName>@<config.domain>), never "local".
 */
@Injectable()
export class FederationService {
  private readonly config = loadFederationConfig();

  constructor(private readonly prisma: PrismaService) {}

  /** The federated handle of a LOCAL user: @<uniqName>@<our real domain>. */
  localHandle(uniqName: string): string {
    return `@${uniqName}@${this.config.domain}`;
  }

  /** Find a LOCAL user id by localpart (domain="local"). Null if not found / not local. */
  async findLocalUserId(localpart: string): Promise<number | null> {
    const u = await this.prisma.user.findUnique({
      where: { uniqName_domain: { uniqName: localpart, domain: 'local' } },
    });
    return u && !u.isForeigner ? u.id : null;
  }

  /** Look up a local user's id from their full handle (must be @localpart@<our domain>). */
  async findLocalUserIdByHandle(handle: ParsedHandle): Promise<number | null> {
    if (handle.domain !== this.config.domain) return null;
    return this.findLocalUserId(handle.localpart);
  }

  /** Find or create a foreign User stub for @localpart@<peer-domain>. Stubs never authenticate. */
  async findOrCreateForeignStubId(localpart: string, domain: string): Promise<number> {
    const existing = await this.prisma.user.findUnique({
      where: { uniqName_domain: { uniqName: localpart, domain } },
    });
    if (existing) return existing.id;
    const created = await this.prisma.user.create({
      data: {
        uniqName: localpart,
        domain,
        isForeigner: true,
        hashPwd: randomUUID(), // unusable — stubs never log in
        userExtra: { create: { name: localpart, avatar: '', bio: '' } },
        userNotiBox: { create: {} },
      },
    });
    return created.id;
  }

  /** Persist an outbound envelope as a pending S2SOutbox row. Returns the outbox row id. */
  private async enqueue(envelope: S2SEnvelope, recipientDomain: string): Promise<string> {
    const row = await this.prisma.s2SOutbox.create({
      data: {
        id: randomUUID(),
        envelopeId: envelope.id,
        envelopeType: envelope.type,
        origin: envelope.origin,
        threadFederatedId: envelope.thread ?? null,
        recipientDomain,
        payload: envelope as unknown as Prisma.InputJsonValue,
        status: 'pending',
      },
    });
    return row.id;
  }

  /** Load a local user's uniqName (for building the `from` handle). Throws if not a local user. */
  private async localUniqName(userId: number): Promise<string> {
    const u = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!u || u.isForeigner) throw new Error(`user ${userId} is not a local user`);
    return u.uniqName;
  }

  // ─── friend flows ────────────────────────────────────────────────────────────

  /** Enqueue a friend.request from a local user to @localpart@<peer>. */
  async enqueueFriendRequest(fromLocalUserId: number, to: ParsedHandle, message = ''): Promise<string> {
    const fromUniqName = await this.localUniqName(fromLocalUserId);
    return this.enqueue(
      {
        type: 'friend.request',
        durability: 'durable',
        id: ulid(),
        origin: this.config.domain,
        from: this.localHandle(fromUniqName),
        to: [`@${to.localpart}@${to.domain}`],
        ts: Date.now(),
        message: (message ?? '').slice(0, 255),
      },
      to.domain,
    );
  }

  /** Enqueue a friend.approve from a local user (the approver) to @localpart@<peer> (the requester). */
  async enqueueFriendApprove(localApproverId: number, to: ParsedHandle): Promise<string> {
    const fromUniqName = await this.localUniqName(localApproverId);
    return this.enqueue(
      {
        type: 'friend.approve',
        durability: 'durable',
        id: ulid(),
        origin: this.config.domain,
        from: this.localHandle(fromUniqName),
        to: [`@${to.localpart}@${to.domain}`],
        ts: Date.now(),
      },
      to.domain,
    );
  }

  /** Enqueue a friend.delete (unfriend) from a local user to @localpart@<peer>. */
  async enqueueFriendDelete(localUserId: number, to: ParsedHandle): Promise<string> {
    const fromUniqName = await this.localUniqName(localUserId);
    return this.enqueue(
      {
        type: 'friend.delete',
        durability: 'durable',
        id: ulid(),
        origin: this.config.domain,
        from: this.localHandle(fromUniqName),
        to: [`@${to.localpart}@${to.domain}`],
        ts: Date.now(),
      },
      to.domain,
    );
  }

  /**
   * Enqueue a thread.invite (origin → remote participant) carrying the freshly-minted federated thread
   * id, so the remote server creates its local thread reference. Called by the InboxHandler after it
   * materializes the origin-side thread on an inbound friend.approve.
   */
  async enqueueThreadInvite(
    threadFederatedId: string,
    fromLocalUserId: number,
    to: ParsedHandle,
  ): Promise<string> {
    const fromUniqName = await this.localUniqName(fromLocalUserId);
    return this.enqueue(
      {
        type: 'thread.invite',
        durability: 'durable',
        id: ulid(),
        origin: this.config.domain,
        from: this.localHandle(fromUniqName),
        to: [`@${to.localpart}@${to.domain}`],
        ts: Date.now(),
        thread: threadFederatedId,
      },
      to.domain,
    );
  }
}
