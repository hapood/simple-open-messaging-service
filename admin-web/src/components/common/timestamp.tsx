import dayjs from 'dayjs'
import { cn } from '@/lib/utils'

/** Format a ms-epoch number into a readable time (backend Date fields are serialized as ms numbers, not ISO). */
export function Timestamp({
  value,
  className,
}: {
  value: number | null | undefined
  className?: string
}) {
  if (value == null) return <span className={cn('text-muted-foreground', className)}>—</span>
  return <span className={className}>{dayjs(value).format('YYYY-MM-DD HH:mm:ss')}</span>
}
