import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useBans } from '@/hooks/use-bans';
import { useConnections } from '@/hooks/use-connections';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Timestamp } from '@/components/common/timestamp';
import { useObservationTime } from '@/hooks/use-observation-time';
import { accountRestrictions, BAN_LABEL_KEYS } from '@/routes/bans/ban-view';

/** Independent observations: credentials, account restrictions, and connectivity are not interchangeable. */
export function UserAccessStatus({
  userId,
  account,
  disabled,
  pushRegistrations,
}: {
  userId: number;
  account: string;
  disabled: boolean;
  pushRegistrations: number;
}) {
  const { t } = useTranslation();
  const bans = useBans();
  const connections = useConnections();
  const now = useObservationTime();
  const restrictions = accountRestrictions(bans.data ?? [], account, now);
  const count =
    connections.data?.clients.find((client) => client.userId === userId)
      ?.connections ?? 0;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('userAccess.title')}</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4 text-sm leading-[20px] sm:grid-cols-2">
        <section>
          <h3 className="font-medium">{t('userAccess.account')}</h3>
          <p>{t(disabled ? 'users.status.banned' : 'users.status.active')}</p>
        </section>
        <section>
          <h3 className="font-medium">{t('userAccess.restrictions')}</h3>
          <p>
            {t(
              bans.error
                ? 'userAccess.unavailable'
                : bans.isLoading
                  ? 'common.loading'
                  : restrictions.length
                    ? 'userAccess.restricted'
                    : 'userAccess.unrestricted',
            )}
          </p>
          {!bans.error && !bans.isLoading && restrictions.length > 0 && (
            <ul className="my-2 space-y-1">
              {restrictions.map((ban) => (
                <li key={ban.key}>
                  {t(BAN_LABEL_KEYS[ban.type])} ·{' '}
                  {t('bans.remainingMinutes', {
                    count: Math.max(1, Math.ceil((ban.until - now) / 60000)),
                  })}
                </li>
              ))}
            </ul>
          )}
          <p className="text-muted-foreground">
            {t('userAccess.restrictionScope')}
          </p>
          <Link
            className="text-primary hover:underline"
            to={`/bans?q=${encodeURIComponent(account)}`}
          >
            {t('nav.bans')}
          </Link>
          <Button
            variant="ghost"
            size="sm"
            disabled={bans.isFetching}
            onClick={() => void bans.refetch()}
          >
            {t('security.account.refresh')}
          </Button>
        </section>
        <section>
          <h3 className="font-medium">{t('nav.connections')}</h3>
          <p>
            {t(
              connections.error
                ? 'userAccess.unavailable'
                : connections.isLoading
                  ? 'common.loading'
                  : 'userAccess.connectionCount',
              { count },
            )}
          </p>
          {connections.dataUpdatedAt > 0 && (
            <p className="text-muted-foreground">
              {t('userAccess.observedAt')}{' '}
              <Timestamp value={connections.dataUpdatedAt} />
            </p>
          )}
          <p className="text-muted-foreground">
            {t('userAccess.connectionScope')}
          </p>
          <Link
            className="text-primary hover:underline"
            to={`/connections?userId=${userId}`}
          >
            {t('userAccess.viewConnections')}
          </Link>
          <Button
            variant="ghost"
            size="sm"
            disabled={connections.isFetching}
            onClick={() => void connections.refetch()}
          >
            {t('security.account.refresh')}
          </Button>
        </section>
        <section>
          <h3 className="font-medium">{t('userAccess.push')}</h3>
          <p>{t('userAccess.pushCount', { count: pushRegistrations })}</p>
          <p className="text-muted-foreground">{t('userAccess.pushScope')}</p>
        </section>
      </CardContent>
    </Card>
  );
}
