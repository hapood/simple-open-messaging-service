import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { TableCell, TableRow } from '@/components/ui/table'
import { Skeleton } from '@/components/ui/skeleton'
import { formatApiError } from '@/lib/format-error'

interface TableBodyStateProps {
  loading: boolean
  error: unknown
  empty: boolean
  colSpan: number
  skeletonRows?: number
  skeletonCols?: number
  /** Override the default error text (`common.loadFailed` + formatApiError). */
  errorMessage?: ReactNode
  /** Override the default empty text (`common.noData`). */
  emptyMessage?: ReactNode
  /** Data rows rendered in the non-loading / non-error / non-empty case. */
  children?: ReactNode
}

/**
 * The four-way body state every admin list table shares: a skeleton grid while
 * loading, a destructive single-cell error row, a muted empty row, or the
 * caller's data rows.
 *
 * Renders `<TableRow>` fragments — place it directly inside `<TableBody>`.
 * Replaces the copy-pasted `isLoading ? skeletons : error ? … : empty ? … : map`
 * block from every list page.
 */
export function TableBodyState({
  loading,
  error,
  empty,
  colSpan,
  skeletonRows = 8,
  skeletonCols,
  errorMessage,
  emptyMessage,
  children,
}: TableBodyStateProps) {
  const { t } = useTranslation()
  const cols = skeletonCols ?? colSpan
  if (loading) {
    return (
      <>
        {Array.from({ length: skeletonRows }).map((_, i) => (
          <TableRow key={i}>
            {Array.from({ length: cols }).map((__, j) => (
              <TableCell key={j}>
                <Skeleton className="h-5 w-full" />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </>
    )
  }
  if (error) {
    return (
      <TableRow>
        <TableCell colSpan={colSpan} className="py-8 text-center text-destructive">
          {errorMessage ?? t('common.loadFailed', { message: formatApiError(error) })}
        </TableCell>
      </TableRow>
    )
  }
  if (empty) {
    return (
      <TableRow>
        <TableCell colSpan={colSpan} className="py-8 text-center text-muted-foreground">
          {emptyMessage ?? t('common.noData')}
        </TableCell>
      </TableRow>
    )
  }
  return <>{children}</>
}
