import { type ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { BellRing, LogOut, Monitor, ShieldBan, ShieldCheck, Users } from 'lucide-react'
import { useAuth } from '@/auth/auth-context'
import { Button } from '@/components/ui/button'

const NAV = [
  { to: '/users', label: '用户管理', icon: Users },
  { to: '/sessions', label: '会话总览', icon: Monitor },
  { to: '/admin-sessions', label: '管理员会话', icon: ShieldCheck },
  { to: '/bans', label: '封禁管理', icon: ShieldBan },
  { to: '/reuse', label: '重用告警', icon: BellRing },
]

export function AdminLayout({ children }: { children: ReactNode }) {
  const { logout } = useAuth()
  return (
    <div className="flex min-h-svh bg-background">
      <aside className="flex w-56 shrink-0 flex-col gap-1 border-r bg-sidebar p-4 text-sidebar-foreground">
        <div className="px-2 py-3 text-lg font-semibold tracking-tight">Admin 控制台</div>
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
              {it.label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto">
          <Button variant="ghost" className="w-full justify-start gap-2" onClick={logout}>
            <LogOut className="size-4" />
            登出
          </Button>
        </div>
      </aside>
      <main className="flex-1 overflow-auto">
        <div className="mx-auto max-w-6xl p-6">{children}</div>
      </main>
    </div>
  )
}
