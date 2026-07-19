import dayjs from 'dayjs'
import { cn } from '@/lib/utils'
import type { LogRecord } from '@/hooks/use-log-stream'

/** Per-level text color for the level label. trace/debug fade to muted; warn/error/fatal warm up.
 *  Shared by the live tail and the history table so level coloring is consistent. */
export const LEVEL_TEXT: Record<string, string> = {
  fatal: 'text-red-600 dark:text-red-400',
  error: 'text-red-600 dark:text-red-400',
  warn: 'text-amber-600 dark:text-amber-400',
  info: 'text-blue-600 dark:text-blue-400',
  debug: 'text-muted-foreground',
  trace: 'text-muted-foreground',
}

/** One log line in the live tail (monospace, single row, fixed-width level column for scan alignment). */
export function LogLine({ rec }: { rec: LogRecord }) {
  const level = (rec.level || 'info').toLowerCase()
  return (
    <div className="flex items-baseline gap-2 px-3 py-px font-mono text-xs leading-5 hover:bg-muted/50">
      <span className="shrink-0 tabular-nums text-muted-foreground">
        {dayjs(rec.time).format('HH:mm:ss.SSS')}
      </span>
      <span className={cn('w-12 shrink-0 font-semibold uppercase', LEVEL_TEXT[level] ?? LEVEL_TEXT.info)}>
        {level}
      </span>
      {rec.context ? (
        <span className="shrink-0 text-muted-foreground">[{rec.context}]</span>
      ) : null}
      <span className="break-all">{rec.msg}</span>
    </div>
  )
}
