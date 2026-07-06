import { useEffect, useState } from 'react'
import { Loader2, Send, Smartphone, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useDeletePushToken, usePushTokens, useSendPushTest } from '@/hooks/use-push'
import type { PushToken } from '@/types/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Timestamp } from '@/components/common/timestamp'

const PAGE_SIZE = 15

const PLATFORM_LABEL: Record<PushToken['platform'], string> = {
  ANDROID: 'Android · FCM',
  IOS: 'iOS · FCM',
  WEB: 'Web Push',
}

export function PushPage() {
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [page, setPage] = useState(0)

  // Debounce the search input (300ms) and reset to the first page whenever it changes.
  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(search.trim())
      setPage(0)
    }, 300)
    return () => clearTimeout(t)
  }, [search])

  const { data, isLoading, error, isFetching } = usePushTokens({
    skip: page * PAGE_SIZE,
    take: PAGE_SIZE,
    search: debounced || undefined,
  })
  const del = useDeletePushToken()
  const sendTest = useSendPushTest()

  const [testToken, setTestToken] = useState<PushToken | null>(null)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')

  function openTest(t: PushToken) {
    setTestToken(t)
    setTitle('SOMS 测试推送')
    setBody('')
  }

  async function onSubmitTest() {
    if (!testToken) return
    const r = await sendTest.mutateAsync({ id: testToken.id, title, body })
    if (r.ok) toast.success('测试推送已发送')
    else toast.error(`发送失败：${r.error ?? '未知原因'}`)
    setTestToken(null)
  }

  function onDelete(t: PushToken) {
    del.mutate(t.id, {
      onSuccess: () => toast.success(`已删除 ${t.user?.uniqName ?? ''} 的设备 token`),
    })
  }

  const list = data?.list ?? []
  const total = data?.total ?? 0
  const from = total === 0 ? 0 : page * PAGE_SIZE + 1
  const to = Math.min((page + 1) * PAGE_SIZE, total)
  const canPrev = page > 0
  const canNext = to < total

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">推送管理</h1>
        <p className="text-sm text-muted-foreground">
          已注册的推送设备 token（FCM / Web Push）+ 测试推送 + 通道配置状态。
        </p>
      </div>

      {/* transport config status + total */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">通道状态：</span>
        <Badge variant={data?.fcmConfigured ? 'default' : 'outline'}>
          FCM {data?.fcmConfigured ? '已配置' : '未配置'}
        </Badge>
        <Badge variant={data?.webPushConfigured ? 'default' : 'outline'}>
          Web Push {data?.webPushConfigured ? '已配置' : '未配置'}
        </Badge>
        <span className="ml-auto text-muted-foreground">共 {total} 个设备</span>
      </div>

      <Input
        value={search}
        onChange={(e) => setSearch((e.target as HTMLInputElement).value)}
        placeholder="按用户名 / token / deviceId 搜索"
        className="max-w-sm"
      />

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-32">平台</TableHead>
              <TableHead>用户</TableHead>
              <TableHead>Token</TableHead>
              <TableHead className="w-44">最近活跃</TableHead>
              <TableHead className="w-36" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={5}><Skeleton className="h-5 w-full" /></TableCell>
              </TableRow>
            ) : error ? (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-destructive">
                  加载失败：{error.message}
                </TableCell>
              </TableRow>
            ) : list.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                  <Smartphone className="mx-auto mb-2 size-5 opacity-40" />
                  无匹配的设备 token
                </TableCell>
              </TableRow>
            ) : (
              list.map((t) => (
                <TableRow key={t.id}>
                  <TableCell><Badge variant="secondary">{PLATFORM_LABEL[t.platform]}</Badge></TableCell>
                  <TableCell>
                    {t.user?.uniqName ?? <span className="text-muted-foreground">#{t.userId}</span>}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {shortToken(t.token)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    <Timestamp value={t.lastSeenAt} />
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button variant="outline" size="sm" onClick={() => openTest(t)}>
                        <Send className="size-3.5" />
                        测试
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={del.isPending}
                        onClick={() => onDelete(t)}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span>
          {isFetching ? '加载中…' : total === 0 ? '无数据' : `第 ${from}-${to} 条 / 共 ${total} 条`}
        </span>
        <div className="ml-auto flex gap-2">
          <Button variant="outline" size="sm" disabled={!canPrev} onClick={() => setPage((p) => p - 1)}>
            上一页
          </Button>
          <Button variant="outline" size="sm" disabled={!canNext} onClick={() => setPage((p) => p + 1)}>
            下一页
          </Button>
        </div>
      </div>

      {/* test push dialog */}
      <Dialog open={testToken !== null} onOpenChange={(o) => !o && setTestToken(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>发送测试推送</DialogTitle>
            <DialogDescription>
              向{testToken?.user?.uniqName ? `用户 ${testToken.user.uniqName}` : '该设备'}的
              {' '}{PLATFORM_LABEL[testToken?.platform ?? 'ANDROID']}{' '}
              发送一条测试通知（设备需在后台才能收到系统通知）。
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-sm">标题</label>
              <Input value={title} onChange={(e) => setTitle((e.target as HTMLInputElement).value)} />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-sm">正文（可选）</label>
              <Input
                value={body}
                onChange={(e) => setBody((e.target as HTMLInputElement).value)}
                placeholder="from admin console"
              />
            </div>
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>取消</DialogClose>
            <Button onClick={onSubmitTest} disabled={sendTest.isPending || !title.trim()}>
              {sendTest.isPending && <Loader2 className="size-3.5 animate-spin" />}
              发送
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** Truncate a long push token / endpoint URL for table display. */
function shortToken(token: string): string {
  if (token.length <= 24) return token
  return token.slice(0, 12) + '…' + token.slice(-8)
}
