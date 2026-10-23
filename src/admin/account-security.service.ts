import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHmac } from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import {
  account,
  admin,
  adminSession,
  adminLoginChallenge,
  webAuthnCredential,
} from '../database/schema.js';
import { PasswordHasher } from '../auth/password-hasher.service.js';
import { SessionTokenService } from '../auth/session-token.service.js';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { jwtConstants } from '../auth/constants.js';
import {
  BruteForceService,
  BAN_DIM_ADMIN_PWD,
  BAN_DIM_ADMIN_2FA,
} from '../auth/brute-force.service.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';
import { AdminAuthService } from './admin-auth.service.js';
import { TwoFactorService } from './two-factor.service.js';
import { WebAuthnService } from './webauthn.service.js';
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';

export type SecurityAction =
  | 'password'
  | 'totp-enable'
  | 'totp-disable'
  | 'backup-regenerate'
  | 'passkey-add'
  | 'passkey-remove';
export interface SecurityProof {
  password: string;
  code?: string;
  backupCode?: string;
  pendingToken?: string;
  assertionResponse?: AuthenticationResponseJSON;
}
type SecurityState = {
  user: typeof account.$inferSelect;
  operator: typeof admin.$inferSelect;
};

/** Self-service security mutations. Account → Admin → session is the lock order.
 * A successful mutation revokes the initiating session, making its signed permits single-use
 * without another challenge table. Every final write rechecks the permit under these locks.
 */
@Injectable()
export class AccountSecurityService {
  constructor(
    private readonly database: DatabaseService,
    private readonly jwt: JwtService,
    private readonly passwords: PasswordHasher,
    private readonly sessions: SessionTokenService,
    private readonly events: EventEmitter2,
    private readonly auth: AdminAuthService,
    private readonly totp: TwoFactorService,
    private readonly passkeys: WebAuthnService,
    private readonly bruteForce: BruteForceService,
  ) {}

  private async locked(
    tx: DatabaseTransaction,
    adminId: number,
    sessionId: number,
  ): Promise<SecurityState> {
    const owner = await tx.query.admin.findFirst({
      where: eq(admin.id, adminId),
      columns: { userId: true },
    });
    if (!owner) throw new UnauthorizedException();
    const [user] = await tx
      .select()
      .from(account)
      .where(eq(account.id, owner.userId))
      .for('no key update');
    const [operator] = await tx
      .select()
      .from(admin)
      .where(eq(admin.id, adminId))
      .for('no key update');
    const [session] = await tx
      .select()
      .from(adminSession)
      .where(
        and(
          eq(adminSession.id, BigInt(sessionId)),
          eq(adminSession.adminId, adminId),
        ),
      )
      .for('no key update');
    const now = Date.now();
    const idle = this.auth.getSessionPolicy().idleMinutes * 60_000;
    if (
      !user ||
      !operator?.enabled ||
      !session ||
      session.revokedAt ||
      session.expiresAt.getTime() <= now ||
      (idle > 0 && session.lastAccessedAt.getTime() + idle <= now)
    )
      throw new UnauthorizedException();
    return { user, operator };
  }

  private async fingerprint(tx: DatabaseTransaction, state: SecurityState) {
    const credentials = await tx
      .select({ id: webAuthnCredential.id })
      .from(webAuthnCredential)
      .where(eq(webAuthnCredential.adminId, state.operator.id))
      .orderBy(webAuthnCredential.id);
    // HMAC hides the stored password hash and encrypted TOTP material from browser tokens.
    return createHmac('sha256', jwtConstants.adminSecret)
      .update(
        JSON.stringify([
          state.user.hashPwd,
          state.user.updatedAt,
          state.operator.twoFactorEnabled,
          state.operator.twoFactorSecretCipher,
          state.operator.twoFactorEnabledAt,
          state.operator.webauthnEnabled,
          credentials,
        ]),
      )
      .digest('base64url');
  }

  private binding(
    adminId: number,
    sessionId: number,
    action: SecurityAction,
    fingerprint: string,
    target?: number,
  ) {
    return JSON.stringify([
      'admin-security',
      adminId,
      sessionId,
      action,
      fingerprint,
      target ?? null,
    ]);
  }

  private checkBan(accountName: string) {
    const until = this.bruteForce.activeBanUntil([
      { dimension: BAN_DIM_ADMIN_PWD, value: accountName },
      { dimension: BAN_DIM_ADMIN_2FA, value: accountName },
    ]);
    if (until !== undefined)
      throw new BusinessException(
        BusinessCode.RATE_LIMITED,
        'too many verification attempts',
        undefined,
        { bannedUntil: until },
      );
  }

