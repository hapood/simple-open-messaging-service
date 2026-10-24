import { useMemo, useRef, useState } from 'react';
import { useIsAdminPlus } from '@/hooks/use-me';
import { useTranslation } from 'react-i18next';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { ArrowDown, Eraser } from 'lucide-react';
import { useLogStream, type LogStreamState } from '@/hooks/use-log-stream';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { LOG_OUTPUT_LEVELS, type LogOutputLevel } from '@/api/logs';
import {
  useLogOutputLevel,
  useSetLogOutputLevel,
} from '@/hooks/use-log-output-level';
import { formatApiError } from '@/lib/format-error';
import { LogLine } from './log-line';

/** Literal i18n keys per state, so the typed t() accepts them (a dynamic `'logs.state.'+state`
 *  string would widen to `string` and fail the i18next key check). */
const STATE_LABEL_KEY: Record<
  LogStreamState,
  | 'logs.state.open'
  | 'logs.state.connecting'
  | 'logs.state.reconnecting'
  | 'logs.state.closed'
> = {
  open: 'logs.state.open',
  connecting: 'logs.state.connecting',
  reconnecting: 'logs.state.reconnecting',
  closed: 'logs.state.closed',
};

/** Connection-state chip styling (mirrors the connections-page LIVE pill, recolored per state). */
const STATE_META: Record<LogStreamState, { chip: string; dot: string }> = {
  open: {
    chip: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    dot: 'bg-emerald-500 animate-pulse',
  },
  connecting: {
    chip: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
    dot: 'bg-amber-500',
  },
  reconnecting: {
    chip: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
    dot: 'bg-amber-500 animate-pulse',
  },
  closed: {
    chip: 'border-border bg-muted text-muted-foreground',
    dot: 'bg-muted-foreground',
  },
};

/** Logs → Live tab: the live tail of the structured log stream. The sibling History tab searches the
 *  rotated log files; Audit is a separate route. */
export function LogsLivePage() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">{t('logs.desc')}</p>
      <LivePanel />
    </div>
  );
}

function LivePanel() {
  const { t } = useTranslation();
  const canManage = useIsAdminPlus();
  const output = useLogOutputLevel();
  const setOutput = useSetLogOutputLevel();
  const { lines, state, clear } = useLogStream();
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [atBottom, setAtBottom] = useState(true);

  const levelOptions = useMemo(
    () =>
      LOG_OUTPUT_LEVELS.map((value) => ({ value, label: value.toUpperCase() })),
    [],
  );
  const items = useMemo(
    () => Object.fromEntries(levelOptions.map((o) => [o.value, o.label])),
    [levelOptions],
  );

  const stateMeta = STATE_META[state];
  const EmptyPlaceholder = useMemo(
    () =>
      function EmptyPlaceholder() {
        return (
          <div className="flex h-full items-center justify-center py-16 text-sm text-muted-foreground">
            {state === 'open' ? t('logs.waiting') : t(STATE_LABEL_KEY[state])}
          </div>
        );
      },
    [t, state],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium',
              stateMeta.chip,
            )}
          >
            <span className={cn('size-1.5 rounded-full', stateMeta.dot)} />
            {t(STATE_LABEL_KEY[state])}
          </span>
          <span className="text-xs text-muted-foreground">
            {t('logs.lineCount', { count: lines.length })}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span id="log-output-level-label" className="text-sm leading-[20px]">
            {t('logs.outputLevel')}
          </span>
          <Select
            value={output.data?.level ?? null}
            disabled={
              !canManage ||
              !output.data ||
              output.isError ||
              setOutput.isPending
            }
            onValueChange={(value) => {
              if (canManage && value && value !== output.data?.level)
                setOutput.mutate(value as LogOutputLevel);
            }}
            items={items}
          >
            <SelectTrigger
              size="sm"
              className="w-32"
              aria-labelledby="log-output-level-label"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {levelOptions.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            onClick={clear}
            disabled={lines.length === 0}
          >
            <Eraser />
            {t('logs.clear')}
          </Button>
        </div>
      </div>

      <p className="text-xs leading-[16px] text-muted-foreground">
        {t('logs.outputLevelHint')}
      </p>
      {output.error ? (
        <p role="alert" className="text-sm leading-[20px] text-destructive">
          {formatApiError(output.error)}
        </p>
      ) : null}
      <div className="relative h-[70vh] overflow-hidden rounded-md border bg-muted/20">
        <Virtuoso
          ref={virtuosoRef}
          data={lines}
          followOutput={(isAtBottom) => (isAtBottom ? 'smooth' : false)}
          atBottomStateChange={setAtBottom}
          itemContent={(_, rec) => <LogLine rec={rec} />}
          components={{ EmptyPlaceholder }}
          className="h-full"
        />
        {!atBottom && lines.length > 0 ? (
          <Button
            variant="outline"
            size="sm"
            className="absolute bottom-3 right-3 shadow-md"
            onClick={() =>
              virtuosoRef.current?.scrollToIndex({
                index: 'LAST',
                behavior: 'smooth',
              })
            }
          >
            <ArrowDown />
            {t('logs.jumpLatest')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
