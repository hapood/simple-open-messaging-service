import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { useListParams } from './use-list-params'

function SearchProbe({ prefix, filterParam }: { prefix?: string; filterParam?: string }) {
  const { search, page, filter } = useListParams({ pageSize: 10, prefix, filterParam })
  return (
    <>
      <span data-testid="search">{search}</span>
      <span data-testid="page">{page}</span>
      <span data-testid="filter">{filter}</span>
    </>
  )
}

function renderAt(entry: string, prefix?: string, filterParam?: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <SearchProbe prefix={prefix} filterParam={filterParam} />
    </MemoryRouter>,
  )
}

/** Validates the `prefix` option: two list views that could share a URL path must not collide on the
 *  shared `q`/`p`/filter param names. With a prefix, the hook reads `${prefix}q` etc.; without, the
 *  bare names. Each must ignore the other's params. */
describe('useListParams prefix isolation', () => {
  it('reads the bare q/p by default', () => {
    const { getByTestId } = renderAt('/?q=alice&p=3')
    expect(getByTestId('search').textContent).toBe('alice')
    expect(getByTestId('page').textContent).toBe('3')
  })

  it('reads the prefixed q/p when a prefix is given', () => {
    const { getByTestId } = renderAt('/?opq=bob&opp=5', 'op')
    expect(getByTestId('search').textContent).toBe('bob')
    expect(getByTestId('page').textContent).toBe('5')
  })

  it('ignores the bare q when a prefix is set', () => {
    const { getByTestId } = renderAt('/?q=leak&opq=real', 'op')
    expect(getByTestId('search').textContent).toBe('real')
  })

  it('ignores a prefixed q when no prefix is set', () => {
    const { getByTestId } = renderAt('/?q=real&opq=leak')
    expect(getByTestId('search').textContent).toBe('real')
  })

  it('namespaces the filterParam too', () => {
    const { getByTestId } = renderAt('/?opstatus=blocked&status=trusted', 'op', 'status')
    expect(getByTestId('filter').textContent).toBe('blocked')
  })

  it('reads the bare filterParam with no prefix', () => {
    const { getByTestId } = renderAt('/?status=trusted&opstatus=blocked', undefined, 'status')
    expect(getByTestId('filter').textContent).toBe('trusted')
  })
})
