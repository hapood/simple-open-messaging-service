import dayjs from 'dayjs'
import { cn } from '@/lib/utils'

/** 毫秒时间戳 number → 可读时间（后端 Date 统一序列化为 ms number，非 ISO） */
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
