import { Injectable } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import {
  admin,
  adminSession,
  loginCode,
  pushToken,
  sessionToken,
  account as user,
  webAuthnCredential,
} from '../database/schema.js';

/** A row with the two fields resolve() needs to look up a label. */
export type TargetLabelRow = {
  targetType: string | null;
  targetId: string | null;
};

/**
 * Resolves AdminActionLog target ids into human-friendly account-name labels, shared by the audit log
 * (POST /admin/audit) and the dashboard's recent-actions strip (POST /admin/dashboard) so the target
 * column reads "user: alice" instead of "user: 7".
 *
 * Bucketed by targetType with ONE findMany per type (an IN-list) so N rows cost at most ~7 bounded
 * queries, never N+1. Targets that are already readable (peer / quota-node = domain) or absent are
 * skipped — the caller falls back to the raw targetId. Soft-deleted rows ARE resolved: the referenced
 * user/admin keeps its (immutable) account name forever, which is exactly what an auditor needs, so
 * there is deliberately NO isDeleted filter. admin_session / webauthn_credential ids are BigInt; the
 * rest are Int — each lands in the right IN-list. A non-numeric targetId (or an unknown type) is
 * ignored, never thrown. Returns a Map keyed `${targetType}:${targetId}` → label.
 */
@Injectable()
export class AuditTargetLabelService {
  constructor(private readonly database: DatabaseService) {}

  async resolve(rows: TargetLabelRow[]): Promise<Map<string, string>> {
    const labelByKey = new Map<string, string>();
    const put = (
      type: string,
      id: string | number | bigint,
      label: string,
    ): void => {
      labelByKey.set(`${type}:${id}`, label);
    };

    const bigBuckets = {
      admin_session: new Set<bigint>(),
    };
    const intBuckets = {
      user: new Set<number>(),
      admin: new Set<number>(),
      user_session: new Set<number>(),
      login_code: new Set<number>(),
      push_token: new Set<number>(),
      webauthn_credential: new Set<number>(),
    };
    for (const r of rows) {
      const t = r.targetType;
      const id = r.targetId;
      if (!t || !id || !/^\d+$/.test(id)) continue;
      if (t in bigBuckets)
        bigBuckets[t as keyof typeof bigBuckets].add(BigInt(id));
      else if (t in intBuckets)
        intBuckets[t as keyof typeof intBuckets].add(Number(id));
    }

    const [
      users,
      admins,
      sessions,
      adminSessions,
      loginCodes,
      pushTokens,
      webauthns,
    ] = await Promise.all([
      intBuckets.user.size
        ? this.database.db
            .select({ id: user.id, account: user.account })
            .from(user)
            .where(inArray(user.id, [...intBuckets.user]))
        : [],
      intBuckets.admin.size
        ? this.database.db
            .select({ id: admin.id, account: user.account })
            .from(admin)
            .innerJoin(user, eq(user.id, admin.userId))
            .where(inArray(admin.id, [...intBuckets.admin]))
        : [],
      intBuckets.user_session.size
        ? this.database.db
            .select({ id: sessionToken.id, account: user.account })
            .from(sessionToken)
            .innerJoin(user, eq(user.id, sessionToken.userId))
            .where(inArray(sessionToken.id, [...intBuckets.user_session]))
        : [],
      bigBuckets.admin_session.size
        ? this.database.db
            .select({ id: adminSession.id, account: user.account })
            .from(adminSession)
            .innerJoin(admin, eq(admin.id, adminSession.adminId))
            .innerJoin(user, eq(user.id, admin.userId))
            .where(inArray(adminSession.id, [...bigBuckets.admin_session]))
        : [],
      intBuckets.login_code.size
        ? this.database.db
            .select({ id: loginCode.id, account: user.account })
            .from(loginCode)
            .innerJoin(user, eq(user.id, loginCode.userId))
            .where(inArray(loginCode.id, [...intBuckets.login_code]))
        : [],
      intBuckets.push_token.size
        ? this.database.db
            .select({ id: pushToken.id, account: user.account })
            .from(pushToken)
            .innerJoin(user, eq(user.id, pushToken.userId))
            .where(inArray(pushToken.id, [...intBuckets.push_token]))
        : [],
      intBuckets.webauthn_credential.size
        ? this.database.db
            .select({ id: webAuthnCredential.id, account: user.account })
            .from(webAuthnCredential)
            .innerJoin(admin, eq(admin.id, webAuthnCredential.adminId))
            .innerJoin(user, eq(user.id, admin.userId))
            .where(
              inArray(webAuthnCredential.id, [
                ...intBuckets.webauthn_credential,
              ]),
            )
        : [],
    ]);

    for (const u of users) put('user', u.id, u.account);
    for (const a of admins) put('admin', a.id, a.account);
    for (const s of sessions) put('user_session', s.id, s.account);
    for (const a of adminSessions) put('admin_session', a.id, a.account);
    for (const c of loginCodes) put('login_code', c.id, c.account);
    for (const p of pushTokens) put('push_token', p.id, p.account);
    for (const w of webauthns) put('webauthn_credential', w.id, w.account);

    return labelByKey;
  }
}
