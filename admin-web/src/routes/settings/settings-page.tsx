import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Clock, Download, Gauge, Globe, Loader2, Network } from 'lucide-react';
import {
  useNotificationSettings,
  useSetFederationDownloadLimits,
  useSetFederationHttpLimits,
  useSetOtpTtl,
  useSetUserQuotaDefaults,
  useSetFederationQuotaDefaults,
} from '@/hooks/use-settings';
import { useMe } from '@/hooks/use-me';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatApiError } from '@/lib/format-error';

/** Admin Settings page — operator-managed runtime configuration that is NOT push transport (the
 *  VAPID keypair, FCM status, and VAPID health check live under Push → Transport config now). What
 *  remains here is the server identity (SOMS_DOMAIN, env, read-only) and the one-time-code validity
 *  window (DB-backed, admin-managed). RBAC: saving the TTL requires ADMIN+. */
export function SettingsPage() {
  const { t } = useTranslation();
  const { data, isLoading, error } = useNotificationSettings();
  const { data: me } = useMe();
  const role = me?.role;
  const canEdit = role === 'ADMIN' || role === 'SUPER_ADMIN';

  const setOtpTtl = useSetOtpTtl();
  const setDownloadLimits = useSetFederationDownloadLimits();
  const setHttpLimits = useSetFederationHttpLimits();
  const setUserQuotaDefaults = useSetUserQuotaDefaults();
  const setFederationQuotaDefaults = useSetFederationQuotaDefaults();
  const [ttlInput, setTtlInput] = useState('');
  const [globalDownloads, setGlobalDownloads] = useState('');
  const [peerDownloads, setPeerDownloads] = useState('');
  const [chunkDigestEnabled, setChunkDigestEnabled] = useState(false);
  const [globalHttp, setGlobalHttp] = useState('');
  const [peerHttp, setPeerHttp] = useState('');
  const [userQuota, setUserQuota] = useState({
    dailyMsgLimit: '',
    dailyRequestLimit: '',
    dailyFileLimit: '',
    dailyFileBytesLimit: '',
  });
  const [federationQuota, setFederationQuota] = useState({
    dailyMsgLimit: '',
    dailyRequestLimit: '',
    dailySignalLimit: '',
    dailyFileLimit: '',
    dailyFileBytesLimit: '',
  });
  // Sync the TTL input from the server value (initial load + after a save invalidates + refetches).
  useEffect(() => {
    if (typeof data?.otpTtlMinutes === 'number')
      setTtlInput(String(data.otpTtlMinutes));
  }, [data?.otpTtlMinutes]);
  useEffect(() => {
    if (data?.federationDownloadLimits) {
      setGlobalDownloads(String(data.federationDownloadLimits.global));
      setPeerDownloads(String(data.federationDownloadLimits.perPeer));
      setChunkDigestEnabled(data.federationDownloadLimits.chunkDigestEnabled);
    }
  }, [data?.federationDownloadLimits]);
  useEffect(() => {
    if (data?.federationHttpLimits) {
      setGlobalHttp(String(data.federationHttpLimits.global));
      setPeerHttp(String(data.federationHttpLimits.perPeer));
    }
  }, [data?.federationHttpLimits]);
  useEffect(() => {
    if (!data?.userQuotaDefaults) return;
    setUserQuota({
      dailyMsgLimit: String(data.userQuotaDefaults.dailyMsgLimit),
      dailyRequestLimit: String(data.userQuotaDefaults.dailyRequestLimit),
      dailyFileLimit: String(data.userQuotaDefaults.dailyFileLimit),
      dailyFileBytesLimit: data.userQuotaDefaults.dailyFileBytesLimit,
    });
  }, [data?.userQuotaDefaults]);
  useEffect(() => {
    if (!data?.federationQuotaDefaults) return;
    setFederationQuota(
      Object.fromEntries(
        Object.entries(data.federationQuotaDefaults).map(([key, value]) => [
          key,
          String(value),
        ]),
      ) as typeof federationQuota,
    );
  }, [data?.federationQuotaDefaults]);

  async function onSaveTtl() {
    const n = Number(ttlInput);
    if (!Number.isFinite(n)) return;
    try {
      await setOtpTtl.mutateAsync(Math.trunc(n));
      toast.success(t('settings.otpTtl.saved'));
    } catch (e) {
      toast.error(formatApiError(e));
    }
  }

  async function onSaveDownloadLimits() {
    try {
      await setDownloadLimits.mutateAsync({
        global: Math.trunc(Number(globalDownloads)),
        perPeer: Math.trunc(Number(peerDownloads)),
        chunkDigestEnabled,
      });
      toast.success(t('settings.federationDownload.saved'));
    } catch (e) {
      toast.error(formatApiError(e));
    }
  }

  async function onSaveHttpLimits() {
    try {
      await setHttpLimits.mutateAsync({
        global: Math.trunc(Number(globalHttp)),
        perPeer: Math.trunc(Number(peerHttp)),
      });
      toast.success(t('settings.federationHttp.saved'));
    } catch (e) {
      toast.error(formatApiError(e));
    }
  }

  async function onSaveUserQuota() {
    try {
      await setUserQuotaDefaults.mutateAsync({
        dailyMsgLimit: Math.trunc(Number(userQuota.dailyMsgLimit)),
        dailyRequestLimit: Math.trunc(Number(userQuota.dailyRequestLimit)),
        dailyFileLimit: Math.trunc(Number(userQuota.dailyFileLimit)),
        dailyFileBytesLimit: userQuota.dailyFileBytesLimit,
      });
      toast.success('Default user quotas saved');
    } catch (e) {
      toast.error(formatApiError(e));
    }
  }

  async function onSaveFederationQuota() {
    try {
      await setFederationQuotaDefaults.mutateAsync({
        dailyMsgLimit: Math.trunc(Number(federationQuota.dailyMsgLimit)),
        dailyRequestLimit: Math.trunc(
          Number(federationQuota.dailyRequestLimit),
        ),
        dailySignalLimit: Math.trunc(Number(federationQuota.dailySignalLimit)),
        dailyFileLimit: Math.trunc(Number(federationQuota.dailyFileLimit)),
        dailyFileBytesLimit: Math.trunc(
          Number(federationQuota.dailyFileBytesLimit),
        ),
      });
      toast.success('Default federation quotas saved');
    } catch (e) {
      toast.error(formatApiError(e));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {t('settings.title')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('settings.desc')}</p>
      </div>

      {/* Server identity — read-only (SOMS_DOMAIN env, the federation identity) */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Globe className="size-4" />
            {t('settings.identity.title')}
          </CardTitle>
          <CardDescription>{t('settings.identity.desc')}</CardDescription>
        </CardHeader>
        <CardContent className="flex items-center gap-3">
          <code className="rounded bg-muted px-2 py-1 font-mono text-sm">
            {data?.somsDomain ?? '—'}
          </code>
          <Badge variant={data?.somsDomain ? 'default' : 'outline'}>
            {data?.somsDomain
              ? t('settings.identity.set')
              : t('settings.identity.unset')}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {t('settings.identity.envNote')}
          </span>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Network className="size-4" />
            {t('settings.federationHttp.title')}
          </CardTitle>
          <CardDescription>{t('settings.federationHttp.desc')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <Label
              htmlFor="http-global"
              className="text-xs text-muted-foreground"
            >
              {t('settings.federationHttp.global')}
            </Label>
            <Input
              id="http-global"
              type="number"
              min={1}
              max={100}
              value={globalHttp}
              onChange={(e) => setGlobalHttp(e.target.value)}
              className="w-28"
              disabled={!canEdit}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label
              htmlFor="http-peer"
              className="text-xs text-muted-foreground"
            >
              {t('settings.federationHttp.perPeer')}
            </Label>
            <Input
              id="http-peer"
              type="number"
              min={1}
              max={100}
              value={peerHttp}
              onChange={(e) => setPeerHttp(e.target.value)}
              className="w-28"
              disabled={!canEdit}
            />
          </div>
          <Button
            size="sm"
            onClick={onSaveHttpLimits}
            disabled={
              !canEdit || setHttpLimits.isPending || !globalHttp || !peerHttp
            }
          >
            {setHttpLimits.isPending && (
              <Loader2 className="size-3.5 animate-spin" />
            )}
            {t('settings.federationHttp.save')}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Download className="size-4" />
            {t('settings.federationDownload.title')}
          </CardTitle>
          <CardDescription>
            {t('settings.federationDownload.desc')}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <Label
              htmlFor="download-global"
              className="text-xs text-muted-foreground"
            >
              {t('settings.federationDownload.global')}
            </Label>
            <Input
              id="download-global"
              type="number"
              min={1}
              max={100}
              value={globalDownloads}
              onChange={(e) => setGlobalDownloads(e.target.value)}
              className="w-28"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label
              htmlFor="download-peer"
              className="text-xs text-muted-foreground"
            >
              {t('settings.federationDownload.perPeer')}
            </Label>
            <Input
              id="download-peer"
              type="number"
              min={1}
              max={100}
              value={peerDownloads}
              onChange={(e) => setPeerDownloads(e.target.value)}
              className="w-28"
            />
          </div>
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input
              type="checkbox"
              checked={chunkDigestEnabled}
              onChange={(e) => setChunkDigestEnabled(e.target.checked)}
              disabled={!canEdit}
            />
            <span>{t('settings.federationDownload.chunkDigest')}</span>
          </label>
          <Button
            size="sm"
            onClick={onSaveDownloadLimits}
            disabled={
              !canEdit ||
              setDownloadLimits.isPending ||
              !globalDownloads ||
              !peerDownloads
            }
          >
            {setDownloadLimits.isPending && (
              <Loader2 className="size-3.5 animate-spin" />
            )}
            {t('settings.federationDownload.save')}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Gauge className="size-4" /> Default local-user quotas
          </CardTitle>
          <CardDescription>
            Daily defaults for local accounts. Per-user overrides continue to
            take precedence.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          {(
            [
              ['dailyMsgLimit', 'Messages'],
              ['dailyRequestLimit', 'Requests'],
              ['dailyFileLimit', 'Files'],
              ['dailyFileBytesLimit', 'File bytes'],
            ] as const
          ).map(([key, label]) => (
            <div className="flex flex-col gap-1" key={key}>
              <Label className="text-xs text-muted-foreground">{label}</Label>
              <Input
                className="w-40"
                type="number"
                min={0}
                step={1}
                value={userQuota[key]}
                onChange={(event) =>
                  setUserQuota((value) => ({
                    ...value,
                    [key]: event.target.value,
                  }))
                }
              />
            </div>
          ))}
          <Button
            size="sm"
            onClick={onSaveUserQuota}
            disabled={
              !canEdit ||
              setUserQuotaDefaults.isPending ||
              Object.values(userQuota).some((value) => value === '')
            }
          >
            {setUserQuotaDefaults.isPending && (
              <Loader2 className="size-3.5 animate-spin" />
            )}
            Save defaults
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Network className="size-4" /> Default federation quotas
          </CardTitle>
          <CardDescription>
            Daily defaults shared by peers without a custom override. Signal
            frames are global-only.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          {(
            [
              ['dailyMsgLimit', 'Messages'],
              ['dailyRequestLimit', 'Requests'],
              ['dailySignalLimit', 'Signals'],
              ['dailyFileLimit', 'Files'],
              ['dailyFileBytesLimit', 'File bytes'],
            ] as const
          ).map(([key, label]) => (
            <div className="flex flex-col gap-1" key={key}>
              <Label className="text-xs text-muted-foreground">{label}</Label>
              <Input
                className="w-40"
                type="number"
                min={0}
                step={1}
                value={federationQuota[key]}
                onChange={(event) =>
                  setFederationQuota((value) => ({
                    ...value,
                    [key]: event.target.value,
                  }))
                }
              />
            </div>
          ))}
          <Button
            size="sm"
            onClick={onSaveFederationQuota}
            disabled={
              !canEdit ||
              setFederationQuotaDefaults.isPending ||
              Object.values(federationQuota).some((value) => value === '')
            }
          >
            {setFederationQuotaDefaults.isPending && (
              <Loader2 className="size-3.5 animate-spin" />
            )}
            Save defaults
          </Button>
        </CardContent>
      </Card>

      {/* One-time-code validity window — DB-backed, admin-managed */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Clock className="size-4" />
            {t('settings.otpTtl.title')}
          </CardTitle>
          <CardDescription>{t('settings.otpTtl.desc')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t('common.loading')}
            </div>
          ) : error ? (
            <p className="text-sm text-destructive">{formatApiError(error)}</p>
          ) : (
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex flex-col gap-1">
                <Label
                  htmlFor="otp-ttl"
                  className="text-xs text-muted-foreground"
                >
                  {t('settings.otpTtl.label')}
                </Label>
                <Input
                  id="otp-ttl"
                  type="number"
                  min={1}
                  max={1440}
                  value={ttlInput}
                  onChange={(e) =>
                    setTtlInput((e.target as HTMLInputElement).value)
                  }
                  className="w-32"
                />
              </div>
              <span className="pb-2 text-xs text-muted-foreground">
                {t('settings.otpTtl.minutes')}
              </span>
              <Button
                size="sm"
                onClick={onSaveTtl}
                disabled={
                  !canEdit ||
                  setOtpTtl.isPending ||
                  ttlInput === '' ||
                  ttlInput === String(data?.otpTtlMinutes ?? '')
                }
              >
                {setOtpTtl.isPending && (
                  <Loader2 className="size-3.5 animate-spin" />
                )}
                {t('settings.otpTtl.save')}
              </Button>
              {!canEdit && (
                <span className="pb-2 self-end text-xs text-muted-foreground">
                  {t('settings.vapid.adminOnly')}
                </span>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
