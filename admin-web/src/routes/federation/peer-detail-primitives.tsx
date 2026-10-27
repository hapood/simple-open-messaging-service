import type { ReactNode } from 'react';
import dayjs from 'dayjs';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function PeerMeta({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-xs leading-[16px] text-muted-foreground">
        {label}
      </span>
      <div className="break-words text-sm leading-[20px]">{children}</div>
    </div>
  );
}

/** Remote source times and local receipt times share a format, not a clock. */
export function PeerTime({ value }: { value: number | null | undefined }) {
  if (value == null) return <span className="text-muted-foreground">—</span>;
  return (
    <time
      dateTime={new Date(value).toISOString()}
      className="whitespace-nowrap font-mono text-xs leading-[20px]"
      title={String(value)}
    >
      {dayjs(value).format('YYYY-MM-DD HH:mm:ss.SSS Z')}
    </time>
  );
}

export function PeerCoordinate({
  value,
}: {
  value: string | number | null | undefined;
}) {
  const { t } = useTranslation();
  if (value == null) return <span className="text-muted-foreground">—</span>;
  const text = String(value);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t('federation.inspect.copied'));
    } catch {
      toast.error(t('federation.inspect.copyFailed'));
    }
  };
  return (
    <span className="inline-flex max-w-full items-center gap-1">
      <code className="break-all text-xs leading-[20px]">{text}</code>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-6 shrink-0"
        aria-label={t('federation.inspect.copyValue', { value: text })}
        onClick={copy}
      >
        <Copy className="size-3" />
      </Button>
    </span>
  );
}
