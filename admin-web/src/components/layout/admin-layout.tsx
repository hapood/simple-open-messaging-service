import { type ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { Bell, BellRing, LogOut, Monitor, Radio, ShieldBan, ShieldCheck, Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/auth/auth-context'
import { Button } from '@/components/ui/button'
import { LanguageSwitcher } from '@/components/layout/language-switcher'

const NAV = [
  { to: '/users', key: 'users', icon: Users },
  { to: '/sessions', key: 'sessions', icon: Monitor },
  { to: '/connections', key: 'connections', icon: Radio },
  { to: '/admin-sessions', key: 'adminSessions', icon: ShieldCheck },
  { to: '/bans', key: 'bans', icon: ShieldBan },
  { to: '/reuse', key: 'reuse', icon: BellRing },
  { to: '/push', key: 'push', icon: Bell },
] as const

export function AdminLayout({ children }: { children: ReactNode }) {
  const { logout } = useAuth()
  const { t } = useTranslation()
  return (
    <div className="flex min-h-svh bg-background">
      <aside className="flex w-56 shrink-0 flex-col gap-1 border-r bg-sidebar p-4 text-sidebar-foreground">
        <div className="px-2 py-3 text-lg font-semibold tracking-tight">{t('common.appName')}</div>
        <nav className="flex flex-col gap-1">
          {NAV.map((it) => (
            <NavLink
              key={it.to}
              to={it.to}
              className={({ isActive }) =>
                [
                  'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
                  isActive
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                    : 'hover:bg-sidebar-accent/60',
                ].join(' ')
              }
            >
              <it.icon className="size-4" />
              {t(`nav.${it.key}`)}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto flex flex-col gap-1">
          <LanguageSwitcher />
          <Button variant="ghost" className="w-full justify-start gap-2" onClick={logout}>
            <LogOut className="size-4" />
            {t('nav.logout')}
          </Button>
        </div>
      </aside>
      <main className="flex-1 overflow-auto">
        <div className="mx-auto max-w-6xl p-6">{children}</div>
      </main>
    </div>
  )
}
