import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Clock, Download, Gauge, Globe, Loader2, Network } from 'lucide-react';
import {
  useAdminSettings,
  useSetFederationDownloadLimits,
  useSetFederationHttpLimits,
  useSetFederationHistoryAccess,
  useSetOtpTtl,
  useSetAdminSessionPolicy,
  useSetFederationTransport,
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
  const { data, isLoading, error } = useAdminSettings();
  const { data: me } = useMe();
  const role = me?.role;
  const canEdit = role === 'ADMIN' || role === 'SUPER_ADMIN';

  const setOtpTtl = useSetOtpTtl();
  const setDownloadLimits = useSetFederationDownloadLimits();
  const setHttpLimits = useSetFederationHttpLimits();
  const setHistoryAccess = useSetFederationHistoryAccess();
  const setAdminSessionPolicy = useSetAdminSessionPolicy();
  const setFederationTransport = useSetFederationTransport();
  const [ttlInput, setTtlInput] = useState('');
  const [globalDownloads, setGlobalDownloads] = useState('');
  const [peerDownloads, setPeerDownloads] = useState('');
  const [chunkDigestEnabled, setChunkDigestEnabled] = useState(false);
  const [globalHttp, setGlobalHttp] = useState('');
  const [peerHttp, setPeerHttp] = useState('');
  const [historyAccessEnabled, setHistoryAccessEnabled] = useState(true);
  const [sessionPolicy, setSessionPolicy] = useState({
    ttlHours: '',
    idleMinutes: '',
  });
  const [transport, setTransport] = useState({
    keyCacheTtlSec: '',
    connectTimeoutSec: '',
    requestIdleTimeoutSec: '',
    mediaChunkBytes: '',
    mediaMaxChunkRetries: '',
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
    if (typeof data?.federationHistoryAccessEnabled === 'boolean')
      setHistoryAccessEnabled(data.federationHistoryAccessEnabled);
  }, [data?.federationHistoryAccessEnabled]);
  useEffect(() => {
    if (!data?.adminSessionPolicy) return;
    setSessionPolicy({
      ttlHours: String(data.adminSessionPolicy.ttlHours),
      idleMinutes: String(data.adminSessionPolicy.idleMinutes),
    });
  }, [data?.adminSessionPolicy]);
  useEffect(() => {
    if (!data?.federationTransport) return;
    setTransport(
      Object.fromEntries(
        Object.entries(data.federationTransport).map(([key, value]) => [
          key,
          String(value),
        ]),
      ) as typeof transport,
    );
  }, [data?.federationTransport]);

  async function onSaveTransport() {
    try {
      await setFederationTransport.mutateAsync(
        Object.fromEntries(
          Object.entries(transport).map(([key, value]) => [key, Number(value)]),
        ) as unknown as NonNullable<typeof data>['federationTransport'],
      );
      toast.success(t('settings.transport.saved'));
    } catch (e) {
      toast.error(formatApiError(e));
    }
  }

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

  async function onSaveHistoryAccess() {
    try {
      await setHistoryAccess.mutateAsync(historyAccessEnabled);
      toast.success(t('settings.federationHistoryAccess.saved'));
    } catch (e) {
      toast.error(formatApiError(e));
    }
  }

  async function onSaveSessionPolicy() {
    try {
      await setAdminSessionPolicy.mutateAsync({
        ttlHours: Math.trunc(Number(sessionPolicy.ttlHours)),
        idleMinutes: Math.trunc(Number(sessionPolicy.idleMinutes)),
      });
      toast.success(t('settings.sessions.saved'));
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

      <div className="pt-2">
        <h2 className="text-lg font-semibold">
          {t('settings.sections.identity')}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t('settings.sections.identityDesc')}
        </p>
      </div>

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

      <div className="pt-2">
        <h2 className="text-lg font-semibold">
          {t('settings.sections.transport')}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t('settings.sections.transportDesc')}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Network className="size-4" />
            {t('settings.federationHistoryAccess.title')}
          </CardTitle>
          <CardDescription>
            {t('settings.federationHistoryAccess.desc')}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={historyAccessEnabled}
              onChange={(event) =>
                setHistoryAccessEnabled(event.target.checked)
              }
              disabled={!canEdit}
            />
            <span>{t('settings.federationHistoryAccess.enabled')}</span>
          </label>
          <Button
            size="sm"
            onClick={onSaveHistoryAccess}
            disabled={
              !canEdit ||
              setHistoryAccess.isPending ||
              historyAccessEnabled === data?.federationHistoryAccessEnabled
            }
          >
            {setHistoryAccess.isPending && (
              <Loader2 className="size-3.5 animate-spin" />
            )}
            {t('settings.federationHistoryAccess.save')}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Gauge className="size-4" />
            {t('settings.transport.title')}
          </CardTitle>
          <CardDescription>{t('settings.transport.desc')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          {(
            [
              ['keyCacheTtlSec', 'keyCacheTtl', 60, 604800],
              ['connectTimeoutSec', 'connectTimeout', 1, 120],
              ['requestIdleTimeoutSec', 'requestIdleTimeout', 1, 600],
              ['mediaChunkBytes', 'mediaChunkBytes', 262144, 67108864],
              ['mediaMaxChunkRetries', 'mediaChunkRetries', 0, 20],
            ] as const
          ).map(([key, label, min, max]) => (
            <div className="flex flex-col gap-1" key={key}>
              <Label
                htmlFor={`transport-${key}`}
                className="text-xs text-muted-foreground"
              >
                {t(`settings.transport.${label}`)}
              </Label>
              <Input
                id={`transport-${key}`}
                type="number"
                min={min}
                max={max}
                value={transport[key]}
                onChange={(event) =>
                  setTransport((current) => ({
                    ...current,
                    [key]: event.target.value,
                  }))
                }
                className="w-40"
                disabled={!canEdit}
              />
            </div>
          ))}
          <Button
            size="sm"
            onClick={onSaveTransport}
            disabled={
              !canEdit ||
              setFederationTransport.isPending ||
              Object.values(transport).some((value) => value === '')
            }
          >
            {setFederationTransport.isPending && (
              <Loader2 className="size-3.5 animate-spin" />
            )}
            {t('settings.transport.save')}
          </Button>
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
              disabled={!canEdit}
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
              disabled={!canEdit}
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

      <div className="pt-2">
        <h2 className="text-lg font-semibold">
          {t('settings.sections.quotas')}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t('settings.sections.quotasDesc')}
        </p>
      </div>

      <Link className="text-primary underline" to="/quota/defaults">
        {t('quotaCenter.manageDefaults')}
      </Link>

      <div className="pt-2">
        <h2 className="text-lg font-semibold">
          {t('settings.sections.security')}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t('settings.sections.securityDesc')}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Clock className="size-4" /> {t('settings.sessions.title')}
          </CardTitle>
          <CardDescription>{t('settings.sessions.desc')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">
              {t('settings.sessions.lifetime')}
            </Label>
            <Input
              className="w-36"
              type="number"
              min={1}
              max={24}
              value={sessionPolicy.ttlHours}
              disabled={!canEdit}
              onChange={(event) =>
                setSessionPolicy((value) => ({
                  ...value,
                  ttlHours: event.target.value,
                }))
              }
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">
              {t('settings.sessions.idle')}
            </Label>
            <Input
              className="w-36"
              type="number"
              min={0}
              max={480}
              value={sessionPolicy.idleMinutes}
              disabled={!canEdit}
              onChange={(event) =>
                setSessionPolicy((value) => ({
                  ...value,
                  idleMinutes: event.target.value,
                }))
              }
            />
          </div>
          <Button
            size="sm"
            onClick={onSaveSessionPolicy}
            disabled={
              !canEdit ||
              setAdminSessionPolicy.isPending ||
              !sessionPolicy.ttlHours ||
              sessionPolicy.idleMinutes === ''
            }
          >
            {setAdminSessionPolicy.isPending && (
              <Loader2 className="size-3.5 animate-spin" />
            )}
            {t('settings.sessions.save')}
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
