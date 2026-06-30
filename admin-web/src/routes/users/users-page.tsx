import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { MoreHorizontal, Search } from 'lucide-react'
import { useAdminUsers } from '@/hooks/use-admin-users'
import {
  useDisableUser,
  useEnableUser,
  useForceLogoutUser,
} from '@/hooks/use-user-mutations'
import type { User } from '@/types/api'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Timestamp } from '@/components/common/timestamp'
import { SessionsDialog } from './sessions-dialog'
import { ResetPasswordDialog } from './reset-password-dialog'

const PAGE_SIZE = 20

export function UsersPage() {
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [page, setPage] = useState(0)
  const [sessionsUser, setSessionsUser] = useState<User | null>(null)
  const [resetUser, setResetUser] = useState<User | null>(null)

  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(search)
      setPage(0)
    }, 300)
    return () => clearTimeout(t)
  }, [search])

  const { data, isLoading, isFetching, error } = useAdminUsers({
    skip: page * PAGE_SIZE,
    take: PAGE_SIZE,
    search: debounced || undefined,
  })

  const disable = useDisableUser()
  const enable = useEnableUser()
  const forceLogout = useForceLogoutUser()

  const onAction = async (
    m: { mutateAsync: (id: number) => Promise<void> },
    id: number,
    msg: string,
  ) => {
    try {
      await m.mutateAsync(id)
      toast.success(msg)
    } catch {
      /* 全局 mutation onError 已 toast */
    }
  }

  const total = data?.total ?? 0
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">用户管理</h1>
        <div className="relative w-72">
          <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input
            placeholder="搜索 uniqName"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8"
          />
        </div>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">ID</TableHead>
              <TableHead>uniqName</TableHead>
              <TableHead>domain</TableHead>
              <TableHead className="w-16">外宾</TableHead>
              <TableHead className="w-20">状态</TableHead>
              <TableHead className="w-28">tokenVer</TableHead>
              <TableHead>创建时间</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 8 }).map((_, i) => (
                <TableRow key={i}>
                  {Array.from({ length: 8 }).map((__, j) => (
                    <TableCell key={j}>
                      <Skeleton className="h-5 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : error ? (
              <TableRow>
                <TableCell colSpan={8} className="py-8 text-center text-destructive">
                  加载失败：{error.message}
                </TableCell>
              </TableRow>
            ) : data?.list.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                  无数据
                </TableCell>
              </TableRow>
            ) : (
              data?.list.map((u) => (
                <TableRow key={u.id}>
                  <TableCell className="font-mono text-xs text-muted-foreground">{u.id}</TableCell>
                  <TableCell className="font-medium">{u.uniqName}</TableCell>
                  <TableCell className="text-muted-foreground">{u.domain ?? '—'}</TableCell>
                  <TableCell>{u.isForeigner ? '是' : '否'}</TableCell>
                  <TableCell>
                    {u.isDeleted ? (
                      <Badge variant="destructive">已封禁</Badge>
                    ) : (
                      <Badge variant="secondary">正常</Badge>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{u.tokenVersion}</TableCell>
                  <TableCell>
                    <Timestamp value={u.createdAt} />
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        className={buttonVariants({ variant: 'ghost', size: 'icon' })}
                        disabled={isFetching}
                      >
                        <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {u.isDeleted ? (
                          <DropdownMenuItem onClick={() => onAction(enable, u.id, '已解禁')}>
                            解禁
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={() => onAction(disable, u.id, '已封禁')}
                          >
                            封禁
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem
                          onClick={() => onAction(forceLogout, u.id, '已强制下线')}
                        >
                          强制下线
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setSessionsUser(u)}>
                          查看会话
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setResetUser(u)}>
                          重置密码
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>共 {total} 条</span>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page === 0}
            onClick={() => setPage((p) => p - 1)}
          >
            上一页
          </Button>
          <span>
            第 {page + 1} / {pageCount} 页
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page + 1 >= pageCount}
            onClick={() => setPage((p) => p + 1)}
          >
            下一页
          </Button>
        </div>
      </div>

      <SessionsDialog user={sessionsUser} onClose={() => setSessionsUser(null)} />
      <ResetPasswordDialog user={resetUser} onClose={() => setResetUser(null)} />
    </div>
  )
}
