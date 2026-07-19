import { NavLink } from 'react-router-dom'
import { cn } from '@/lib/utils'

export interface RouteTab {
  /** Absolute path the tab navigates to. */
  to: string
  label: string
}

/**
 * A pill bar of route tabs for a multi-tab hub. Each entry is a <NavLink>, so the active tab IS the
 * current route — NavLink applies `aria-current="page"` automatically, and switching tabs is plain
 * navigation. Each tab therefore owns its own URL query namespace (search/pagination don't bleed
 * between tabs), every tab is deep-linkable, and the browser back button works.
 *
 * These are navigation links styled as tabs, NOT an ARIA `tablist`. There is no in-page `tabpanel`
 * to control — each tab is its own route rendered through the hub layout's <Outlet/> — so
 * `aria-current` is the correct active-state indicator, not `aria-selected` plus the arrow-key /
 * focus-management contract a real tablist would require.
 *
 * `end` makes a tab active only on an exact pathname match, so the index tab (e.g. /users) is not
 * also highlighted when a sibling tab (/users/operators) is active.
 */
export function RouteTabs({ tabs, className }: { tabs: RouteTab[]; className?: string }) {
  return (
    <nav
      aria-label="Tabs"
      className={cn(
        'inline-flex h-8 w-fit items-center justify-center gap-1 rounded-lg bg-muted p-[3px] text-muted-foreground',
        className,
      )}
    >
      {tabs.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end
          className={({ isActive }) =>
            cn(
              'inline-flex h-[calc(100%-1px)] items-center justify-center rounded-md px-3 py-0.5 text-sm font-medium whitespace-nowrap transition-all',
              isActive
                ? 'bg-background text-foreground shadow-sm'
                : 'text-foreground/60 hover:text-foreground',
            )
          }
        >
          {tab.label}
        </NavLink>
      ))}
    </nav>
  )
}
