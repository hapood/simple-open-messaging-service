import { ShieldOff } from 'lucide-react'
import { useBans, useUnban } from '@/hooks/use-bans'
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

export function BansPage() {
  const { data, isLoading, error } = useBans()
  const unban = useUnban()

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">封禁管理</h1>
        <p className="text-sm text-muted-foreground">
          当前生效的登录封禁（IP / 账户维度，由限流滑窗产生）。
        </p>
      </div>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-20">类型</TableHead>
              <TableHead>值</TableHead>
              <TableHead>解禁时间</TableHead>
              <TableHead className="w-24">剩余</TableHead>
              <TableHead className="w-20" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={5}>
                  <Skeleton className="h-5 w-full" />
                </TableCell>
              </TableRow>
            ) : error ? (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-destructive">
                  加载失败：{error.message}
                </TableCell>
              </TableRow>
            ) : !data || data.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                  <ShieldOff className="mx-auto mb-2 size-5 opacity-40" />
                  当前无封禁
                </TableCell>
              </TableRow>
            ) : (
              data.map((b) => (
                <TableRow key={b.key}>
                  <TableCell>
                    <Badge variant={b.type === 'ip' ? 'default' : 'secondary'}>
                      {b.type === 'ip' ? 'IP' : '账户'}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{b.value}</TableCell>
                  <TableCell>
                    <Timestamp value={b.until} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {Math.ceil(b.remainingMs / 1000)}s
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={unban.isPending}
                      onClick={() =>
                        unban.mutate(b.type === 'ip' ? { ip: b.value } : { uniqName: b.value })
                      }
                    >
                      解封
                    </Button>
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
