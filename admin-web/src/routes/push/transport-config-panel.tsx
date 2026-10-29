import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Play, RefreshCw, Check, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  useAdminSettings,
  useServerKeys,
  useVapidHealthCheck,
} from '@/hooks/use-settings';
import type { VapidHealthReport } from '@/types/api';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  FileSource,
  HelpButton,
  KeyStatus,
  ServerKeyCard,
} from '@/routes/settings/server-key-card';
import { formatApiError } from '@/lib/format-error';

/** Push-only credentials and startup file sources. No private key material is displayed. */
export function TransportConfigPanel() {
  const { t } = useTranslation();
  const settings = useAdminSettings();
  const keys = useServerKeys();
  const healthCheck = useVapidHealthCheck();
  const [report, setReport] = useState<VapidHealthReport | null>(null);

  async function runHealth() {
    setReport(null);
    try {
      setReport(await healthCheck.mutateAsync());
    } catch (error) {
      toast.error(formatApiError(error));
    }
  }

  return (
    <div className="flex flex-col gap-4 leading-[20px]">
      <Card>
        <CardHeader>
          <CardTitle className="leading-[24px]">
            {t('credentials.channels')}
          </CardTitle>
          <CardDescription className="leading-[20px]">
            {t('credentials.channelDesc')}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          {settings.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : settings.error ? (
            <p role="alert" className="text-destructive">
              {formatApiError(settings.error)}
            </p>
          ) : (
            <>
              <span>
                {t('credentials.directory')}:{' '}
                <code className="select-all break-all">
                  {settings.data?.configurationDirectory}
                </code>
              </span>
              <p className="text-muted-foreground">
                {t('credentials.directoryHelp')}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <span>{t('credentials.fcmRuntime')}</span>
                <KeyStatus
                  item={{ configured: settings.data?.fcmConfigured }}
                />
                <HelpButton
                  title={t('credentials.fcmRuntime')}
                  description={t('credentials.runtimeHelp')}
                />
              </div>
            </>
          )}
        </CardContent>
      </Card>

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
              key.id === 'vapid' || key.id === 'firebase-service-account',
          )
          .map((key) => <ServerKeyCard key={key.id} item={key} />)
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 leading-[24px]">
            {t('credentials.clientConfig')}
            <HelpButton
              title={t('credentials.clientConfig')}
              description={t('credentials.clientPlacement')}
            />
            {settings.data && !settings.error && (
              <KeyStatus item={settings.data.firebase} />
            )}
          </CardTitle>
          <CardDescription className="leading-[20px]">
            {t('credentials.clientPlacement')}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          {settings.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : settings.error ? (
            <p role="alert" className="text-destructive">
              {formatApiError(settings.error)}
            </p>
          ) : (
            <>
              <FileSource path={settings.data?.firebase.filePath} />
              {settings.data?.firebase.projectId && (
                <span>
                  {t('credentials.project')}:{' '}
                  <code>{settings.data.firebase.projectId}</code>
                </span>
              )}
              <p className="text-muted-foreground">
                {t('credentials.restart')}
              </p>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="leading-[24px]">
            {t('credentials.health')}
          </CardTitle>
          <CardDescription className="leading-[20px]">
            {t('credentials.healthHelp')}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Button
            className="self-start"
            size="sm"
            onClick={runHealth}
            disabled={healthCheck.isPending}
          >
            {healthCheck.isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : report ? (
              <RefreshCw className="size-3.5" />
            ) : (
              <Play className="size-3.5" />
            )}
            {t(report ? 'credentials.rerun' : 'credentials.run')}
          </Button>
          {report && (
            <div className="grid gap-2 sm:grid-cols-2">
              <Status
                label={t('credentials.publicValid')}
                ok={report.publicKeyValid}
              />
              <Status
                label={t('credentials.privateValid')}
                ok={report.privateKeyValid}
              />
              <Status
                label={t('credentials.pairValid')}
                ok={report.pairMatches}
              />
              <Status
                label={t('credentials.subjectValid')}
                ok={report.subjectValid}
              />
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Status({ label, ok }: { label: string; ok: boolean }) {
  return (
    <span className="flex items-center gap-1.5 text-sm">
      {ok ? (
        <Check className="size-4 text-emerald-500" />
      ) : (
        <X className="size-4 text-destructive" />
      )}
      {label}
    </span>
  );
}
