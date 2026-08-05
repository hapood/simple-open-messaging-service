import {
  Bell,
  CircleUser,
  FileWarning,
  Globe,
  HardDrive,
  Hash,
  LayoutDashboard,
  type LucideIcon,
  Monitor,
  Radio,
  ScrollText,
  Settings,
  Link2,
  ShieldBan,
  Gauge,
  MessageSquareWarning,
  Users,
} from 'lucide-react';

/** The `key` suffix under the `nav.*` i18n namespace. Typed as a finite union so the
 *  `t(\`nav.${key}\`)` template literal resolves to a known key (the typed t() rejects `string`). */
export type NavKey =
  | 'dashboard'
  | 'users'
  | 'groups'
  | 'sessions'
  | 'connections'
  | 'bans'
  | 'push'
  | 'federation'
  | 'logs'
  | 'media'
  | 'settings'
  | 'security'
  | 'audit'
  | 'linkCards'
  | 'rateLimits'
  | 'messageReports';

/** Full i18n key for a group header (under nav.group.*). */
export type NavGroupKey =
  | 'nav.group.overview'
  | 'nav.group.access'
  | 'nav.group.system'
  | 'nav.group.account';

export interface NavItem {
  to: string;
  key: NavKey;
  icon: LucideIcon;
  /** Placeholder entry rendered as a disabled, non-navigating item. */
  disabled?: boolean;
  /** Match this item only on exact path, not prefix. Set on section roots that share
   *  a prefix with a deeper item (e.g. /federation vs /federation/self-check). */
  end?: boolean;
}

export interface NavGroup {
  labelKey: NavGroupKey;
  items: NavItem[];
  /** Render in the bottom personal cluster (My Account) rather than the main nav list. */
  footer?: boolean;
}

/** Sidebar structure, grouped by responsibility. Pages that share a URL prefix with a sub-view
 *  (Federation → /federation/self-check) keep the default prefix match so the parent stays
 *  highlighted on the sub-route. The footer group ("Account") renders separately at the bottom. */
export const NAV_GROUPS: NavGroup[] = [
  {
    labelKey: 'nav.group.overview',
    items: [
      { to: '/dashboard', key: 'dashboard', icon: LayoutDashboard },
      { to: '/users', key: 'users', icon: Users },
      { to: '/federation', key: 'federation', icon: Globe },
      { to: '/connections', key: 'connections', icon: Radio },
    ],
  },
  {
    labelKey: 'nav.group.access',
    items: [
      { to: '/sessions', key: 'sessions', icon: Monitor },
      { to: '/groups', key: 'groups', icon: Hash },
      { to: '/bans', key: 'bans', icon: ShieldBan },
      { to: '/audit', key: 'audit', icon: FileWarning },
      {
        to: '/message-reports',
        key: 'messageReports',
        icon: MessageSquareWarning,
      },
    ],
  },
  {
    labelKey: 'nav.group.system',
    items: [
      { to: '/push', key: 'push', icon: Bell },
      { to: '/media', key: 'media', icon: HardDrive },
      { to: '/link-cards', key: 'linkCards', icon: Link2 },
      { to: '/logs', key: 'logs', icon: ScrollText },
      { to: '/rate-limits', key: 'rateLimits', icon: Gauge },
      { to: '/settings', key: 'settings', icon: Settings },
    ],
  },
  {
    labelKey: 'nav.group.account',
    footer: true,
    items: [{ to: '/security', key: 'security', icon: CircleUser }],
  },
];

/** Most-specific active nav match for a pathname (longest matching `to` wins). Powers the
 *  sidebar active state and the top-bar breadcrumb. */
export function matchNav(
  pathname: string,
): { item: NavItem; group: NavGroup } | null {
  let best: { item: NavItem; group: NavGroup } | null = null;
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      if (item.disabled) continue;
      const match = item.end
        ? pathname === item.to
        : pathname === item.to || pathname.startsWith(item.to + '/');
      if (match && (!best || item.to.length > best.item.to.length)) {
        best = { item, group };
      }
    }
  }
  return best;
}
