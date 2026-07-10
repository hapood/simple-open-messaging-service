import { useLocation } from 'react-router-dom'
import { useTheme } from 'next-themes'
import { useTranslation } from 'react-i18next'
import { Moon, Search, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { matchNav } from '@/components/layout/nav-config'
import { useMe } from '@/hooks/use-me'
import type { AdminRole } from '@/types/api'

const ROLE_KEY: Record<AdminRole, 'super' | 'admin' | 'viewer'> = {
  SUPER_ADMIN: 'super',
  ADMIN: 'admin',
  VIEWER: 'viewer',
}

/** Sticky top bar: a "section / page" breadcrumb derived from the active nav match on the left;
 *  current-admin identity chip + theme toggle on the right. */
export function TopBar() {
  const { t } = useTranslation()
  const { pathname } = useLocation()
  const { resolvedTheme, setTheme } = useTheme()
  const me = useMe()
  const active = matchNav(pathname)
  const isDark = resolvedTheme === 'dark'

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b bg-background px-6 lg:px-8">
      <nav className="flex items-center gap-2 text-sm">
        {active ? (
          <>
            <span className="text-muted-foreground">{t(active.group.labelKey)}</span>
            <span className="text-muted-foreground/50">/</span>
            <span className="font-medium">{t(`nav.${active.item.key}`)}</span>
          </>
        ) : (
          <span className="text-muted-foreground">{t('common.appName')}</span>
        )}
      </nav>
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="gap-2 text-muted-foreground"
          onClick={() => window.dispatchEvent(new CustomEvent('open-command-palette'))}
          title={`${t('search.placeholder')} (⌘K)`}
        >
          <Search className="size-4" />
          <span className="hidden md:inline">{t('topBar.search')}</span>
          <kbd className="hidden rounded border bg-muted px-1 text-[10px] md:inline">⌘K</kbd>
        </Button>
        {me.data ? (
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">{me.data.name || me.data.account}</span>
            <Badge
              variant={me.data.role === 'SUPER_ADMIN' ? 'default' : 'outline'}
              className="text-[10px]"
            >
              {t(`roles.${ROLE_KEY[me.data.role]}`)}
            </Badge>
          </div>
        ) : null}
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('topBar.toggleTheme')}
          title={t('topBar.toggleTheme')}
          onClick={() => setTheme(isDark ? 'light' : 'dark')}
        >
          {isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </Button>
      </div>
    </header>
  )
}
