import { groupStateSql } from '../group/group-state.js';
import { accountProfileFields } from '../user/account-profile.js';
import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, ilike, inArray, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { account, pushToken, account as user } from '../database/schema.js';
import { AuthService } from '../auth/auth.service.js';
import { UserService } from '../user/user.service.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { randomInt } from 'node:crypto';
import { UserQuotaService } from '../quota/user-quota.service.js';
import { rawDate } from '../database/raw-result.js';
@Injectable()
export class UserManageService {
  constructor(
    private database: DatabaseService,
    private auth: AuthService,
    private userService: UserService,
    private userQuotaService: UserQuotaService,
  ) {}

  /** 360° view of one user: profile + group memberships + active sessions + push devices.
   *  One round-trip via Promise.all. Returns null when the user does not exist. */
  async getUserDetail(id: number) {
    const localAccount = await this.database.db.query.account.findFirst({
      where: eq(account.id, id),
      columns: { id: true },
    });
    if (!localAccount) return null;
    const profile = await this.userService.findUniqueUser({ id });
    if (!profile) return null;
    const [groups, sessions, pushTokens] = await Promise.all([
      this.database.db
        .execute<{
          threadId: number;
          role: 'OWNER' | 'ADMIN' | 'MEMBER';
          joinedAt: string;
          groupAccount: string;
          groupName: string;
        }>(
          sql`
          SELECT thread.id AS "threadId", latest.body ->> 'role' AS role,
            latest."createdAt" AS "joinedAt", group_profile.account AS "groupAccount",
            group_profile.name AS "groupName"
          FROM "MessageThread" thread
          JOIN ${groupStateSql} group_profile ON group_profile.id = thread.id
          JOIN LATERAL (
            SELECT member_fact.operation, member_fact.body, member_fact."createdAt"
            FROM "GroupMetaMemberFeed" member_fact
            WHERE member_fact."threadId" = group_profile.id
              AND member_fact."memberAccount" = (SELECT account FROM "Account" WHERE id = ${id})
              AND member_fact."memberDomain" = 'local' AND member_fact."memberNamespaceId" = 0
            ORDER BY member_fact."feedId" DESC
            LIMIT 1
          ) latest ON latest.operation = 'UPSERT'
          JOIN "AccountThreadState" account_state
            ON account_state."accountId" = ${id}
           AND account_state."threadId" = thread.id
          WHERE thread.type = 'GROUP'
          ORDER BY latest."createdAt" DESC
        `,
        )
        .then((result) =>
          result.rows.map(({ groupAccount, groupName, ...row }) => ({
            ...row,
            joinedAt: rawDate(row.joinedAt, 'joinedAt'),
            leftAt: null,
            thread: { group: { account: groupAccount, name: groupName } },
          })),
        ),
      this.auth.listActiveSessions(id, null),
      this.database.db.query.pushToken.findMany({
        where: eq(pushToken.userId, id),
        columns: { id: true, platform: true, deviceId: true, lastSeenAt: true },
        orderBy: desc(pushToken.lastSeenAt),
      }),
    ]);
    return { user: profile, groups, sessions, pushTokens };
  }

  // ── Admin user-management operations ────────────────────────────────────────
  // Moved here from AdminController so the controller stays a pure HTTP adapter. Each mutator runs
  // through the same path its single-user endpoint did: disable force-logs-out, generate-initial-password
  // revokes all sessions, etc. Services take primitives/local option types (never admin DTOs) to keep
  // the user-manage layer free of an admin dependency; the controller translates the DTO.

  /** Paginated, searchable local-person user list. Federated user stubs and groups belong to their
   *  respective administration surfaces and must never receive local-account actions. Omits hashPwd. */
  async listUsers(opts: { skip?: number; take?: number; search?: string }) {
    const where = and(
      eq(user.domain, 'local'),
      eq(user.namespaceId, 0),
      opts.search ? ilike(user.account, `%${opts.search}%`) : undefined,
    );
    const [list, total] = await Promise.all([
      this.database.db
        .select({
          id: user.id,
          account: user.account,
          name: accountProfileFields(user).name,
          avatar: accountProfileFields(user).avatar,
          bio: accountProfileFields(user).bio,
          domain: user.domain,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
          isDeleted: sql<boolean>`${account.disabledAt} IS NOT NULL`,
          profileRev: user.defaultProfileRev,
          stateFeedEndId: account.clientStateFeedEndId,
          mustChangePassword: account.mustChangePassword,
        })
        .from(user)
        .where(where)
        .orderBy(desc(user.createdAt))
        .offset(opts.skip ?? 0)
        .limit(opts.take ?? 20),
      this.database.db
        .select({ value: count() })
        .from(user)
        .where(where)
        .then(([row]) => row.value),
    ]);
    const localIds = list.map((item) => item.id);
    const quotaByUser = await this.userQuotaService.getSummaries(localIds);
    return {
      list: list.map((item) => ({
        ...item,
        quota: quotaByUser.get(item.id) ?? null,
      })),
      total,
    };
  }

