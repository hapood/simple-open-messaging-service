import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { KvStoreService } from '../kv-store/kv-store.service.js';
import { SessionTokenService } from './session-token.service.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';

const QR_PREFIX = 'qr:';
/** Total lifetime of a QR-login flow (pending → scanned → confirmed → issued). Bounded so an abandoned QR
 *  can't be redeemed long after the desktop walked away. */
const QR_TTL_MS = 3 * 60 * 1000;

type QrStatus = 'pending' | 'scanned' | 'confirmed';
/** The client kind is retained as device-list metadata and does not affect lifetime. */
type QrClient = 'app' | 'web' | 'desktop';

interface QrState {
  status: QrStatus;
  client: QrClient;
  /** Set at confirm — the scanner's account becomes the QR-displaying client's session owner. */
  userId?: number;
  /** The scanner's userId at scan (audit). */
  scannedBy?: number;
  /** Fixed epoch-ms deadline preserved across rewrites (so scan/confirm don't slide the window). */
  expiresAt: number;
}

export interface QrCreateResult {
  qrToken: string;
  expiresAt: number;
}

export type QrPollStatus = 'pending' | 'scanned' | 'confirmed' | 'expired';
export interface QrPollResult {
  status: QrPollStatus;
  sessionToken?: string;
}

/**
 * QR-scan login → a session confirmed by an already-logged-in phone. Ephemeral by design: the
 * pending state lives in the in-process KV (seconds-to-minutes lifetime), NOT a database table — the issued
 * session is the durable artifact (its SessionToken row records device/ip/client for audit).
 *
 * Two-step (WeChat/DingTalk-style): scan → 'scanned' (QR-displaying client shows "confirm on phone") →
 * confirm → 'confirmed' (its next poll claims + issues). Issue-once is enforced by an atomic `del` claim:
 * `del` returns 1 iff THIS caller removed the key, so only the first confirming poll mints a session.
 *
 * The `qrToken` is a 256-bit secret carried in the POST body — never in the URL (consistent with the
 * codebase's no-URL-borne-token rule), so it can't leak via logs/Referer.
 */
@Injectable()
export class QrLoginService {
  constructor(
    private readonly kv: KvStoreService,
    private readonly sessionTokens: SessionTokenService,
  ) {}

  private key(token: string): string {
    return `${QR_PREFIX}${token}`;
  }

  /** Remaining TTL (seconds) for a state, preserving its fixed deadline across rewrites. */
  private remaining(state: QrState): number {
    return Math.max(1, Math.ceil((state.expiresAt - Date.now()) / 1000));
  }

  private async read(token: string): Promise<QrState | null> {
    const raw = await this.kv.get(this.key(token));
    return raw ? (JSON.parse(raw) as QrState) : null;
  }

  private async write(token: string, state: QrState): Promise<void> {
    await this.kv.setex(
      this.key(token),
      this.remaining(state),
      JSON.stringify(state),
    );
  }

  /** A client begins a QR login: mint a 256-bit token + pending state. */
  async create(client: QrClient): Promise<QrCreateResult> {
    const qrToken = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + QR_TTL_MS;
    await this.write(qrToken, {
      status: 'pending',
      client,
      expiresAt,
    });
    return { qrToken, expiresAt };
  }

  /** The QR-displaying client polls its token. A confirmed poll atomically claims it and issues once. */
  async poll(
    qrToken: string,
    opts: { device?: string; userAgent?: string; ip?: string },
  ): Promise<QrPollResult> {
    const state = await this.read(qrToken);
    if (!state) return { status: 'expired' };
    if (state.status !== 'confirmed') return { status: state.status };

    // Confirmed → claim atomically BEFORE issuing. `del` returns 1 iff this caller removed the key, so
    // only the first confirming poll wins; a concurrent second poll gets 0 and does not issue. (A single
    // desktop polls sequentially, so the race is near-impossible in practice — the guard is defense.)
    const claimed = await this.kv.del(this.key(qrToken));
    if (claimed === 0) return { status: 'expired' };

    const sessionToken = await this.sessionTokens.issue(
      state.userId!,
      state.client,
      {
        device: opts.device,
        userAgent: opts.userAgent,
        ip: opts.ip,
      },
    );
    return { status: 'confirmed', sessionToken };
  }

  /** The phone (already logged in) scans the QR → marks it 'scanned'. The desktop's next poll shows
   *  "confirm on phone". Only a pending token can be scanned. */
  async scan(qrToken: string, scannerUserId: number): Promise<void> {
    const state = await this.read(qrToken);
    if (!state)
      throw new BusinessException(
        BusinessCode.QR_EXPIRED,
        'sign-in code expired',
      );
    if (state.status !== 'pending') {
      throw new BusinessException(
        BusinessCode.QR_INVALID,
        'sign-in code is not pending',
      );
    }
    await this.write(qrToken, {
      ...state,
      status: 'scanned',
      scannedBy: scannerUserId,
    });
  }

  /** The phone confirms → marks the token 'confirmed' with the scanner's userId (the desktop session will
   *  belong to THIS account). Only a scanned token can be confirmed — the two-step gate. */
  async confirm(qrToken: string, scannerUserId: number): Promise<void> {
    const state = await this.read(qrToken);
    if (!state)
      throw new BusinessException(
        BusinessCode.QR_EXPIRED,
        'sign-in code expired',
      );
    if (state.status !== 'scanned') {
      throw new BusinessException(
        BusinessCode.QR_INVALID,
        'sign-in code must be scanned first',
      );
    }
    // The account that confirms must be the same account that scanned. Otherwise a second logged-in
    // device that obtained the token could replace the intended scanner and mint its own desktop session.
    if (state.scannedBy !== scannerUserId) {
      throw new BusinessException(
        BusinessCode.QR_INVALID,
        'sign-in code must be confirmed by the scanner',
      );
    }
    await this.write(qrToken, {
      ...state,
      status: 'confirmed',
      userId: scannerUserId,
    });
  }
}