  private fail(accountName: string, factor: boolean): never {
    const until = this.bruteForce.registerFailure(
      factor ? BAN_DIM_ADMIN_2FA : BAN_DIM_ADMIN_PWD,
      accountName,
      [{ count: 5, banMs: 30 * 60_000 }],
    );
    throw new BusinessException(
      until
        ? BusinessCode.RATE_LIMITED
        : factor
          ? BusinessCode.TWO_FACTOR_INVALID
          : BusinessCode.INVALID_CREDENTIALS,
      until ? 'too many verification attempts' : 'verification failed',
      undefined,
      until ? { bannedUntil: until } : undefined,
    );
  }

  private async password(state: SecurityState, password: string) {
    this.checkBan(state.user.account);
    if (
      !state.user.hashPwd ||
      !(await this.passwords.verify(state.user.hashPwd, password))
    )
      this.fail(state.user.account, false);
  }

  private async authorize(
    tx: DatabaseTransaction,
    state: SecurityState,
    sessionId: number,
    action: SecurityAction,
    proof: SecurityProof,
    target?: number,
  ) {
    await this.password(state, proof.password);
    const operator = state.operator;
    if (!operator.twoFactorEnabled && !operator.webauthnEnabled) return;
    let valid = false;
    if (
      operator.webauthnEnabled &&
      proof.pendingToken &&
      proof.assertionResponse
    ) {
      const binding = this.binding(
        operator.id,
        sessionId,
        action,
        await this.fingerprint(tx, state),
        target,
      );
      valid = (
        await this.passkeys.verifyAssertion(
          operator.id,
          proof.pendingToken,
          proof.assertionResponse,
          binding,
          tx,
        )
      ).ok;
    } else if (operator.twoFactorEnabled && proof.backupCode) {
      valid = await this.totp.consumeBackupCode(
        operator.id,
        proof.backupCode,
        tx,
      );
    } else if (
      operator.twoFactorEnabled &&
      operator.twoFactorSecretCipher &&
      proof.code
    ) {
      const check = this.totp.verifyTotp(
        this.totp.decryptSecret(operator.twoFactorSecretCipher),
        proof.code,
        operator.twoFactorLastUsedCounter,
      );
      if (check.ok && check.counter !== undefined) {
        await tx
          .update(admin)
          .set({ twoFactorLastUsedCounter: check.counter })
          .where(eq(admin.id, operator.id));
        valid = true;
      }
    }
    if (!valid) this.fail(state.user.account, true);
  }

  async beginAssertion(
    adminId: number,
    sessionId: number,
    action: SecurityAction,
    password: string,
    target?: number,
  ) {
    return this.database.db.transaction(async (tx) => {
      const state = await this.locked(tx, adminId, sessionId);
      await this.password(state, password);
      if (!state.operator.webauthnEnabled)
        throw new BadRequestException('no passkey enrolled');
      return this.passkeys.beginAssertion(
        adminId,
        this.binding(
          adminId,
          sessionId,
          action,
          await this.fingerprint(tx, state),
          target,
        ),
      );
    });
  }

  private permit(data: object) {
    return this.jwt.sign(
      { scope: 'admin-security-enrollment', ...data },
      { secret: jwtConstants.adminSecret, expiresIn: '5m' },
    );
  }

  async beginEnrollment(
    adminId: number,
    sessionId: number,
    action: 'totp-enable' | 'passkey-add',
    proof: SecurityProof,
    nickname?: string,
  ) {
    return this.database.db.transaction(async (tx) => {
      const state = await this.locked(tx, adminId, sessionId);
      await this.authorize(tx, state, sessionId, action, proof);
      if (action === 'totp-enable' && state.operator.twoFactorEnabled)
        throw new BadRequestException('authenticator already enabled');
      const bundle =
        action === 'totp-enable'
          ? this.totp.beginSetup(
              adminId,
              state.user.account,
              state.user.account,
            )
          : await this.passkeys.beginRegistration(
              adminId,
              state.user.account,
              state.user.account,
              nickname,
            );
      return {
        ...bundle,
        pendingToken: this.permit({
          adminId,
          sessionId,
          action,
          fingerprint: await this.fingerprint(tx, state),
          inner: bundle.pendingToken,
        }),
      };
    });
  }

  private async revoke(
    tx: DatabaseTransaction,
    state: SecurityState,
    reason: string,
  ) {
    const now = new Date();
    // Advance the existing account timestamp to invalidate password proofs captured
    // before a security change, including a no-factor login already in flight.
    await tx
      .update(account)
      .set({
        updatedAt: sql`greatest(clock_timestamp(), ${account.updatedAt} + interval '1 millisecond')`,
      })
      .where(eq(account.id, state.user.id));
    await tx
      .update(adminSession)
      .set({ revokedAt: now, revokeReason: reason })
      .where(
        and(
          eq(adminSession.adminId, state.operator.id),
          isNull(adminSession.revokedAt),
        ),
      );
    await tx
      .delete(adminLoginChallenge)
      .where(eq(adminLoginChallenge.adminId, state.operator.id));
    return this.sessions.revokeAllInTransaction(tx, state.user.id, reason);
  }

