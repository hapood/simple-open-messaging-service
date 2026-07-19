import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useDebouncedValue } from './use-debounced-value'

interface ListParamsOptions {
  pageSize: number
  /** Name of an optional single-value filter param (e.g. 'status' for federation, 'level' for logs).
   *  Omit for pages with only search + pagination. */
  filterParam?: string
  /** Optional prefix that namespaces this instance's URL params: `q`→`${prefix}q`, `p`→`${prefix}p`,
   *  and `${filterParam}`→`${prefix}${filterParam}`. Use when two list views can share a single URL
     * path (e.g. rendered side-by-side, or two list hooks on one route) so their search / page / filter
     *  state don't collide. Default `''` keeps the bare `q`/`p` names and the existing shareable URLs. */
  prefix?: string
}

export interface ListParams {
  /** Live input value — bind this to the search <Input> for fluid typing. */
  searchInput: string
  setSearchInput: (v: string) => void
  /** Committed (debounced, URL-backed) search — use this for the query. */
  search: string
  /** Current page, 0-indexed. */
  page: number
  setPage: (page: number) => void
  /** Current filter value ('' when unset). Only meaningful when filterParam was passed. */
  filter: string
  setFilter: (v: string) => void
  /** Derived offset/limit for the query. */
  skip: number
  take: number
}

/**
 * Syncs a list page's search / pagination / optional single filter to the URL search params, so a
 * filtered view is shareable, bookmarkable, survives refresh, and respects browser back/forward.
 *
 * The search input stays in local state for fluid typing and is debounced (300ms) before being
 * committed to the URL; page + filter are written directly. All writes use `replace: true` to avoid
 * polluting browser history. The input box is seeded from the URL on mount only (typing is never
 * fought by a URL echo).
 *
 * Pass `prefix` to namespace the params when more than one list view can share a URL path.
 */
export function useListParams({ pageSize, filterParam, prefix }: ListParamsOptions): ListParams {
  const [params, setParams] = useSearchParams()
  const px = prefix ?? ''
  const qName = `${px}q`
  const pName = `${px}p`
  const filterName = filterParam ? `${px}${filterParam}` : undefined

  const committedSearch = params.get(qName) ?? ''
  const page = Math.max(0, Number(params.get(pName) ?? '0') || 0)
  const filter = filterName ? (params.get(filterName) ?? '') : ''

  const [searchInput, setSearchInput] = useState(committedSearch)
  const debounced = useDebouncedValue(searchInput, 300)

  // Commit debounced search → URL (reset page) only when it actually changed.
  useEffect(() => {
    if (debounced === committedSearch) return
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (debounced) next.set(qName, debounced)
        else next.delete(qName)
        next.delete(pName)
        return next
      },
      { replace: true },
    )
  }, [debounced, committedSearch, setParams, qName, pName])

  const setPage = (p: number) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (p > 0) next.set(pName, String(p))
        else next.delete(pName)
        return next
      },
      { replace: true },
    )

  const setFilter = (v: string) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (filterName) {
          if (v) next.set(filterName, v)
          else next.delete(filterName)
        }
        next.delete(pName) // changing the filter re-scopes → back to page 0
        return next
      },
      { replace: true },
    )

  return {
    searchInput,
    setSearchInput,
    search: committedSearch,
    page,
    setPage,
    filter,
    setFilter,
    skip: page * pageSize,
    take: pageSize,
  }
}
