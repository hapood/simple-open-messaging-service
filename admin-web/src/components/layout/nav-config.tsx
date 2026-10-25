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
  | 'durableTasks'
  | 'rateLimits'
  | 'messageReports';

type NavGroupKey =
  | 'nav.group.users'
  | 'nav.group.security'
  | 'nav.group.monitoring'
  | 'nav.group.network'
  | 'nav.group.services'
  | 'nav.group.account';

export interface NavItem {
  to: string;
  key: NavKey;
  icon: LucideIcon;
  end?: boolean;
}

export interface NavGroup {
  /** Unlabelled groups render standalone entries without a collapse control. */
  labelKey?: NavGroupKey;
  items: NavItem[];
  footer?: boolean;
}

/** Organize by administrative responsibility, not assumed usage frequency. */
export const NAV_GROUPS: NavGroup[] = [
  {
    items: [
      { to: '/dashboard', key: 'dashboard', icon: LayoutDashboard, end: true },
    ],
  },
  {
    labelKey: 'nav.group.users',
    items: [
      { to: '/users', key: 'users', icon: Users },
      { to: '/groups', key: 'groups', icon: Hash },
      {
        to: '/message-reports',
        key: 'messageReports',
        icon: MessageSquareWarning,
      },
    ],
  },
  {
    labelKey: 'nav.group.security',
    items: [
      { to: '/sessions', key: 'sessions', icon: Monitor },
      { to: '/bans', key: 'bans', icon: ShieldBan },
    ],
  },
  {
    labelKey: 'nav.group.monitoring',
    items: [
      { to: '/connections', key: 'connections', icon: Radio },
      { to: '/durable-tasks', key: 'durableTasks', icon: ListChecks },
      { to: '/logs', key: 'logs', icon: ScrollText },
      { to: '/rate-limits', key: 'rateLimits', icon: Gauge },
    ],
  },
  {
    labelKey: 'nav.group.network',
    items: [
      { to: '/federation', key: 'federation', icon: Globe },
      { to: '/network', key: 'networkInfo', icon: Network },
    ],
  },
  {
    labelKey: 'nav.group.services',
    items: [
      { to: '/push', key: 'push', icon: Bell },
      { to: '/media', key: 'media', icon: HardDrive },
      { to: '/quota', key: 'quota', icon: Gauge },
      { to: '/local-information', key: 'localInformation', icon: Monitor },
      { to: '/settings', key: 'settings', icon: Settings },
    ],
  },
  {
    labelKey: 'nav.group.account',
    footer: true,
    items: [{ to: '/security', key: 'security', icon: CircleUser }],
  },
];

/** Most-specific matching destination powers the top-bar breadcrumb. */
export function matchNav(
  pathname: string,
): { item: NavItem; group: NavGroup } | null {
  let best: { item: NavItem; group: NavGroup } | null = null;
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      const match = item.end
        ? pathname === item.to
        : pathname === item.to || pathname.startsWith(item.to + '/');
      if (match && (!best || item.to.length > best.item.to.length))
        best = { item, group };
    }
  }
  return best;
}
