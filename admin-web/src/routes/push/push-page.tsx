import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
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
import { formatApiError } from '@/lib/format-error'

const PAGE_SIZE = 15

export function PushPage() {
  const { t } = useTranslation()
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [page, setPage] = useState(0)

  // Debounce the search input (300ms) and reset to the first page whenever it changes.
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(search.trim())
      setPage(0)
    }, 300)
    return () => clearTimeout(timer)
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

  function openTest(token: PushToken) {
    setTestToken(token)
    setTitle(t('push.testDefaultTitle'))
    setBody('')
  }

  async function onSubmitTest() {
    if (!testToken) return
    const r = await sendTest.mutateAsync({ id: testToken.id, title, body })
    if (r.ok) toast.success(t('push.testSent'))
    else toast.error(t('push.testFailed', { reason: r.error ?? t('push.testFailedUnknown') }))
    setTestToken(null)
  }

  function onDelete(token: PushToken) {
    del.mutate(token.id, {
      onSuccess: () =>
        toast.success(t('push.deleted', { name: token.user?.account ?? '' })),
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
        <h1 className="text-2xl font-semibold tracking-tight">{t('push.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('push.desc')}</p>
      </div>

      {/* transport config status + total */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">{t('push.transportLabel')}</span>
        <Badge variant={data?.fcmConfigured ? 'default' : 'outline'}>
          FCM {data?.fcmConfigured ? t('push.configured') : t('push.notConfigured')}
        </Badge>
        <Badge variant={data?.webPushConfigured ? 'default' : 'outline'}>
          Web Push {data?.webPushConfigured ? t('push.configured') : t('push.notConfigured')}
        </Badge>
        <span className="ml-auto text-muted-foreground">
          {t('push.deviceCount', { count: total })}
        </span>
      </div>

      <Input
        value={search}
        onChange={(e) => setSearch((e.target as HTMLInputElement).value)}
        placeholder={t('push.searchPlaceholder')}
        className="max-w-sm"
      />

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-32">{t('push.col.platform')}</TableHead>
              <TableHead>{t('push.col.user')}</TableHead>
              <TableHead>{t('push.col.token')}</TableHead>
              <TableHead className="w-44">{t('push.col.lastSeen')}</TableHead>
              <TableHead className="w-36" />
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
                  {t('common.loadFailed', { message: formatApiError(error) })}
                </TableCell>
              </TableRow>
            ) : list.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                  <Smartphone className="mx-auto mb-2 size-5 opacity-40" />
                  {t('push.empty')}
                </TableCell>
              </TableRow>
            ) : (
              list.map((token) => (
                <TableRow key={token.id}>
                  <TableCell>
                    <Badge variant="secondary">{t(`push.platform.${token.platform}`)}</Badge>
                  </TableCell>
                  <TableCell>
                    {token.user?.account ?? (
                      <span className="text-muted-foreground">#{token.userId}</span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {shortToken(token.token)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    <Timestamp value={token.lastSeenAt} />
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button variant="outline" size="sm" onClick={() => openTest(token)}>
                        <Send className="size-3.5" />
                        {t('push.test')}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={del.isPending}
                        onClick={() => onDelete(token)}
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
          {isFetching
            ? t('common.loading')
            : total === 0
              ? t('common.noData')
              : t('push.range', { from, to, total })}
        </span>
        <div className="ml-auto flex gap-2">
          <Button variant="outline" size="sm" disabled={!canPrev} onClick={() => setPage((p) => p - 1)}>
            {t('common.previous')}
          </Button>
          <Button variant="outline" size="sm" disabled={!canNext} onClick={() => setPage((p) => p + 1)}>
            {t('common.next')}
          </Button>
        </div>
      </div>

      {/* test push dialog */}
      <Dialog open={testToken !== null} onOpenChange={(o) => !o && setTestToken(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('push.testDialogTitle')}</DialogTitle>
            <DialogDescription>
              {t('push.testDialogDesc', {
                target: testToken?.user?.account
                  ? t('push.testDialogTargetUser', { name: testToken.user.account })
                  : t('push.testDialogTargetDevice'),
                platform: t(`push.platform.${testToken?.platform ?? 'ANDROID'}`),
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-sm">{t('push.testTitleLabel')}</label>
              <Input value={title} onChange={(e) => setTitle((e.target as HTMLInputElement).value)} />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-sm">{t('push.testBodyLabel')}</label>
              <Input
                value={body}
                onChange={(e) => setBody((e.target as HTMLInputElement).value)}
                placeholder="from admin console"
              />
            </div>
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>{t('common.cancel')}</DialogClose>
            <Button onClick={onSubmitTest} disabled={sendTest.isPending || !title.trim()}>
              {sendTest.isPending && <Loader2 className="size-3.5 animate-spin" />}
              {t('push.send')}
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
