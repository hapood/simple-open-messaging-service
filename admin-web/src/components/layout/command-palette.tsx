import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Search } from 'lucide-react'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { useGlobalSearch } from '@/hooks/use-global-search'

/** ⌘K / Ctrl+K command palette — jump to a user (by account) or a federation peer (by domain).
 *  Self-contained: installs its own keydown listener and also opens on the 'open-command-palette'
 *  window event (fired by the TopBar search button), so it needs no props. Mounted once by AdminLayout. */
export function CommandPalette() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState('')
  const { data, isLoading } = useGlobalSearch(open ? input : '')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    const onOpen = () => setOpen(true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('open-command-palette', onOpen as EventListener)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('open-command-palette', onOpen as EventListener)
    }
  }, [])

  useEffect(() => {
    if (!open) setInput('')
  }, [open])

  const go = (path: string) => {
    navigate(path)
    setOpen(false)
  }

  const users = data?.users ?? []
  const peers = data?.peers ?? []
  const hasQuery = input.trim().length > 0
  const empty = hasQuery && !isLoading && users.length === 0 && peers.length === 0

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-xl gap-0 p-0">
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="size-4 text-muted-foreground" />
          <Input
            autoFocus
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t('search.placeholder')}
            className="h-12 border-0 px-0 shadow-none focus-visible:ring-0"
          />
        </div>
        <div className="max-h-80 overflow-y-auto p-2">
          {!hasQuery ? (
            <div className="px-2 py-6 text-center text-sm text-muted-foreground">{t('search.hint')}</div>
          ) : isLoading ? (
            <div className="flex flex-col gap-2 p-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : empty ? (
            <div className="px-2 py-6 text-center text-sm text-muted-foreground">{t('search.empty')}</div>
          ) : (
            <>
              {users.length > 0 ? (
                <Section label={t('search.section.users')}>
                  {users.map((u) => (
                    <ResultRow
                      key={`u${u.id}`}
                      title={u.account}
                      sub={`#${u.id}`}
                      onClick={() => go(`/users/${u.id}`)}
                    />
                  ))}
                </Section>
              ) : null}
              {peers.length > 0 ? (
                <Section label={t('search.section.peers')}>
                  {peers.map((p) => (
                    <ResultRow
                      key={`p${p.domain}`}
                      title={p.domain}
                      sub={p.trustLevel}
                      mono
                      onClick={() => go(`/federation/${encodeURIComponent(p.domain)}`)}
                    />
                  ))}
                </Section>
              ) : null}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-1">
      <div className="px-2 py-1 text-xs font-medium text-muted-foreground">{label}</div>
      {children}
    </div>
  )
}

function ResultRow({
  title,
  sub,
  mono,
  onClick,
}: {
  title: string
  sub?: string
  mono?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center justify-between rounded-md px-2 py-2 text-left text-sm hover:bg-muted"
    >
      <span className={mono ? 'font-mono' : undefined}>{title}</span>
      {sub ? <span className="text-xs text-muted-foreground">{sub}</span> : null}
    </button>
  )
}
