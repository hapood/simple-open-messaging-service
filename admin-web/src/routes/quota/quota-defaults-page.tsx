import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  useAdminSettings,
  useSetUserQuotaDefaults,
  useSetFederationQuotaDefaults,
} from '@/hooks/use-settings';
import { useMe } from '@/hooks/use-me';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatApiError } from '@/lib/format-error';

const fields = [
  ['maxFileBytes', 'maxFileBytes'],
  ['dailyMsgLimit', 'messages'],
  ['dailyRequestLimit', 'requests'],
  ['dailyFileLimit', 'files'],
  ['dailyFileBytesLimit', 'fileBytes'],
  ['dailySignalLimit', 'signals'],
] as const;
type Values = Record<(typeof fields)[number][0], string>;
const empty: Values = {
  maxFileBytes: '',
  dailyMsgLimit: '',
  dailyRequestLimit: '',
  dailyFileLimit: '',
  dailyFileBytesLimit: '',
  dailySignalLimit: '',
};

export function QuotaDefaultsPage() {
  const { t } = useTranslation();
  const settings = useAdminSettings();
  const { data: me } = useMe();
  const canEdit = me?.role === 'ADMIN' || me?.role === 'SUPER_ADMIN';
  const userMutation = useSetUserQuotaDefaults();
  const peerMutation = useSetFederationQuotaDefaults();
  const [users, setUsers] = useState<Values>(empty);
  const [peers, setPeers] = useState<Values>(empty);
  useEffect(() => {
    if (!settings.data) return;
    const strings = (value: object) => ({
      ...empty,
      ...Object.fromEntries(
        Object.entries(value).map(([key, val]) => [key, String(val)]),
      ),
    });
    setUsers(strings(settings.data.userQuotaDefaults));
    setPeers(strings(settings.data.federationQuotaDefaults));
  }, [settings.data]);
  const valid = (values: Values) =>
    fields.every(
      ([key]) =>
        /^\d+$/.test(values[key]) && Number.isSafeInteger(Number(values[key])),
    );
  const save = async (peer: boolean) => {
    const value = peer ? peers : users;
    if (!valid(value)) return;
    const counts = {
      maxFileBytes: Number(value.maxFileBytes),
      dailyMsgLimit: Number(value.dailyMsgLimit),
      dailyRequestLimit: Number(value.dailyRequestLimit),
      dailyFileLimit: Number(value.dailyFileLimit),
    };
    try {
      if (peer)
        await peerMutation.mutateAsync({
          ...counts,
          dailyFileBytesLimit: Number(value.dailyFileBytesLimit),
          dailySignalLimit: Number(value.dailySignalLimit),
        });
      else
        await userMutation.mutateAsync({
          ...counts,
          dailyFileBytesLimit: Number(value.dailyFileBytesLimit),
          dailySignalLimit: Number(value.dailySignalLimit),
        });
      toast.success(
        t(
          peer
            ? 'settings.quotas.federationSaved'
            : 'settings.quotas.userSaved',
        ),
      );
    } catch (error) {
      toast.error(formatApiError(error));
    }
  };
  if (settings.isPending) return <p>{t('common.loading')}</p>;
  if (settings.error)
    return <p role="alert">{formatApiError(settings.error)}</p>;
  return (
    <div className="space-y-4 text-sm leading-[20px]">
      <p className="text-muted-foreground">{t('quotaCenter.defaultHint')}</p>
      {[false, true].map((peer) => (
        <section key={String(peer)} className="rounded-lg border p-4 space-y-3">
          <h2 className="font-semibold">
            {t(
              peer
                ? 'settings.quotas.federationTitle'
                : 'settings.quotas.userTitle',
            )}
          </h2>
          <p>
            {t(
              peer
                ? 'settings.quotas.federationDesc'
                : 'settings.quotas.userDesc',
            )}
          </p>
          <div className="flex flex-wrap gap-3">
            {fields.map(([key, label]) => (
              <label className="space-y-1" key={key}>
                <span>{t(`settings.quotas.${label}`)}</span>
                <Input
                  type="number"
                  min={0}
                  step={1}
                  className="w-40"
                  value={(peer ? peers : users)[key]}
                  disabled={!canEdit}
                  onChange={(event) =>
                    (peer ? setPeers : setUsers)((previous) => ({
                      ...previous,
                      [key]: event.target.value,
                    }))
                  }
                />
              </label>
            ))}
          </div>
          <Button
            disabled={
              !canEdit ||
              !valid(peer ? peers : users) ||
              userMutation.isPending ||
              peerMutation.isPending
            }
            onClick={() => void save(peer)}
          >
            {t('settings.quotas.save')}
          </Button>
        </section>
      ))}
    </div>
  );
}
