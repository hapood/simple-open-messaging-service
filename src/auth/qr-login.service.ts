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
/** The client kind a QR-issued session is minted for: 'web' (browser) or 'desktop' (Tauri) — never 'app'
 *  (the long-term app session comes only from the OTP flow). */
type QrClient = 'web' | 'desktop';

interface QrState {
  status: QrStatus;
  client: QrClient;
  /** Trust chosen at create (desktop only — a browser QR can never be trusted). A trusted desktop stores
   *  its token in OS keyring and receives a permanent (revocation-only) session. */
  trusted: boolean;
  /** Set at confirm — the scanner's account becomes the desktop session's owner. */
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
 * QR-scan login → a `web`/`desktop` session for PC/Mac/browser, confirmed by an already-logged-in phone
 * (which itself logged in via the OTP flow). A TRUSTED desktop (opt-in — it stores the token in OS
 * keyring) gets a permanent, revocation-only session; everything else (browser, or an untrusted desktop)
 * gets a 14-day sliding session. Ephemeral by design: the pending state lives in the in-process KV
 * (seconds-to-minutes lifetime), NOT a Prisma table — the issued session is the durable artifact (its
 * SessionToken row records device/ip/client/trusted for audit).
 *
 * Two-step (WeChat/DingTalk-style): scan → 'scanned' (desktop shows "confirm on phone") → confirm →
 * 'confirmed' (the desktop's next poll claims + issues). Issue-once is enforced by an atomic `del` claim:
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
    await this.kv.setex(this.key(token), this.remaining(state), JSON.stringify(state));
  }

  /** Desktop/web begins a QR login: mint a 256-bit token + pending state. The desktop renders the token
   *  as a QR and polls for its status. `trusted` is honored only for `desktop` (a browser can't be
   *  trusted) — a trusted desktop receives a permanent session whose token it keeps in OS keyring. */
  async create(client: QrClient, trusted = false): Promise<QrCreateResult> {
    const qrToken = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + QR_TTL_MS;
    await this.write(qrToken, {
      status: 'pending',
      client,
      trusted: client === 'desktop' && trusted,
      expiresAt,
    });
    return { qrToken, expiresAt };
  }

  /** Desktop/web polls its QR token. Returns the status; when 'confirmed' it CLAIMS the token (atomic del)
   *  and issues a session for the scanner's account (permanent if the desktop opted into trust, else a
   *  14-day sliding session). The claim guarantees the session is issued exactly once even under
   *  concurrent polls. */
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

    const sessionToken = await this.sessionTokens.issue(state.userId!, state.client, {
      device: opts.device,
      userAgent: opts.userAgent,
      ip: opts.ip,
      persistent: true,
      trusted: state.trusted,
    });
    return { status: 'confirmed', sessionToken };
  }

  /** The phone (already logged in) scans the QR → marks it 'scanned'. The desktop's next poll shows
   *  "confirm on phone". Only a pending token can be scanned. */
  async scan(qrToken: string, scannerUserId: number): Promise<void> {
    const state = await this.read(qrToken);
    if (!state) throw new BusinessException(BusinessCode.QR_EXPIRED, 'sign-in code expired');
    if (state.status !== 'pending') {
      throw new BusinessException(BusinessCode.QR_INVALID, 'sign-in code is not pending');
    }
    await this.write(qrToken, { ...state, status: 'scanned', scannedBy: scannerUserId });
  }

  /** The phone confirms → marks the token 'confirmed' with the scanner's userId (the desktop session will
   *  belong to THIS account). Only a scanned token can be confirmed — the two-step gate. */
  async confirm(qrToken: string, scannerUserId: number): Promise<void> {
    const state = await this.read(qrToken);
    if (!state) throw new BusinessException(BusinessCode.QR_EXPIRED, 'sign-in code expired');
    if (state.status !== 'scanned') {
      throw new BusinessException(BusinessCode.QR_INVALID, 'sign-in code must be scanned first');
    }
    await this.write(qrToken, { ...state, status: 'confirmed', userId: scannerUserId });
  }
}