  private async finish(userId: number, hashes: string[], reason: string) {
    await this.sessions.clearRevokedCache(hashes);
    this.events.emit('auth.sessions-invalidated', { userId, reason });
  }

  async completeEnrollment(
    adminId: number,
    sessionId: number,
    action: 'totp-enable' | 'passkey-add',
    token: string,
    code?: string,
    registration?: RegistrationResponseJSON,
  ) {
    let permit: {
      scope: string;
      adminId: number;
      sessionId: number;
      action: string;
      fingerprint: string;
      inner: string;
    };
    try {
      permit = this.jwt.verify(token, { secret: jwtConstants.adminSecret });
    } catch {
      throw new UnauthorizedException('enrollment expired');
    }
    const result = await this.database.db.transaction(async (tx) => {
      const state = await this.locked(tx, adminId, sessionId);
      // Lock contention must not extend the permit's deadline.
      try {
        permit = this.jwt.verify(token, { secret: jwtConstants.adminSecret });
      } catch {
        throw new UnauthorizedException('enrollment expired');
      }
      this.checkBan(state.user.account);
      if (
        permit.scope !== 'admin-security-enrollment' ||
        permit.adminId !== adminId ||
        permit.sessionId !== sessionId ||
        permit.action !== action ||
        permit.fingerprint !== (await this.fingerprint(tx, state))
      )
        throw new UnauthorizedException('enrollment expired');
      let value: unknown;
      if (action === 'totp-enable') {
        const pending = this.totp.verifyPending(permit.inner);
        if (
          !pending ||
          pending.adminId !== adminId ||
          state.operator.twoFactorEnabled
        )
          throw new BadRequestException('invalid enrollment');
        const check = this.totp.verifyTotp(pending.secret, code ?? '', null);
        if (!check.ok) this.fail(state.user.account, true);
        value = await this.totp.enableWithBackupCodes(
          adminId,
          pending.secret,
          tx,
          check.counter,
        );
      } else {
        if (!registration)
          throw new BadRequestException('missing registration response');
        value = await this.passkeys.completeRegistration(
          adminId,
          permit.inner,
          registration,
          tx,
        );
      }
      return {
        value,
        userId: state.user.id,
        hashes: await this.revoke(tx, state, 'security_changed'),
      };
    });
    await this.finish(result.userId, result.hashes, 'security_changed');
    return result.value;
  }

  async mutate(
    adminId: number,
    sessionId: number,
    action: Exclude<SecurityAction, 'totp-enable' | 'passkey-add'>,
    proof: SecurityProof,
    newPassword?: string,
    target?: number,
  ) {
    const hash =
      action === 'password' && newPassword
        ? await this.passwords.hash(newPassword)
        : undefined;
    const result = await this.database.db.transaction(async (tx) => {
      const state = await this.locked(tx, adminId, sessionId);
      await this.authorize(tx, state, sessionId, action, proof, target);
      let value: unknown = { ok: true };
      if (action === 'password') {
        if (!hash) throw new BadRequestException('new password required');
        await tx
          .update(account)
          .set({
            hashPwd: hash,
            mustChangePassword: false,
            updatedAt: new Date(),
          })
          .where(eq(account.id, state.user.id));
      } else if (action === 'totp-disable') {
        if (!state.operator.twoFactorEnabled)
          throw new BadRequestException('authenticator not enabled');
        await this.totp.disable(adminId, tx);
      } else if (action === 'backup-regenerate') {
        if (!state.operator.twoFactorEnabled)
          throw new BadRequestException('authenticator not enabled');
        value = await this.totp.regenerateBackupCodes(adminId, tx);
      } else {
        if (!target) throw new BadRequestException('credential required');
        value = await this.passkeys.removeCredential(adminId, target, tx);
      }
      return {
        value,
        userId: state.user.id,
        hashes: await this.revoke(
          tx,
          state,
          action === 'password' ? 'password_change' : 'security_changed',
        ),
      };
    });
    await this.finish(
      result.userId,
      result.hashes,
      action === 'password' ? 'password_change' : 'security_changed',
    );
    return result.value;
  }

  async current(adminId: number, sessionId: number, ip: string) {
    const session = await this.database.db.query.adminSession.findFirst({
      where: and(
        eq(adminSession.id, BigInt(sessionId)),
        eq(adminSession.adminId, adminId),
        isNull(adminSession.revokedAt),
        gt(adminSession.expiresAt, new Date()),
      ),
      columns: { createdAt: true, userAgent: true },
    });
    if (!session) throw new UnauthorizedException();
    return { ...(await this.auth.me(adminId)), ...session, currentIp: ip };
  }
}
