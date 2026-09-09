import { HttpStatus, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { and, eq, gt } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { KeyedMutex } from '../common/keyed-mutex.js';
import { DatabaseService } from '../database/database.service.js';
import * as tables from '../database/schema.js';
import {
  type CallSignalPayload,
  parseS2SCallWireFrame,
  type S2SCallFrame,
  toS2SCallWireFrame,
} from '../calls/federated-call-protocol.js';
import { QuotaService } from '../quota/quota.service.js';
import { AccountThreadStateService } from '../account-thread-state/account-thread-state.service.js';
import {
  FederationCallDelivery,
  type OutboundCallFrameParams,
} from './federation-call-delivery.js';
import { FederationPeerHttp } from './federation-peer-http.js';
import { FederationUserDirectoryService } from './federation-user-directory.service.js';

/** Bridges ephemeral call frames between the federation wire and the local call state machine. */
@Injectable()
export class FederationCallBridgeService {
  private readonly inboundLocks = new KeyedMutex();
  private readonly delivery = new FederationCallDelivery();

  constructor(
    private readonly database: DatabaseService,
    private readonly peerHttp: FederationPeerHttp,
    private readonly users: FederationUserDirectoryService,
    private readonly participants: AccountThreadStateService,
    private readonly quota: QuotaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async sendFrame(
    params: OutboundCallFrameParams,
    peerDomain: string,
  ): Promise<void> {
    await this.delivery.send(params, peerDomain, (frame, domain) =>
      this.postFrame(frame, domain),
    );
  }

  async handleFrame(
    body: unknown,
    peerDomain: string,
    namespaceId: number,
    signatureExpiresAtSec: number,
  ): Promise<void> {
    const frame = parseS2SCallWireFrame(body);
    await this.inboundLocks.runExclusive(
      JSON.stringify([peerDomain, namespaceId, frame.callSid]),
      async () => {
        if (frame.op === 'incoming') {
          await this.handleIncoming(
            frame,
            peerDomain,
            namespaceId,
            signatureExpiresAtSec,
          );
        } else {
          await this.eventEmitter.emitAsync('call.frame.inbound', {
            peerDomain,
            namespaceId,
            signatureExpiresAtSec,
            frame,
          });
          if (['declined', 'cancelled', 'missed', 'ended'].includes(frame.op)) {
            this.delivery.stop(peerDomain, frame.callSid);
          }
        }
      },
    );
  }

  private async postFrame(
    params: OutboundCallFrameParams,
    peerDomain: string,
  ): Promise<void> {
    const base = { callSid: params.callSid };
    let frame: S2SCallFrame;
    if (params.op === 'incoming') {
      frame = {
        ...base,
        op: 'incoming',
        callType: params.callType,
        payload: {
          fromAccount: await this.users.requireLocalAccount(
            params.fromLocalUserId,
          ),
          toAccount: params.to.account,
        },
      };
    } else if (params.op === 'signal') {
      const payload: CallSignalPayload = {
        signalId: params.signalId,
        signalType: params.signalType,
        data: params.data,
      };
      frame = { ...base, op: 'signal', payload };
    } else if (params.op === 'ended') {
      frame = {
        ...base,
        op: 'ended',
        payload: { endReason: params.endReason },
      };
    } else if (params.op === 'video-upgraded') {
      frame = { ...base, op: 'video-upgraded' };
    } else {
      frame = { ...base, op: params.op };
    }
    const body = JSON.stringify(toS2SCallWireFrame(frame));
    if (params.signatureExpiresAtSec !== undefined) {
      await this.peerHttp.post('/s2s/v1/call', body, peerDomain, {
        signatureExpiresAtSec: params.signatureExpiresAtSec,
      });
    } else {
      await this.peerHttp.post('/s2s/v1/call', body, peerDomain);
    }
  }

  private async handleIncoming(
    frame: Extract<S2SCallFrame, { op: 'incoming' }>,
    peerDomain: string,
    namespaceId: number,
    signatureExpiresAtSec: number,
  ): Promise<void> {
    const preflight = await this.eventEmitter.emitAsync(
      'call.frame.incoming.preflight',
      { peerDomain, namespaceId, frame },
    );
    if (preflight?.some((handled) => handled === true)) return;

    const terminal = await this.database.db.query.callTombstone.findFirst({
      where: and(
        eq(tables.callTombstone.namespaceId, namespaceId),
        eq(tables.callTombstone.callSid, frame.callSid),
        gt(tables.callTombstone.expiresAt, new Date()),
      ),
      columns: { terminalOp: true },
    });
    if (terminal) {
      throw new BusinessException(
        terminal.terminalOp === 'cancelled'
          ? BusinessCode.CALL_CANCELLED
          : BusinessCode.CALL_TERMINATED,
        terminal.terminalOp === 'cancelled'
          ? 'call was already cancelled'
          : 'call was already terminated',
        HttpStatus.OK,
      );
    }

    await this.quota.peek(peerDomain, 'requests');
    const peerAddress = {
      account: frame.payload.fromAccount,
      domain: peerDomain,
      namespaceId: namespaceId,
    };
    const localUserId = await this.users.findLocalUserId(
      frame.payload.toAccount,
    );
    if (localUserId === null) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        `local user ${frame.payload.toAccount} not found`,
      );
    }
    const threadId = await this.participants.findP2PThreadBetween(
      localUserId,
      peerAddress,
    );
    if (threadId === null) {
      throw new BusinessException(
        BusinessCode.CALL_NOT_ALLOWED,
        'no relationship with caller',
      );
    }
    await this.eventEmitter.emitAsync('call.frame.inbound', {
      localUserId,
      peerDomain,
      namespaceId,
      signatureExpiresAtSec,
      threadId,
      frame,
    });
  }
}
