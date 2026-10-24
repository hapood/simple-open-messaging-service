import { Link } from 'react-router-dom';
import { TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useBreakers } from '@/hooks/use-quota';

/** Compact cross-domain alert; detailed quota operations have one dedicated overview. */
export function BreakerBanner() {
  const { t } = useTranslation();
  const breakers = useBreakers();
  const peers = breakers.data?.peers.length ?? 0;
  const users = breakers.data?.users.length ?? 0;
  if (!peers && !users) return null;
  return (
    <div
      role="alert"
      className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm leading-[20px]"
    >
      <TriangleAlert className="size-4 shrink-0 text-destructive" />
      <span>{t('quota.breaker.bannerBody', { peers, users })}</span>
      <Link to="/quota" className="text-primary underline">
        {t('quota.breaker.review')}
      </Link>
    </div>
  );
}
