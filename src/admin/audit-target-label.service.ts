import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service.js';

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
  constructor(private readonly prisma: PrismaService) {}

  async resolve(rows: TargetLabelRow[]): Promise<Map<string, string>> {
    const labelByKey = new Map<string, string>();
    const put = (type: string, id: string | number | bigint, label: string): void => {
      labelByKey.set(`${type}:${id}`, label);
    };

    const bigBuckets = {
      admin_session: new Set<bigint>(),
      webauthn_credential: new Set<bigint>(),
    };
    const intBuckets = {
      user: new Set<number>(),
      admin: new Set<number>(),
      user_session: new Set<number>(),
      login_code: new Set<number>(),
      push_token: new Set<number>(),
    };
    for (const r of rows) {
      const t = r.targetType;
      const id = r.targetId;
      if (!t || !id || !/^\d+$/.test(id)) continue;
      if (t in bigBuckets) bigBuckets[t as keyof typeof bigBuckets].add(BigInt(id));
      else if (t in intBuckets) intBuckets[t as keyof typeof intBuckets].add(Number(id));
    }

    const [users, admins, sessions, adminSessions, loginCodes, pushTokens, webauthns] =
      await Promise.all([
        intBuckets.user.size
          ? this.prisma.user.findMany({
              where: { id: { in: [...intBuckets.user] } },
              select: { id: true, account: true },
            })
          : [],
        intBuckets.admin.size
          ? this.prisma.admin.findMany({
              where: { id: { in: [...intBuckets.admin] } },
              select: { id: true, user: { select: { account: true } } },
            })
          : [],
        intBuckets.user_session.size
          ? this.prisma.sessionToken.findMany({
              where: { id: { in: [...intBuckets.user_session] } },
              select: { id: true, user: { select: { account: true } } },
            })
          : [],
        bigBuckets.admin_session.size
          ? this.prisma.adminSession.findMany({
              where: { id: { in: [...bigBuckets.admin_session] } },
              select: { id: true, admin: { select: { user: { select: { account: true } } } } },
            })
          : [],
        intBuckets.login_code.size
          ? this.prisma.loginCode.findMany({
              where: { id: { in: [...intBuckets.login_code] } },
              select: { id: true, user: { select: { account: true } } },
            })
          : [],
        intBuckets.push_token.size
          ? this.prisma.pushToken.findMany({
              where: { id: { in: [...intBuckets.push_token] } },
              select: { id: true, user: { select: { account: true } } },
            })
          : [],
        bigBuckets.webauthn_credential.size
          ? this.prisma.webAuthnCredential.findMany({
              where: { id: { in: [...bigBuckets.webauthn_credential] } },
              select: { id: true, admin: { select: { user: { select: { account: true } } } } },
            })
          : [],
      ]);

    for (const u of users) put('user', u.id, u.account);
    for (const a of admins) put('admin', a.id, a.user.account);
    for (const s of sessions) put('user_session', s.id, s.user.account);
    for (const a of adminSessions) put('admin_session', a.id, a.admin.user.account);
    for (const c of loginCodes) put('login_code', c.id, c.user.account);
    for (const p of pushTokens) put('push_token', p.id, p.user.account);
    for (const w of webauthns) put('webauthn_credential', w.id, w.admin.user.account);

    return labelByKey;
  }
}
