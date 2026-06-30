import { useState } from 'react'
import { Search } from 'lucide-react'
import { toast } from 'sonner'
import { useAdminSessions, useRevokeAdminSession } from '@/hooks/use-admin-sessions'
import { ApiError } from '@/lib/api-error'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Timestamp } from '@/components/common/timestamp'

const PAGE_SIZE = 50

export function AdminSessionsPage() {
  const [ipSearch, setIpSearch] = useState('')
  const [page, setPage] = useState(0)
  const { data, isLoading, error } = useAdminSessions({
    skip: page * PAGE_SIZE,
    take: PAGE_SIZE,
    ip: ipSearch || undefined,
  })
  const revoke = useRevokeAdminSession()

  const total = data?.total ?? 0
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const onRevoke = async (jti: string) => {
    try {
      await revoke.mutateAsync(jti)
      toast.success('已吊销该管理员会话（其 access 15m 内仍有效）')
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : '吊销失败')
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">管理员会话</h1>
        <div className="relative w-60">
          <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input
            placeholder="按 IP 筛选"
            value={ipSearch}
            onChange={(e) => {
              setIpSearch(e.target.value)
              setPage(0)
            }}
            className="pl-8"
          />
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        管理员的活跃 refresh 会话（独立 AdminRefreshToken 表，与用户会话物理隔离）。共 {total} 条。
        吊销后该 admin 的 refresh 立即失效，但其 access 在 15m 内仍有效（admin 无 tokenVersion）。
      </p>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>管理员</TableHead>
              <TableHead>User-Agent</TableHead>
              <TableHead>IP</TableHead>
              <TableHead>创建</TableHead>
              <TableHead>过期</TableHead>
              <TableHead className="w-20" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 6 }).map((_, i) => (
                <TableRow key={i}>
                  {Array.from({ length: 6 }).map((__, j) => (
                    <TableCell key={j}>
                      <Skeleton className="h-5 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : error ? (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-destructive">
                  加载失败：{error.message}
                </TableCell>
              </TableRow>
            ) : data?.list.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                  无活跃管理员会话
                </TableCell>
              </TableRow>
            ) : (
              data?.list.map((s) => (
                <TableRow key={s.jti}>
                  <TableCell className="font-medium">
                    <Badge variant="outline">{s.admin?.username ?? '#' + s.adminId}</Badge>
                  </TableCell>
                  <TableCell
                    className="max-w-[280px] truncate text-xs text-muted-foreground"
                    title={s.userAgent ?? ''}
                  >
                    {s.userAgent ?? '—'}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{s.ip ?? '—'}</TableCell>
                  <TableCell>
                    <Timestamp value={s.createdAt} />
                  </TableCell>
                  <TableCell>
                    <Timestamp value={s.expiresAt} />
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-destructive"
                      disabled={revoke.isPending}
                      onClick={() => onRevoke(s.jti)}
                    >
                      吊销
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center justify-end gap-2 text-sm text-muted-foreground">
        <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
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
  )
}
