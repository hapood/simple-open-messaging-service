import { useTranslation } from 'react-i18next';
import {
  Eye,
  ShieldCheck,
  ShieldAlert,
  ShieldBan,
  RotateCcw,
  Wifi,
} from 'lucide-react';
import { Timestamp } from '@/components/common/timestamp';
import type { FederatedPeerEvent } from '@/types/api';

/** The trust-lifecycle timeline — the centerpiece "trust → connection-loss" view. Each transition is
 *  a row: a colored dot/icon, the event label, the timestamp, and (where present) the reason.
 *  Newest-first matches the backend ordering, so the most recent state change is at the top. */

const META: Record<string, { icon: typeof Eye; cls: string }> = {
  discovered: { icon: Eye, cls: 'text-muted-foreground bg-muted' },
  trusted: {
    icon: ShieldCheck,
    cls: 'text-emerald-700 bg-emerald-500/20 dark:text-emerald-400',
  },
  degraded: {
    icon: ShieldAlert,
    cls: 'text-amber-700 bg-amber-500/20 dark:text-amber-400',
  },
  available: {
    icon: Wifi,
    cls: 'text-emerald-700 bg-emerald-500/20 dark:text-emerald-400',
  },
  halted: { icon: ShieldBan, cls: 'text-destructive bg-destructive/15' },
  unblocked: { icon: RotateCcw, cls: 'text-muted-foreground bg-muted' },
};

export function PeerTimeline({ events }: { events: FederatedPeerEvent[] }) {
  const { t } = useTranslation();
  if (events.length === 0) {
    return (
      <div className="py-6 text-center text-sm text-muted-foreground">
        {t('federation.timeline.empty')}
      </div>
    );
  }
  return (
    <ol className="ml-3 border-l border-border">
      {events.map((e) => {
        const m = META[e.type] ?? META.discovered;
        const Icon = m.icon;
        return (
          // dot centered on the border (size-6 = 24px → -left-3 = -12px centers it on the line)
          <li key={e.id} className="relative mb-5 pl-6 last:mb-0">
            <span
              className={`absolute -left-3 top-0 flex size-6 items-center justify-center rounded-full ${m.cls}`}
            >
              <Icon className="size-3.5" />
            </span>
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">
                  {t(`federation.event.${e.type}`)}
                </span>
                <Timestamp
                  value={e.createdAt}
                  className="text-xs text-muted-foreground"
                />
              </div>
              {e.reason ? (
                <div className="break-all text-xs text-muted-foreground">
                  {e.reason}
                </div>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
