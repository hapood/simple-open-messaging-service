import { type ReactNode, useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  ChevronDown,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/auth/auth-context';
import { useMe } from '@/hooks/use-me';
import { Badge } from '@/components/ui/badge';
import { NAV_GROUPS, type NavItem } from '@/components/layout/nav-config';
import { TopBar } from '@/components/layout/top-bar';
import { BreakerBanner } from '@/components/admin/breaker-banner';
import { cn } from '@/lib/utils';

/** Collapsed rail width is also stored so the top bar toggle keeps the same state. */
export const NAV_COLLAPSED_KEY = 'soms.admin.nav.collapsed';
export const NAV_GROUPS_COLLAPSED_KEY = 'soms.admin.nav.groups.collapsed';

export function AdminLayout({ children }: { children: ReactNode }) {
  const { logout } = useAuth();
  const { t } = useTranslation();
  const { data: me } = useMe();
  const { pathname } = useLocation();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // Desktop rail collapse only; the mobile drawer always shows the full menu.
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(NAV_COLLAPSED_KEY) === '1',
  );
  const [collapsedGroups, setCollapsedGroups] = useState<
    Record<string, boolean>
  >(() => {
    try {
      const raw = localStorage.getItem(NAV_GROUPS_COLLAPSED_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });

  useEffect(() => setMobileNavOpen(false), [pathname]);
  useEffect(() => {
    localStorage.setItem(NAV_COLLAPSED_KEY, collapsed ? '1' : '0');
  }, [collapsed]);

  const toggleGroup = (groupKey: string) => {
    setCollapsedGroups((prev) => {
      const next = { ...prev, [groupKey]: !prev[groupKey] };
      try {
        localStorage.setItem(NAV_GROUPS_COLLAPSED_KEY, JSON.stringify(next));
      } catch {
        // ignore storage quota errors
      }
      return next;
    });
  };

  return (
    <div className="flex h-svh overflow-hidden bg-background">
      {mobileNavOpen ? (
        <button
          type="button"
          aria-label={t('topBar.closeNavigation')}
          className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[1px] lg:hidden"
          onClick={() => setMobileNavOpen(false)}
        />
      ) : null}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar p-3 text-sidebar-foreground shadow-xl transition-[width,padding,transform] duration-300 ease-in-out lg:static lg:translate-x-0 lg:shadow-none',
          collapsed ? 'lg:w-16 lg:p-2' : 'lg:w-60 lg:p-3',
          mobileNavOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        {/* Header in Collapsed Mode (Desktop only) */}
        {collapsed ? (
          <div className="hidden lg:flex flex-col items-center gap-2 pb-2.5 border-b border-sidebar-border/60">
            <img
              src={`${import.meta.env.BASE_URL}favicon.svg`}
              alt=""
              aria-hidden="true"
              className="size-7 rounded-lg ring-1 ring-border/20 shadow-2xs shrink-0"
            />
            <button
              type="button"
              onClick={() => setCollapsed(false)}
              aria-label={t('nav.expand')}
              title={t('nav.expand')}
              className="flex size-7 items-center justify-center rounded-md border border-sidebar-border/70 bg-sidebar-accent/30 text-sidebar-foreground/70 shadow-2xs hover:bg-sidebar-accent hover:text-sidebar-foreground hover:border-sidebar-border transition-all duration-200 active:scale-95 cursor-pointer"
            >
              <PanelLeftOpen className="size-3.5" />
            </button>
          </div>
        ) : null}

        {/* Header in Expanded Mode (Mobile + Desktop Expanded) */}
        <div
          className={cn(
            'flex items-center gap-2.5 pb-2.5 border-b border-sidebar-border/60',
            collapsed && 'lg:hidden',
          )}
        >
          <img
            src={`${import.meta.env.BASE_URL}favicon.svg`}
            alt=""
            aria-hidden="true"
            className="size-7 rounded-lg ring-1 ring-border/20 shadow-2xs shrink-0"
          />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold tracking-tight text-sidebar-foreground">
              {t('common.appName')}
            </div>
            {me?.somsDomain ? (
              <Badge
                variant="outline"
                className="mt-0.5 max-w-full truncate font-mono text-[10px] px-1.5 py-0 h-4 border-sidebar-border/70 text-muted-foreground"
              >
                {me.somsDomain}
              </Badge>
            ) : null}
          </div>
          {/* Desktop collapse button */}
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            aria-label={t('nav.collapse')}
            title={t('nav.collapse')}
            className="hidden lg:flex size-7 shrink-0 items-center justify-center rounded-md border border-sidebar-border/70 bg-sidebar-accent/30 text-sidebar-foreground/70 shadow-2xs hover:bg-sidebar-accent hover:text-sidebar-foreground hover:border-sidebar-border transition-all duration-200 active:scale-95 cursor-pointer"
          >
            <PanelLeftClose className="size-3.5" />
          </button>
          {/* Mobile close button */}
          <button
            type="button"
            onClick={() => setMobileNavOpen(false)}
            aria-label={t('topBar.closeNavigation')}
            title={t('topBar.closeNavigation')}
            className="lg:hidden flex size-7 shrink-0 items-center justify-center rounded-md border border-sidebar-border/70 bg-sidebar-accent/30 text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-all duration-200 cursor-pointer"
          >
            <X className="size-3.5" />
          </button>
        </div>

        {/* Navigation list with custom slim scrollbar */}
        <nav className="mt-2 flex flex-1 min-h-0 flex-col gap-3 overflow-y-auto overflow-x-hidden sidebar-scroll">
          {NAV_GROUPS.filter((g) => !g.footer).map((group) => {
            const isGroupCollapsed =
              !collapsed && !!collapsedGroups[group.labelKey];
            return (
              <div key={group.labelKey} className="flex flex-col gap-1">
                {collapsed ? (
                  <div className="my-1 border-t border-sidebar-border/40 mx-1.5" />
                ) : (
                  <button
                    type="button"
                    onClick={() => toggleGroup(group.labelKey)}
                    className="group/group-btn flex items-center justify-between px-2.5 py-1 text-xs font-semibold tracking-wider text-muted-foreground/80 uppercase hover:text-sidebar-foreground transition-colors cursor-pointer rounded-md hover:bg-sidebar-accent/40 select-none"
                  >
                    <span>{t(group.labelKey)}</span>
                    <ChevronDown
                      className={cn(
                        'size-3.5 transition-transform duration-200 text-muted-foreground/60 group-hover/group-btn:text-sidebar-foreground',
                        isGroupCollapsed && '-rotate-90',
                      )}
                    />
                  </button>
                )}
                {!isGroupCollapsed && (
                  <div className="flex flex-col gap-1">
                    {group.items.map((item) => (
                      <NavEntry
                        key={item.to}
                        item={item}
                        collapsed={collapsed}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        {/* Footer with My Account and Logout - perfectly aligned */}
        <div className="mt-auto flex flex-col gap-1 border-t border-sidebar-border/60 pt-2 shrink-0">
          {NAV_GROUPS.filter((g) => g.footer)
            .flatMap((g) => g.items)
            .map((item) => (
              <NavEntry key={item.to} item={item} collapsed={collapsed} />
            ))}
          <button
            type="button"
            className={cn(
              'group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium text-sidebar-foreground/80 hover:bg-destructive/10 hover:text-destructive transition-all duration-150 cursor-pointer active:scale-95',
              collapsed
                ? 'lg:size-9 lg:p-0 lg:justify-center lg:mx-auto'
                : 'h-9 w-full justify-start',
            )}
            aria-label={t('nav.logout')}
            title={t('nav.logout')}
            onClick={logout}
          >
            <LogOut className="size-4 shrink-0 transition-transform group-hover:scale-105" />
            <span
              className={cn('truncate leading-5', collapsed && 'lg:hidden')}
            >
              {t('nav.logout')}
            </span>
          </button>
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <TopBar onOpenNavigation={() => setMobileNavOpen(true)} />
        <main className="min-h-0 flex-1 overflow-auto">
          <div className="mx-auto w-full max-w-[1440px] p-4 sm:p-6 lg:px-8">
            <BreakerBanner />
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

function NavEntry({ item, collapsed }: { item: NavItem; collapsed: boolean }) {
  const { t } = useTranslation();
  const label = t(`nav.${item.key}`);
  if (item.disabled) {
    return (
      <span
        aria-disabled
        title={t('common.comingSoon')}
        className={cn(
          'flex cursor-not-allowed items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-muted-foreground/40 select-none',
          collapsed
            ? 'lg:size-9 lg:p-0 lg:justify-center lg:mx-auto'
            : 'h-9 w-full justify-start',
        )}
      >
        <item.icon className="size-4 shrink-0 opacity-60" />
        <span className={cn('truncate leading-5', collapsed && 'lg:hidden')}>
          {label}
        </span>
      </span>
    );
  }
  return (
    <NavLink
      to={item.to}
      end={item.end}
      title={label}
      className={({ isActive }) =>
        cn(
          'group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-all duration-150',
          collapsed
            ? 'lg:size-9 lg:p-0 lg:justify-center lg:mx-auto'
            : 'h-9 w-full justify-start',
          isActive
            ? 'bg-sidebar-accent text-sidebar-accent-foreground font-semibold shadow-2xs'
            : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
        )
      }
    >
      <item.icon className="size-4 shrink-0 transition-transform group-hover:scale-105" />
      <span className={cn('truncate leading-5', collapsed && 'lg:hidden')}>
        {label}
      </span>
    </NavLink>
  );
}
