import {
  Dialog,
  DialogContent,
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
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Timestamp } from '@/components/common/timestamp'
import { useUserSessions } from '@/hooks/use-user-mutations'
import type { User } from '@/types/api'

export function SessionsDialog({
  user,
  onClose,
}: {
  user: User | null
  onClose: () => void
}) {
  const { data, isLoading, error } = useUserSessions(user?.id ?? null)
  const open = user !== null
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{user?.uniqName} 的活跃会话</DialogTitle>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>device</TableHead>
                <TableHead>User-Agent</TableHead>
                <TableHead>IP</TableHead>
                <TableHead>创建</TableHead>
                <TableHead>过期</TableHead>
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
                  <TableCell colSpan={5} className="text-destructive">
                    加载失败
                  </TableCell>
                </TableRow>
              ) : !data || data.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-6 text-center text-muted-foreground">
                    无活跃会话
                  </TableCell>
                </TableRow>
              ) : (
                data.map((s) => (
                  <TableRow key={s.jti}>
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
      </DialogContent>
    </Dialog>
  )
}
