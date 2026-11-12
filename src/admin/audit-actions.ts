/** Each action owns an explicit allowlist of scalar request fields. Never capture whole bodies. */
const quotaFields = [
  'maxFileBytes',
  'dailyMsgLimit',
  'dailyRequestLimit',
  'dailySignalLimit',
  'dailyFileLimit',
  'dailyFileBytesLimit',
] as const;
const continueFields = [
  'addMsg',
  'addRequest',
  'addSignal',
  'addFile',
  'addFileBytes',
] as const;

export const AUDIT_ACTIONS = {
  'admin.change_password': [],
  'admin.grant_viewer': [],
  'admin.disable': [],
  'admin.enable': [],
  'admin.role': ['role'],
  'admin.reset_2fa': [],
  'admin.2fa_enable': [],
  'admin.2fa_disable': [],
  'admin.2fa_regenerate_backup': [],
  'admin.webauthn_register_begin': ['nickname'],
  'admin.webauthn_register_finish': [],
  'admin.webauthn_rename': ['nickname'],
  'admin.webauthn_delete': [],
  'admin_session.revoke': [],
  'user.create': ['account'],
  'user.disable': [],
  'user.enable': [],
  'user.force_logout': [],
  'user.issue_login_code': [],
  'user.revoke_login_code': [],
  'user.generate_initial_password': [],
  'user.quota.set': quotaFields,
  'user.batch': ['ids', 'action'],
  'thread.history.clear': ['threadId', 'seq'],
  'ban.unban': ['ip', 'account'],
  'session.purge_all': [],
  'session.revoke': [],
  'push.token.delete': [],
  'push.test': ['id'],
  'quota.node.setLimits': quotaFields,
  'quota.node.continue': continueFields,
  'quota.user.continue': continueFields,
  'media.upload.abort': [],
  'media.download.stop': [],
  'media.file.reclaim': [],
  'media.temporary.clean': [],
  'media.download.retry': [],
  'media.download.clean': [],
  'federation.local_root_rotate': [],
  'federation.local_root_unpublish': [],
  'federation.identity_review_approve': ['resolution'],
  'federation.identity_review_reject': [],
  'federation.peer.retire_start': ['confirmDomain'],
  'federation.peer.identity_recover': ['confirmDomain'],
  'federation.peer.recognize': [],
  'federation.peer.block': ['note'],
  'federation.peer.unblock': [],
  'message_report.dismiss': ['threadId', 'seq'],
  'message.delete': ['threadId', 'seq'],
  'settings.federation-transport.save': [
    'keyCacheTtlSec',
    'connectTimeoutSec',
    'requestIdleTimeoutSec',
    'mediaChunkBytes',
    'mediaMaxChunkRetries',
  ],
  'settings.admin-session-policy.save': ['ttlHours', 'idleMinutes'],
  'settings.federation-quota-defaults.save': quotaFields,
  'settings.user-quota-defaults.save': quotaFields,
  'settings.federation-http.save': ['global', 'perPeer'],
  'settings.federation-history-access.save': ['enabled'],
  'settings.federation-download.save': [
    'global',
    'perPeer',
    'chunkDigestEnabled',
  ],
  'settings.otp-ttl.save': ['ttlMinutes'],
  'diagnostics.gc': [],
  'diagnostics.delete': [],
  'logs.output_level.set': ['level'],
  // Array configurations are projected field-by-field by collectAuditData.
  'settings.rate-limits.fixed-window.save': [],
  'settings.rate-limits.save': [],
} as const satisfies Record<string, readonly string[]>;

export type AuditAction = keyof typeof AUDIT_ACTIONS;
type AuditScalar = string | number | boolean | null;
type AuditValue = AuditScalar | AuditValue[] | { [key: string]: AuditValue };
export type AuditData = Record<string, AuditValue>;

function isScalar(value: unknown): value is AuditScalar {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

/** Reject nested values even under allowed names: unvalidated request bodies may contain secrets. */
function pickFields(body: unknown, fields: readonly string[]): AuditData {
  const result: AuditData = {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) return result;
  for (const field of fields) {
    const value = (body as Record<string, unknown>)[field];
    if (isScalar(value)) result[field] = value;
    else if (Array.isArray(value) && value.every(isScalar))
      result[field] = [...value];
  }
  return result;
}

export function collectAuditData(
  action: AuditAction,
  body: unknown,
): AuditData {
  if (
    action === 'settings.rate-limits.fixed-window.save' &&
    Array.isArray(body)
  ) {
    return {
      policies: body.map((item) =>
        pickFields(item, ['policy', 'limit', 'windowSeconds']),
      ),
    };
  }
  if (action === 'settings.rate-limits.save' && Array.isArray(body)) {
    return {
      policies: body.map((item) => {
        const policy = pickFields(item, ['policy', 'mode']);
        const buckets: unknown =
          item && typeof item === 'object' ? item.buckets : undefined;
        if (Array.isArray(buckets)) {
          policy.buckets = buckets.map((bucket) =>
            pickFields(bucket, ['name', 'ratePerSecond', 'burst', 'enforce']),
          );
        }
        return policy;
      }),
    };
  }
  return pickFields(body, AUDIT_ACTIONS[action]);
}
