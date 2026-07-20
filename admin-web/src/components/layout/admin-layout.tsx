import { type ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { LogOut } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/auth/auth-context'
import { Button } from '@/components/ui/button'
import { LanguageSwitcher } from '@/components/layout/language-switcher'
import { NAV_GROUPS, type NavItem } from '@/components/layout/nav-config'
import { TopBar } from '@/components/layout/top-bar'
import { CommandPalette } from '@/components/layout/command-palette'

export function AdminLayout({ children }: { children: ReactNode }) {
  const { logout } = useAuth()
  const { t } = useTranslation()
  return (
    <div className="flex min-h-svh bg-background">
      <aside className="flex w-56 shrink-0 flex-col border-r bg-sidebar p-4 text-sidebar-foreground">
        <div className="flex items-center gap-2 px-2 py-3">
          {/* Same mark as the consumer web/app logo, recolored violet to tell the
              admin console apart at a glance. favicon.svg is the single brand
              asset (also wired as the tab icon in index.html). The src must be
              prefixed with BASE_URL: Vite rewrites the <link> in index.html to
              the configured base (/admin/) but does NOT touch string literals in
              JSX, so a bare "/favicon.svg" would 404 in prod (host root serves
              the consumer app, not /admin/). */}
          <img
            src={`${import.meta.env.BASE_URL}favicon.svg`}
            alt=""
            aria-hidden="true"
            className="size-7 rounded-md"
          />
          <span className="text-lg font-semibold tracking-tight">{t('common.appName')}</span>
        </div>
        <nav className="flex flex-1 flex-col gap-4 overflow-y-auto">
          {NAV_GROUPS.filter((g) => !g.footer).map((group) => (
            <div key={group.labelKey} className="flex flex-col gap-1">
              <div className="px-3 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                {t(group.labelKey)}
              </div>
              {group.items.map((item) => (
                <NavEntry key={item.to} item={item} />
              ))}
            </div>
          ))}
        </nav>
        <div className="mt-auto flex flex-col gap-1">
          {NAV_GROUPS.filter((g) => g.footer).flatMap((g) => g.items).map((item) => (
            <NavEntry key={item.to} item={item} />
          ))}
          <LanguageSwitcher />
          <Button variant="ghost" className="w-full justify-start gap-2" onClick={logout}>
            <LogOut className="size-4" />
            {t('nav.logout')}
          </Button>
        </div>
      </aside>
      <div className="flex flex-1 flex-col overflow-hidden">
        <TopBar />
        <main className="flex-1 overflow-auto">
          <div className="p-6 lg:px-8">{children}</div>
        </main>
      </div>
      <CommandPalette />
    </div>
  )
}

function NavEntry({ item }: { item: NavItem }) {
  const { t } = useTranslation()
  if (item.disabled) {
    return (
      <span
        aria-disabled
        title={t('common.comingSoon')}
        className="flex cursor-not-allowed items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground/50"
      >
        <item.icon className="size-4" />
        {t(`nav.${item.key}`)}
      </span>
    )
  }
  return (
    <NavLink
      to={item.to}
      end={item.end}
      className={({ isActive }) =>
        [
          'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
          isActive
            ? 'bg-sidebar-accent text-sidebar-accent-foreground'
            : 'hover:bg-sidebar-accent/60',
        ].join(' ')
      }
    >
      <item.icon className="size-4" />
      {t(`nav.${item.key}`)}
    </NavLink>
  )
}
