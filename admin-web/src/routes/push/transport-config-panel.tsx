import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Check,
  Copy,
  KeyRound,
  Loader2,
  Play,
  RefreshCw,
  ShieldCheck,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  useNotificationSettings,
  useServerKeys,
  useVapidHealthCheck,
} from '@/hooks/use-settings';
import type { ServerKeyStatus, VapidHealthReport } from '@/types/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Timestamp } from '@/components/common/timestamp';
import { formatApiError } from '@/lib/format-error';

const KEY_NAMES: Record<ServerKeyStatus['id'], string> = {
  'federation-root': 'Federation root',
  'federation-signing': 'Federation signing',
  vapid: 'Web Push VAPID',
  'admin-jwt': 'Admin JWT',
  'password-pepper': 'Password pepper',
  'two-factor': '2FA encryption',
  'firebase-service-account': 'Firebase service account',
};

/** Read-only inventory for application-owned keys and external push transport status. */
export function TransportConfigPanel() {
  const { t } = useTranslation();
  const settings = useNotificationSettings();
  const keys = useServerKeys();
  const healthCheck = useVapidHealthCheck();
  const [report, setReport] = useState<VapidHealthReport | null>(null);

  async function runHealth() {
    try {
      setReport(await healthCheck.mutateAsync());
    } catch (error) {
      toast.error(formatApiError(error));
    }
  }

  async function copy(value: string) {
    await navigator.clipboard.writeText(value);
    toast.success(t('settings.vapid.copied'));
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="size-4" /> Server keys
          </CardTitle>
          <CardDescription>
            Application-owned keys are generated once in the server data
            directory and are read-only here.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {keys.isLoading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : keys.error ? (
            <p className="text-sm text-destructive">
              {formatApiError(keys.error)}
            </p>
          ) : (
            keys.data?.map((key) => (
              <KeyRow key={key.id} item={key} onCopy={copy} />
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            External push integrations
          </CardTitle>
          <CardDescription>
            Read-only status for operator-provided Firebase credentials.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3 text-sm">
          <Status
            label="FCM send credential"
            ok={!!settings.data?.fcmConfigured}
          />
          <Status
            label="Android client configuration"
            ok={!!settings.data?.firebase?.configured}
          />
          {settings.data?.firebase?.projectId && (
            <code>{settings.data.firebase.projectId}</code>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="size-4" /> VAPID health check
          </CardTitle>
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
            {report ? 'Run again' : 'Run check'}
          </Button>
          {report && (
            <div className="grid gap-2 sm:grid-cols-2">
              <Status label="Public key valid" ok={report.publicKeyValid} />
              <Status label="Private key valid" ok={report.privateKeyValid} />
              <Status label="Keypair matches" ok={report.pairMatches} />
              <Status label="Contact subject valid" ok={report.subjectValid} />
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function KeyRow({
  item,
  onCopy,
}: {
  item: ServerKeyStatus;
  onCopy: (value: string) => void;
}) {
  const healthy = item.valid ?? item.available ?? item.configured;
  return (
    <div className="rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{KEY_NAMES[item.id]}</span>
        <Badge variant={healthy ? 'default' : 'destructive'}>
          {healthy ? 'Healthy' : 'Invalid'}
        </Badge>
        <Badge variant="outline">{item.kind}</Badge>
        {item.permissionsSecure === false && (
          <Badge variant="destructive">Unsafe permissions</Badge>
        )}
      </div>
      <div className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">
        {item.keyId && (
          <span>
            Key ID: <code>{item.keyId}</code>
          </span>
        )}
        {item.projectId && (
          <span>
            Project: <code>{item.projectId}</code>
          </span>
        )}
        {item.clientEmail && (
          <span>
            Service account: <code>{item.clientEmail}</code>
          </span>
        )}
        {item.fingerprint && (
          <span>
            Fingerprint: <code>{item.fingerprint}</code>
          </span>
        )}
        {item.createdAt && (
          <span>
            Created: <Timestamp value={Date.parse(item.createdAt)} />
          </span>
        )}
        {item.reason && <span>{item.reason}</span>}
        {item.publicKey && (
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate">{item.publicKey}</code>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onCopy(item.publicKey!)}
            >
              <Copy className="size-3.5" />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function Status({ label, ok }: { label: string; ok: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      {ok ? (
        <Check className="size-4 text-emerald-500" />
      ) : (
        <X className="size-4 text-destructive" />
      )}
      {label}
    </span>
  );
}
