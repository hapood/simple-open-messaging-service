import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'

export function NotFoundPage() {
  const navigate = useNavigate()
  const { t } = useTranslation()
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-4 bg-background">
      <p className="text-3xl font-semibold tracking-tight">{t('notFound.code')}</p>
      <p className="text-muted-foreground">{t('notFound.desc')}</p>
      <Button onClick={() => navigate('/users')}>{t('notFound.back')}</Button>
    </div>
  )
}
