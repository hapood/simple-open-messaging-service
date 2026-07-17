import { Injectable, HttpStatus } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { PrismaService } from '../prisma.service.js';
import { jwtConstants } from '../auth/constants.js';
import { WEBAUTHN_CONFIG } from './webauthn.config.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';

/** TTL of a registration pending token — the window to complete the platform prompt + confirm. */
const REG_PENDING_TTL = '10m' as const;
/** TTL of an assertion pending token — short; it carries the challenge bound to one login attempt. */
const ASSERT_PENDING_TTL = '5m' as const;

/** A saved credential as shown in the security page list (never exposes publicKey / counter). */
export interface WebAuthnCredentialView {
  id: string;
  nickname: string | null;
  deviceType: string | null;
  backed: boolean;
  transports: string[] | null;
  createdAt: Date;
  lastUsedAt: Date | null;
}

/** Verified pending-registration token payload. */
interface RegPendingPayload {
  sub: number;
  scope: 'webauthn-reg-pending';
  challenge: string;
  nickname?: string;
}
/** Verified pending-assertion token payload. */
interface AssertPendingPayload {
  sub: number;
  scope: 'webauthn-assert-pending';
  challenge: string;
}

/**
 * Admin WebAuthn (passkey) core: registration + assertion crypto over the WebAuthnCredential store. Pure
 * crypto + storage — has NO dependency on AdminAuthService (the orchestrator owns login/issuance +
 * brute-force), so there is no circular DI (ESM + emitDecoratorMetadata would TDZ on a cycle, exactly the
 * reason TwoFactorService is shaped the same way).
 *
 * Credential IDs + public keys are PUBLIC authenticator values, so they are stored in plaintext (no
 * AES-GCM, no key file — unlike the TOTP secret). The signature counter is persisted per-credential and
 * advanced via a compare-and-swap updateMany so multi-instance concurrent verifies stay clone-safe.
 */
