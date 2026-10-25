import type { Ban } from '@/types/api';

export const BAN_LABEL_KEYS = {
  ip: 'bans.type.ip',
  user: 'bans.type.user',
  otp: 'bans.type.otp',
  admin_pwd: 'bans.type.adminPassword',
  admin_2fa: 'bans.type.adminSecondFactor',
} as const satisfies Record<Ban['type'], string>;

export function accountRestrictions(bans: Ban[], account: string, now: number) {
  return bans.filter(
    (ban) => ban.type !== 'ip' && ban.value === account && ban.until > now,
  );
}

export function groupRestrictions(bans: Ban[], search: string, now: number) {
  const accounts = new Map<string, Ban[]>();
  const ips: Ban[] = [];
  const term = search.trim().toLowerCase();
  for (const ban of bans) {
    if (ban.until <= now || !ban.value.toLowerCase().includes(term)) continue;
    if (ban.type === 'ip') ips.push(ban);
    else {
      const entries = accounts.get(ban.value) ?? [];
      entries.push(ban);
      accounts.set(ban.value, entries);
    }
  }
  return {
    accounts: [...accounts.entries()].sort(([a], [b]) => a.localeCompare(b)),
    ips,
  };
}