  /** Soft-delete + revoke every session token (invalidateAllSessions revokes all SessionToken rows + emits FORCE_LOGOUT). */
  async disableUser(id: number): Promise<void> {
    await this.assertLocalPerson(id);
    await this.updateAccountOrThrow(id, { disabledAt: new Date() });
    await this.auth.invalidateAllSessions(id, 'admin_disabled');
  }

  async enableUser(id: number): Promise<void> {
    await this.assertLocalPerson(id);
    await this.updateAccountOrThrow(id, { disabledAt: null });
  }

  /** Force logout every device without changing the account (disable = soft-delete; this does not). */
  async forceLogout(id: number): Promise<void> {
    await this.assertLocalPerson(id);
    await this.auth.invalidateAllSessions(id, 'admin_force_logout');
  }

  /** (Re-)initialize a user's INITIAL password: generate a strong random password (reveal-once — the admin
   *  never authors the value), store its hash, set mustChangePassword so the user is FORCED to set their own
   *  on first login, and revoke every active session. This is the ONLY way a password lands on an account:
   *  the admin can never choose or change a user's password, only re-initialize it. Returns the plaintext
   *  exactly once. */
  async generateInitialPassword(id: number): Promise<{ password: string }> {
    await this.assertLocalPerson(id);
    const password = randomInitialPassword();
    const hash = await this.auth.hashPassword(password);
    await this.updateAccountOrThrow(id, {
      hashPwd: hash,
      mustChangePassword: true,
    });
    await this.auth.invalidateAllSessions(id, 'admin_reinit_password');
    return { password };
  }

  /** Create a local user (admin-provisioned). Delegates to UserService.addUser — the single creation choke
   *  point that normalizes/validates the account grammar + enforces uniqueness. The password is optional:
   *  provided → hashed + stored; omitted → the account is created with NO password (an OTP/QR-only account,
   *  bootstrapped by the one-time code the admin issues next). Whether a password is allowed/required is a
   *  loginMode policy enforced by the controller; this service persists exactly what it's given. Returns the
   *  new {id, account}; throws ALREADY_EXISTS on a duplicate account. */
  async createUser(params: {
    account: string;
    name: string;
    password?: string;
  }): Promise<{ id: number; account: string }> {
    const hashPwd = params.password
      ? await this.auth.hashPassword(params.password)
      : null;
    const res = await this.userService.addUser({
      account: params.account,
      name: params.name,
      hashPwd,
    });
    // addUser returns {status:2} on a duplicate account (no data) — map to ALREADY_EXISTS. status 0
    // guarantees data is present; the guard also narrows it for the typechecker.
    if (res.status !== 0 || !res.data) {
      throw new BusinessException(
        BusinessCode.ALREADY_EXISTS,
        `account ${params.account} already exists`,
      );
    }
    return res.data;
  }

  /** Apply one action to many users, each via its single-user path. Returns the count processed. */
  async batchUsers(
    ids: number[],
    action: 'disable' | 'enable' | 'force-logout',
  ): Promise<{ affected: number }> {
    for (const id of ids) {
      if (action === 'disable') await this.disableUser(id);
      else if (action === 'enable') await this.enableUser(id);
      else await this.forceLogout(id);
    }
    return { affected: ids.length };
  }

  /** Batch-resolve userId → account for the live-connections backfill (avoids N+1 in the controller). */
  async attachAccounts(userIds: number[]): Promise<Map<number, string>> {
    if (userIds.length === 0) return new Map();
    const users = await this.database.db
      .select({ id: user.id, account: user.account })
      .from(user)
      .where(inArray(user.id, userIds));
    return new Map(users.map((u) => [u.id, u.account]));
  }

  private async updateAccountOrThrow(
    id: number,
    data: Partial<typeof account.$inferInsert>,
  ): Promise<void> {
    const rows = await this.database.db
      .update(account)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(account.id, id))
      .returning({ id: account.id });
    if (rows.length === 0) {
      throw new BusinessException(BusinessCode.NOT_FOUND, 'user not found');
    }
  }

  private async assertLocalPerson(id: number): Promise<void> {
    const target = await this.database.db
      .select({ id: account.id })
      .from(account)
      .where(
        and(eq(user.id, id), eq(user.domain, 'local'), eq(user.namespaceId, 0)),
      )
      .limit(1);
    if (target.length === 0) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'local user not found',
      );
    }
  }
}

/** 12-char [A-Za-z0-9] password (~71 bits) — typeable, matches RegisterDto's allowed-character class.
 *  Used only by {@link UserManageService.generateInitialPassword}. */
function randomInitialPassword(): string {
  const CHARS =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 12; i++) s += CHARS[randomInt(0, CHARS.length)];
  return s;
}
