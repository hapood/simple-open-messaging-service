import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useServerKeys } from '@/hooks/use-settings';
import { formatApiError } from '@/lib/format-error';
import { ServerKeyCard } from './server-key-card';

export function ServerKeysPage() {
  const { t } = useTranslation();
  const keys = useServerKeys();
  return (
    <div className="flex flex-col gap-4 leading-[20px]">
      <h1 className="text-2xl font-semibold leading-[32px]">
        {t('credentials.title')}
      </h1>
      <p className="text-sm text-muted-foreground">
        {t('credentials.inventoryDesc')}
      </p>
      <Link className="text-sm underline" to="/push/config">
        {t('push.title')} · {t('credentials.channels')}
      </Link>
      {keys.isPending ? (
        <Loader2 className="size-4 animate-spin" />
      ) : keys.error ? (
        <p role="alert" className="text-sm text-destructive">
          {formatApiError(keys.error)}
        </p>
      ) : (
        keys.data
          ?.filter(
            (key) =>
              key.id !== 'vapid' && key.id !== 'firebase-service-account',
          )
          .map((key) => <ServerKeyCard key={key.id} item={key} />)
      )}
    </div>
  );
}
