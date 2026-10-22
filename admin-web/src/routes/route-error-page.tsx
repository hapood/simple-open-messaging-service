import { useTranslation } from 'react-i18next'
import { useNavigate, useRouteError } from 'react-router-dom'
import { Button } from '@/components/ui/button'

export function RouteErrorPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const error = useRouteError()
  const detail = error instanceof Error ? error.message : String(error)

  return (
    <main className="flex min-h-svh items-center justify-center bg-background p-6">
      <div className="w-full max-w-lg rounded-xl border bg-card p-6 shadow-sm">
        <h1 className="text-xl font-semibold">{t('routeError.title')}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t('routeError.desc')}</p>
        {import.meta.env.DEV ? (
          <pre className="mt-4 max-h-40 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">
            {detail}
          </pre>
        ) : null}
        <div className="mt-5 flex gap-2">
          <Button onClick={() => window.location.reload()}>{t('routeError.reload')}</Button>
          <Button variant="outline" onClick={() => navigate('/')}>
            {t('routeError.home')}
          </Button>
        </div>
      </div>
    </main>
  )
}
