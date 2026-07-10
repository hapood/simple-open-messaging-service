import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'

interface PaginationProps {
  /** Current page, 0-indexed. */
  page: number
  total: number
  pageSize: number
  onPageChange: (page: number) => void
  /** Disable both buttons (e.g. while a fetch is in flight). */
  disabled?: boolean
}

/**
 * Prev / "Page x / y" / Next control shared by every admin list page.
 *
 * Only the nav control is shared — the left-side summary (total count, item
 * range, description) varies per page and stays with the caller. Replaces the
 * duplicated prev/next/button block from users-page / sessions-page / etc.
 */
export function Pagination({ page, total, pageSize, onPageChange, disabled }: PaginationProps) {
  const { t } = useTranslation()
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  return (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        disabled={disabled || page === 0}
        onClick={() => onPageChange(page - 1)}
      >
        {t('common.previous')}
      </Button>
      <span>{t('common.page', { page: page + 1, pages: pageCount })}</span>
      <Button
        variant="outline"
        size="sm"
        disabled={disabled || page + 1 >= pageCount}
        onClick={() => onPageChange(page + 1)}
      >
        {t('common.next')}
      </Button>
    </div>
  )
}
