import {
  Activity,
  Bell,
  BellRing,
  ClipboardList,
  Globe,
  HardDrive,
  Hash,
  LayoutDashboard,
  type LucideIcon,
  Monitor,
  Radio,
  ScrollText,
  Settings,
  ShieldBan,
  ShieldCheck,
  UserCog,
  Users,
} from 'lucide-react'

/** The `key` suffix under the `nav.*` i18n namespace. Typed as a finite union so the
 *  `t(\`nav.${key}\`)` template literal resolves to a known key (the typed t() rejects `string`). */
export type NavKey =
  | 'dashboard'
  | 'users'
  | 'groups'
  | 'sessions'
  | 'connections'
  | 'adminSessions'
  | 'bans'
  | 'reuse'
  | 'push'
  | 'federation'
  | 'selfCheck'
  | 'logs'
  | 'media'
  | 'audit'
  | 'admins'
  | 'settings'

/** Full i18n key for a group header (under nav.group.*). */
export type NavGroupKey =
  | 'nav.group.overview'
  | 'nav.group.security'
  | 'nav.group.federation'
  | 'nav.group.system'

export interface NavItem {
  to: string
  key: NavKey
  icon: LucideIcon
  /** Placeholder entry rendered as a disabled, non-navigating item. */
  disabled?: boolean
  /** Match this item only on exact path, not prefix. Set on section roots that share
   *  a prefix with a deeper item (e.g. /federation vs /federation/self-check). */
  end?: boolean
}

export interface NavGroup {
  labelKey: NavGroupKey
  items: NavItem[]
}

/** Sidebar structure, grouped by responsibility. Placeholder items (media/audit/settings)
 *  light up in later phases. */
export const NAV_GROUPS: NavGroup[] = [
  {
    labelKey: 'nav.group.overview',
    items: [
      { to: '/dashboard', key: 'dashboard', icon: LayoutDashboard },
      { to: '/users', key: 'users', icon: Users },
      { to: '/groups', key: 'groups', icon: Hash },
    ],
  },
  {
    labelKey: 'nav.group.security',
    items: [
      { to: '/connections', key: 'connections', icon: Radio },
      { to: '/sessions', key: 'sessions', icon: Monitor },
      { to: '/admin-sessions', key: 'adminSessions', icon: ShieldCheck },
      { to: '/bans', key: 'bans', icon: ShieldBan },
      { to: '/reuse', key: 'reuse', icon: BellRing },
    ],
  },
  {
    labelKey: 'nav.group.federation',
    items: [
      { to: '/federation', key: 'federation', icon: Globe, end: true },
      { to: '/federation/self-check', key: 'selfCheck', icon: Activity },
    ],
  },
  {
    labelKey: 'nav.group.system',
    items: [
      { to: '/push', key: 'push', icon: Bell },
      { to: '/media', key: 'media', icon: HardDrive },
      { to: '/audit', key: 'audit', icon: ClipboardList },
      { to: '/admins', key: 'admins', icon: UserCog },
      { to: '/logs', key: 'logs', icon: ScrollText },
      { to: '/settings', key: 'settings', icon: Settings },
    ],
  },
]

/** Most-specific active nav match for a pathname (longest matching `to` wins). Powers the
 *  sidebar active state and the top-bar breadcrumb. */
export function matchNav(pathname: string): { item: NavItem; group: NavGroup } | null {
  let best: { item: NavItem; group: NavGroup } | null = null
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      if (item.disabled) continue
      const match = item.end
        ? pathname === item.to
        : pathname === item.to || pathname.startsWith(item.to + '/')
      if (match && (!best || item.to.length > best.item.to.length)) {
        best = { item, group }
      }
    }
  }
  return best
}
