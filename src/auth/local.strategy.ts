import { Strategy } from 'passport-local';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AuthService } from './auth.service.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';
import {
  BruteForceService,
  BAN_DIM_IP,
  BAN_DIM_USER,
  type BanStep,
} from './brute-force.service.js';

export interface LoginAuthInfo {
  /** 0 = success (userId set); 1 = invalid credentials / banned (bannedUntil set when a ban is active);
   *  2 = PASSWORD_NOT_SET — a no-password account; NOT counted toward the brute-force ban. */
  status: number;
  account: string;
  userId?: number;
  bannedUntil?: number;
  /** Set on a successful login whose password is an admin-generated INITIAL password the user must change. */
  mustChangePassword?: boolean;
}

/**
 * Password-login Passport strategy. It owns ONLY the password path's concern: verify credentials via
 * {@link AuthService.validateUser} and orchestrate the dual-dimension (IP + account) brute-force policy
 * against the shared {@link BruteForceService}. The failure/ban storage, sliding-window expiry, cleanup
 * timer, and the admin ban views all live in BruteForceService so every login method (password + OTP)
 * shares one observable, unbannable ban surface.
 *
 * Dual dimension: by IP defends against distributed scanning, by account defends against password
 * brute-force targeting a single account. Combined with the FastifyAdapter trustProxy in main.ts, `req.ip`
 * is the real client IP behind reverse proxies/tunnels (intentionally the ONLY source — `req.raw.socket`
 * behind Caddy is always 127.0.0.1 and would collapse every user into one ban bucket).
 */

interface Dimension {
  dimension: string;
  steps: readonly BanStep[]; // Ascending; the highest matched tier takes effect
}

// IP thresholds are lenient (multiple users may share one public IP under NAT); account thresholds are
// strict (to defend against password brute-force targeting a single account). The tiered steps reuse the
// original progressive tiers (30min / 3h / 24h); only the counting basis changed to "within-window".
const RULES: Record<'ip' | 'user', Dimension> = {
  ip: {
    dimension: BAN_DIM_IP,
    steps: [
      { count: 10, banMs: 30 * 60 * 1000 },
      { count: 20, banMs: 3 * 60 * 60 * 1000 },
      { count: 40, banMs: 24 * 60 * 60 * 1000 },
    ],
  },
  user: {
    dimension: BAN_DIM_USER,
    steps: [
      { count: 5, banMs: 30 * 60 * 1000 },
      { count: 10, banMs: 3 * 60 * 60 * 1000 },
      { count: 20, banMs: 24 * 60 * 60 * 1000 },
    ],
  },
};

@Injectable()
export class LocalStrategy extends PassportStrategy(Strategy) {
  constructor(
    private authService: AuthService,
    private readonly bruteForce: BruteForceService,
  ) {
    super({
      usernameField: 'account',
      passwordField: 'password',
      passReqToCallback: true,
    });
  }

  async validate(
    req: FastifyRequest,
    account: string,
    password: string,
  ): Promise<LoginAuthInfo> {
    // Use ONLY `.ip` (honors the adapter's trustProxy): `req.raw.socket.remoteAddress` is the raw
    // TCP peer, which behind the Caddy reverse proxy is always 127.0.0.1 and would collapse every
    // user into one brute-force ban bucket, so it is intentionally NOT used as a fallback.
    const ip = req.ip ?? 'unknown';

    // If either dimension is still in its ban window → reject outright (also return the remaining ban time
    // for the client to display). The worst (latest) deadline of the two governs.
    const bannedUntil = this.bruteForce.activeBanUntil([
      { dimension: RULES.ip.dimension, value: ip },
      { dimension: RULES.user.dimension, value: account },
    ]);
    if (bannedUntil !== undefined) {
      return { status: 1, account, bannedUntil };
    }

    try {
      const user = await this.authService.validateUser(account, password);
      if (user === undefined) {
        // Failure: record one count in each dimension, take the later of the two newly-triggered deadlines.
        const ipBan = this.bruteForce.registerFailure(
          RULES.ip.dimension,
          ip,
          RULES.ip.steps,
        );
        const userBan = this.bruteForce.registerFailure(
          RULES.user.dimension,
          account,
          RULES.user.steps,
        );
        const until = maxDefined(ipBan, userBan);
        return {
          status: 1,
          account,
          ...(until !== undefined ? { bannedUntil: until } : {}),
        };
      }
      // Success: clear this account's failure log (the window would expire it anyway, but clearing at once
      // is better UX). Do not clear the IP dimension — under NAT, that IP may have other people still being
      // counted. mustChangePassword flags an admin-generated INITIAL password.
      this.bruteForce.clearFailures(RULES.user.dimension, account);
      return {
        status: 0,
        account,
        userId: user.id,
        ...(user.mustChangePassword ? { mustChangePassword: true } : {}),
      };
    } catch (e) {
      // PASSWORD_NOT_SET: a no-password account tried password login. NOT a wrong-password guess (nothing
      // to brute-force), so it MUST NOT be counted toward the ban — surface a distinct status so the client
      // shows "contact the administrator to set the initial password".
      if (
        e instanceof BusinessException &&
        e.bizCode === BusinessCode.PASSWORD_NOT_SET
      ) {
        return { status: 2, account };
      }
      throw e;
    }
  }
}

function maxDefined(a: number | undefined, b: number | undefined) {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}
