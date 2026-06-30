import { useState } from 'react'
import { Search } from 'lucide-react'
import { toast } from 'sonner'
import { useAllSessions, usePurgeSessions } from '@/hooks/use-sessions'
import { ApiError } from '@/lib/api-error'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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

export function SessionsPage() {
  const [ipSearch, setIpSearch] = useState('')
  const [page, setPage] = useState(0)
  const [purgeOpen, setPurgeOpen] = useState(false)
  const { data, isLoading, error } = useAllSessions({
    skip: page * PAGE_SIZE,
    take: PAGE_SIZE,
    ip: ipSearch || undefined,
  })
  const purge = usePurgeSessions()

  const total = data?.total ?? 0
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const onPurge = async () => {
    try {
      const r = await purge.mutateAsync()
      toast.success(`已清理全部活跃会话（${r.purgedUsers} 个用户被强制重登）`)
      setPurgeOpen(false)
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : '清理失败')
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">会话总览</h1>
        <div className="flex items-center gap-2">
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
          <Button variant="destructive" onClick={() => setPurgeOpen(true)} disabled={total === 0}>
            一键清理
          </Button>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        所有用户的活跃 refresh 会话（未吊销且未过期）。共 {total} 条。
      </p>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>用户</TableHead>
              <TableHead>device</TableHead>
              <TableHead>User-Agent</TableHead>
              <TableHead>IP</TableHead>
              <TableHead>创建</TableHead>
              <TableHead>过期</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 8 }).map((_, i) => (
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
                  无活跃会话
                </TableCell>
              </TableRow>
            ) : (
              data?.list.map((s) => (
                <TableRow key={s.jti}>
                  <TableCell className="font-medium">
                    {s.user?.uniqName ?? '#' + s.userId}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{s.device ?? '—'}</Badge>
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

      <Dialog open={purgeOpen} onOpenChange={setPurgeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>清理所有活跃会话？</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            将吊销全部 {total} 条活跃会话，所有用户被强制重登（access 立即失效）。此操作不可撤销。
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPurgeOpen(false)} disabled={purge.isPending}>
              取消
            </Button>
            <Button variant="destructive" onClick={onPurge} disabled={purge.isPending}>
              确认清理
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
