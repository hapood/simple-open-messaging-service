import {
  Bell,
  CircleUser,
  Globe,
  HardDrive,
  Hash,
  LayoutDashboard,
  ListChecks,
  type LucideIcon,
  Monitor,
  Network,
  Radio,
  ScrollText,
  Settings,
  ShieldBan,
  Gauge,
  MessageSquareWarning,
  Users,
} from 'lucide-react';

/** The `key` suffix under the `nav.*` i18n namespace. Typed as a finite union so the
 *  `t(\`nav.${key}\`)` template literal resolves to a known key (the typed t() rejects `string`). */
type NavKey =
  | 'dashboard'
  | 'users'
  | 'groups'
  | 'sessions'
  | 'connections'
  | 'bans'
  | 'push'
  | 'federation'
  | 'networkInfo'
  | 'localInformation'
  | 'quota'
  | 'logs'
  | 'media'
  | 'settings'
  | 'security'
  | 'adminSessions'
  | 'durableTasks'
  | 'rateLimits'
  | 'messageReports';

/** Full i18n key for a group header (under nav.group.*). */
type NavGroupKey =
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
  /** Match this item only on exact path, not prefix. */
  end?: boolean;
}

export interface NavGroup {
  labelKey: NavGroupKey;
  items: NavItem[];
  /** Render in the bottom personal cluster (My Account) rather than the main nav list. */
  footer?: boolean;
}

/** Sidebar structure grouped by responsibility. The footer Account group renders at the bottom. */
export const NAV_GROUPS: NavGroup[] = [
  {
    labelKey: 'nav.group.overview',
    items: [
      {
        to: '/dashboard',
        key: 'dashboard',
        icon: LayoutDashboard,
        disabled: true,
      },
      { to: '/users', key: 'users', icon: Users },
      { to: '/federation', key: 'federation', icon: Globe },
      { to: '/connections', key: 'connections', icon: Radio, disabled: true },
    ],
  },
  {
    labelKey: 'nav.group.access',
    items: [
      { to: '/sessions', key: 'sessions', icon: Monitor, disabled: true },
      { to: '/groups', key: 'groups', icon: Hash, disabled: true },
      { to: '/bans', key: 'bans', icon: ShieldBan, disabled: true },
      {
        to: '/durable-tasks',
        key: 'durableTasks',
        icon: ListChecks,
        disabled: true,
      },
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
      { to: '/push', key: 'push', icon: Bell, disabled: true },
      { to: '/media', key: 'media', icon: HardDrive, disabled: true },
      { to: '/logs', key: 'logs', icon: ScrollText },
      { to: '/network', key: 'networkInfo', icon: Network },
      { to: '/local-information', key: 'localInformation', icon: Monitor },
      { to: '/quota', key: 'quota', icon: Gauge },
      { to: '/admin-sessions', key: 'adminSessions', icon: Monitor },
      {
        to: '/rate-limits',
        key: 'rateLimits',
        icon: Gauge,
        disabled: true,
      },
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