@Injectable()
export class WebAuthnService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  // ── registration (enrollment) ────────────────────────────────────────────────

  /** Mint registration options + a signed pending token carrying the challenge (stateless until finish). */
  async beginRegistration(
    adminId: number,
    account: string,
    displayName: string,
    nickname?: string,
  ): Promise<{ options: PublicKeyCredentialCreationOptionsJSON; pendingToken: string }> {
    const existing = await this.prisma.webAuthnCredential.findMany({
      where: { adminId },
      select: { credentialId: true, transports: true },
    });
    const options = await generateRegistrationOptions({
      rpName: 'SOMS Admin',
      rpID: WEBAUTHN_CONFIG.rpId,
      // userID is the stable per-RP handle the authenticator keys the credential to; adminId is stable +
      // unique. It is NOT displayed (the authenticator never shows it) and is scoped to this RP.
      userID: Buffer.from(String(adminId)),
      userName: account,
      userDisplayName: displayName,
      attestationType: 'none',
      excludeCredentials: existing.map((c) => ({
        id: c.credentialId,
        type: 'public-key',
        transports: this.parseTransports(c.transports),
      })),
      authenticatorSelection: {
        // 'preferred' lets platform/roaming/hybrid all enroll; harmless under allowCredentials now and
        // smooths a future passwordless (discoverable) primary step.
        residentKey: 'preferred',
        userVerification: 'required',
      },
    });
    const pendingToken = this.jwtService.sign(
      { sub: adminId, scope: 'webauthn-reg-pending', challenge: options.challenge, nickname },
      { secret: jwtConstants.adminSecret, expiresIn: REG_PENDING_TTL },
    );
    return { options, pendingToken };
  }

  /** Verify the browser's registration response, persist the credential, and flip webauthnEnabled on the
   *  first credential. Returns the new credential's display view. Throws on any verification failure. */
  async completeRegistration(
    adminId: number,
    pendingToken: string,
    response: RegistrationResponseJSON,
  ): Promise<{ id: string; nickname: string | null; deviceType: string | null; backed: boolean }> {
    const pending = this.verifyRegPending(pendingToken);
    if (!pending || pending.sub !== adminId) {
      throw new BusinessException(
        BusinessCode.WEBAUTHN_CHALLENGE_EXPIRED,
        'setup session expired; please start again',
        HttpStatus.OK,
      );
    }
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: pending.challenge,
        expectedOrigin: WEBAUTHN_CONFIG.allowedOrigins,
        expectedRPID: [WEBAUTHN_CONFIG.rpId],
        requireUserVerification: true,
      });
    } catch {
      throw new BusinessException(
        BusinessCode.WEBAUTHN_VERIFICATION_FAILED,
        'passkey verification failed',
        HttpStatus.OK,
      );
    }
    if (!verification.verified || !verification.registrationInfo) {
      throw new BusinessException(
        BusinessCode.WEBAUTHN_VERIFICATION_FAILED,
        'passkey verification failed',
        HttpStatus.OK,
      );
    }
    const info = verification.registrationInfo;
    const transports = (response.response.transports ?? []) as string[];
    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.webAuthnCredential.create({
        data: {
          adminId,
          credentialId: info.credential.id,
          publicKey: Buffer.from(info.credential.publicKey),
          counter: info.credential.counter,
          transports: JSON.stringify(transports),
          deviceType: info.credentialDeviceType,
          backed: info.credentialBackedUp,
          nickname: pending.nickname ?? null,
        },
      });
      // Flip the hint on the FIRST credential only (idempotent: only if currently false).
      await tx.admin.updateMany({ where: { id: adminId, webauthnEnabled: false }, data: { webauthnEnabled: true } });
      return row;
    });
    return { id: created.id.toString(), nickname: created.nickname, deviceType: created.deviceType, backed: created.backed };
  }

  // ── assertion (login) ─────────────────────────────────────────────────────────

  /** Mint assertion options for an admin's enrolled credentials + a signed pending token carrying the
   *  challenge. Re-counts credentials first (guards a stale webauthnEnabled=true hint). */
  async beginAssertion(
    adminId: number,
  ): Promise<{ options: PublicKeyCredentialRequestOptionsJSON; pendingToken: string }> {
    const creds = await this.prisma.webAuthnCredential.findMany({
      where: { adminId },
      select: { credentialId: true, transports: true },
    });
    if (creds.length === 0) {
      throw new BusinessException(
        BusinessCode.TWO_FACTOR_NOT_ENABLED,
        'no passkey is enrolled for this account',
        HttpStatus.OK,
      );
    }
    const options = await generateAuthenticationOptions({
      rpID: WEBAUTHN_CONFIG.rpId,
      allowCredentials: creds.map((c) => ({
        id: c.credentialId,
        type: 'public-key',
        transports: this.parseTransports(c.transports),
      })),
      userVerification: 'required',
    });
    const pendingToken = this.jwtService.sign(
      { sub: adminId, scope: 'webauthn-assert-pending', challenge: options.challenge },
      { secret: jwtConstants.adminSecret, expiresIn: ASSERT_PENDING_TTL },
    );
    return { options, pendingToken };
  }

  /** Verify a browser assertion response. On success advances the stored counter via a compare-and-swap
   *  updateMany (clone-safe across concurrent verifies). Returns {ok:false} on any mismatch — the caller
   *  applies brute-force. Counter=0 authenticators are tolerated by the library (no advance). */
  async verifyAssertion(
    adminId: number,
    pendingToken: string,
    response: AuthenticationResponseJSON,
  ): Promise<{ ok: boolean }> {
    const pending = this.verifyAssertPending(pendingToken);
    if (!pending || pending.sub !== adminId) return { ok: false };
    // The assertion names which credential was used; bind it to THIS admin (a credential enrolled by
    // another admin can never authenticate this one).
    const row = await this.prisma.webAuthnCredential.findUnique({
      where: { credentialId: response.id },
      select: { id: true, adminId: true, publicKey: true, counter: true },
    });
    if (!row || row.adminId !== adminId) return { ok: false };
    let newCounter: number | undefined;
    try {
      const verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: pending.challenge,
        expectedOrigin: WEBAUTHN_CONFIG.allowedOrigins,
        expectedRPID: [WEBAUTHN_CONFIG.rpId],
        credential: { id: response.id, publicKey: row.publicKey, counter: row.counter },
        requireUserVerification: true,
      });
      if (!verification.verified) return { ok: false };
      newCounter = verification.authenticationInfo.newCounter;
    } catch {
      // Includes the counter-regression clone signal: (new>0||stored>0) && new<=stored throws here.
      return { ok: false };
    }
    // Compare-and-swap advance: only if the stored counter is still exactly what we read. A concurrent
    // verify that already advanced it leaves count=0 (harmless — the row already holds a ≥ counter). The
    // library guarantees newCounter > row.counter or both 0 by this point, so we never decrease.
    const now = new Date();
    const swapped = await this.prisma.webAuthnCredential.updateMany({
      where: { id: row.id, counter: row.counter },
      data: { counter: newCounter, lastUsedAt: now },
    });
    if (swapped.count === 0) {
      // Lost the CAS — another verify advanced the counter. Still record last-use.
      await this.prisma.webAuthnCredential.update({ where: { id: row.id }, data: { lastUsedAt: now } }).catch(() => {});
    }
    return { ok: true };
  }

  // ── credential management ──────────────────────────────────────────────────────

  /** List an admin's credentials (never publicKey / counter). */
  async listCredentials(adminId: number): Promise<WebAuthnCredentialView[]> {
    const rows = await this.prisma.webAuthnCredential.findMany({
      where: { adminId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, nickname: true, deviceType: true, backed: true, transports: true, createdAt: true, lastUsedAt: true },
    });
    return rows.map((r) => ({
      id: r.id.toString(),
      nickname: r.nickname,
      deviceType: r.deviceType,
      backed: r.backed,
      transports: this.parseTransports(r.transports),
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt,
    }));
  }

  /** Rename a credential. Refused (NOT_FOUND) if it belongs to another admin. */
  async renameCredential(adminId: number, rowId: bigint, nickname: string): Promise<void> {
    const r = await this.prisma.webAuthnCredential.updateMany({
      where: { id: rowId, adminId },
      data: { nickname },
    });
    if (r.count === 0) {
      throw new BusinessException(BusinessCode.NOT_FOUND, 'credential not found', HttpStatus.OK);
    }
  }

  /** Delete a credential. Flips webauthnEnabled off when the last one is removed, AND bumps tokenVersion
   *  on every removal (a 2FA-config change) so every outstanding session is invalidated and the admin must
   *  re-authenticate — surfacing the change at next login (the Google/GitHub posture). Returns the
   *  remaining count. Throws NOT_FOUND if the credential belongs to another admin. */
  async removeCredential(adminId: number, rowId: bigint): Promise<{ remaining: number }> {
    const deleted = await this.prisma.webAuthnCredential.deleteMany({ where: { id: rowId, adminId } });
    if (deleted.count === 0) {
      throw new BusinessException(BusinessCode.NOT_FOUND, 'credential not found', HttpStatus.OK);
    }
    const remaining = await this.prisma.webAuthnCredential.count({ where: { adminId } });
    await this.prisma.$transaction(async (tx) => {
      if (remaining === 0) {
        await tx.admin.updateMany({
          where: { id: adminId, webauthnEnabled: true },
          data: { webauthnEnabled: false },
        });
      }
      await tx.admin.update({ where: { id: adminId }, data: { tokenVersion: { increment: 1 } } });
    });
    return { remaining };
  }

  /** Count an admin's credentials (for the status card + login branching sanity). */
  async countCredentials(adminId: number): Promise<number> {
    return this.prisma.webAuthnCredential.count({ where: { adminId } });
  }

  // ── pending-token helpers (signed with the admin secret, scope-isolated) ─────────

  private verifyRegPending(token: string): RegPendingPayload | null {
    try {
      const payload = this.jwtService.verify<RegPendingPayload>(token, { secret: jwtConstants.adminSecret });
      if (payload.scope !== 'webauthn-reg-pending' || typeof payload.sub !== 'number' || !payload.challenge) {
        return null;
      }
      return payload;
    } catch {
      return null;
    }
  }

  private verifyAssertPending(token: string): AssertPendingPayload | null {
    try {
      const payload = this.jwtService.verify<AssertPendingPayload>(token, { secret: jwtConstants.adminSecret });
      if (payload.scope !== 'webauthn-assert-pending' || typeof payload.sub !== 'number' || !payload.challenge) {
        return null;
      }
      return payload;
    } catch {
      return null;
    }
  }

  private parseTransports(stored: string | null): AuthenticatorTransportFuture[] {
    if (!stored) return [];
    try {
      const v = JSON.parse(stored);
      return Array.isArray(v) ? (v as AuthenticatorTransportFuture[]) : [];
    } catch {
      return [];
    }
  }
}
