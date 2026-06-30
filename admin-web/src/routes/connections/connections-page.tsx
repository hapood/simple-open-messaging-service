import dayjs from 'dayjs'
import { useConnections } from '@/hooks/use-connections'
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
import { Timestamp } from '@/components/common/timestamp'

/** 毫秒 → 紧凑时长 "1d 2h" / "5m 10s" / "12s" */
function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}

export function ConnectionsPage() {
  const { data, isLoading, error, dataUpdatedAt } = useConnections()
  const total = data?.total ?? 0
  const uniqueUsers = data?.uniqueUsers ?? 0
  const clients = data?.clients ?? []

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">实时连接</h1>
          <span className="inline-flex items-center gap-1.5 rounded-full border bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
            <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
            LIVE
          </span>
        </div>
        {dataUpdatedAt ? (
          <span className="text-xs text-muted-foreground">
            更新于 {dayjs(dataUpdatedAt).format('HH:mm:ss')}（每 3s 自动刷新）
          </span>
        ) : null}
      </div>

      <p className="text-sm text-muted-foreground">
        当前在线的 SSE 实时下行连接（内存态，按用户聚合）。与「会话总览」不同：这里只看此刻挂着的长连接，不看持久的登录会话。
      </p>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-2">
        <div className="rounded-md border p-4">
          <div className="text-sm text-muted-foreground">总连接数</div>
          <div className="mt-1 text-3xl font-semibold tabular-nums">{total}</div>
        </div>
        <div className="rounded-md border p-4">
          <div className="text-sm text-muted-foreground">在线用户</div>
          <div className="mt-1 text-3xl font-semibold tabular-nums">{uniqueUsers}</div>
        </div>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>用户</TableHead>
              <TableHead className="w-32">连接数</TableHead>
              <TableHead className="w-48">建连时刻</TableHead>
              <TableHead className="w-32">已连接</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  {Array.from({ length: 4 }).map((__, j) => (
                    <TableCell key={j}>
                      <Skeleton className="h-5 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : error ? (
              <TableRow>
                <TableCell colSpan={4} className="py-8 text-center text-destructive">
                  加载失败：{error.message}
                </TableCell>
              </TableRow>
            ) : clients.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                  当前无在线连接
                </TableCell>
              </TableRow>
            ) : (
              clients.map((c) => (
                <TableRow key={c.userId}>
                  <TableCell className="font-medium">
                    {c.uniqName ?? '#' + c.userId}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary" className="tabular-nums">
                      {c.connections}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Timestamp value={c.since} />
                  </TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">
                    {formatDuration(Date.now() - c.since)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
