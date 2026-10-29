import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleHelp, Copy } from 'lucide-react';
import { toast } from 'sonner';
import type { ServerKeyStatus } from '@/types/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Timestamp } from '@/components/common/timestamp';
import { formatApiError } from '@/lib/format-error';

export function HelpButton({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t('credentials.help', { name: title })}
        onClick={() => setOpen(true)}
      >
        <CircleHelp className="size-4" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="leading-[20px]">
          <DialogHeader>
            <DialogTitle className="pr-8 leading-[24px]">{title}</DialogTitle>
            <DialogDescription className="leading-[20px]">
              {description}
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function FileSource({ path }: { path?: string }) {
  const { t } = useTranslation();
  if (!path) return null;
  return (
    <div className="flex flex-col gap-1 text-sm leading-[20px]">
      <span className="text-muted-foreground">{t('credentials.filePath')}</span>
      <code className="select-all break-all">{path}</code>
    </div>
  );
}

export function KeyStatus({
  item,
}: {
  item: Pick<ServerKeyStatus, 'valid' | 'available' | 'configured'>;
}) {
  const { t } = useTranslation();
  const status =
    item.available === false
      ? 'unavailable'
      : item.configured === false
        ? 'notConfigured'
        : item.valid === false
          ? 'invalid'
          : item.valid === true
            ? 'valid'
            : item.available === true || item.configured === true
              ? 'configured'
              : 'unavailable';
  return (
    <Badge
      variant={
        status === 'valid' || status === 'configured' ? 'default' : 'outline'
      }
    >
      {t(`credentials.${status}`)}
    </Badge>
  );
}

export function ServerKeyCard({ item }: { item: ServerKeyStatus }) {
  const { t } = useTranslation();
  const name = t(`credentials.keys.${item.id}.name`);
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t('credentials.copied'));
    } catch (error) {
      toast.error(formatApiError(error));
    }
  }
  return (
    <section
      className="flex flex-col gap-3 rounded-lg border p-4 leading-[20px]"
      aria-label={name}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-medium">{name}</h2>
        <HelpButton
          title={name}
          description={t(`credentials.keys.${item.id}.help`)}
        />
        <KeyStatus item={item} />
        <Badge variant="outline">{t(`credentials.${item.kind}`)}</Badge>
        {item.permissionsSecure === false && (
          <Badge variant="destructive">{t('credentials.unsafe')}</Badge>
        )}
      </div>
      {item.reason && <p className="text-sm text-destructive">{item.reason}</p>}
      {item.filePath && <FileSource path={item.filePath} />}
      {item.databaseTable && (
        <p className="text-sm">
          {t('credentials.database')}: <code>{item.databaseTable}</code>
        </p>
      )}
      {item.filePath && (
        <p className="text-sm text-muted-foreground">
          {t(
            item.kind === 'external'
              ? 'credentials.fcmPlacement'
              : 'credentials.managed',
          )}
        </p>
      )}
      {item.filePath && (
        <p className="text-sm text-muted-foreground">
          {t('credentials.restart')}
        </p>
      )}
      {item.projectId && (
        <p className="text-sm">
          {t('credentials.project')}: <code>{item.projectId}</code>
        </p>
      )}
      <details className="text-sm">
        <summary className="cursor-pointer">{t('credentials.details')}</summary>
        <div className="mt-3 flex flex-col gap-2 text-muted-foreground">
          {item.keyId && (
            <span>
              {t('credentials.keyId')}:{' '}
              <code className="break-all">{item.keyId}</code>
            </span>
          )}
          {item.clientEmail && (
            <span>
              {t('credentials.account')}:{' '}
              <code className="break-all">{item.clientEmail}</code>
            </span>
          )}
          {item.fingerprint && (
            <div className="flex flex-wrap items-center gap-1">
              <span>
                {t('credentials.fingerprint')}: <code>{item.fingerprint}</code>
              </span>
              <HelpButton
                title={t('credentials.fingerprint')}
                description={t('credentials.fingerprintHelp')}
              />
            </div>
          )}
          {item.createdAt != null && (
            <span>
              {t('credentials.created')}: <Timestamp value={item.createdAt} />
            </span>
          )}
          {item.publicKey && (
            <div className="flex items-start gap-2">
              <span className="min-w-0 flex-1">
                {t('credentials.publicKey')}:{' '}
                <code className="break-all">{item.publicKey}</code>
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('credentials.copy')}
                onClick={() => copy(item.publicKey!)}
              >
                <Copy className="size-4" />
              </Button>
            </div>
          )}
        </div>
      </details>
    </section>
  );
}
