import { describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useListParams } from './use-list-params'

function renderAt(entry: string, prefix?: string, filterParam?: string) {
  return renderHook(
    () => useListParams({ pageSize: 10, prefix, filterParam }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <MemoryRouter initialEntries={[entry]}>{children}</MemoryRouter>
      ),
    },
  )
}

/** Validates the `prefix` option: two list views that could share a URL path must not collide on the
 *  shared `q`/`p`/filter param names. With a prefix, the hook reads `${prefix}q` etc.; without, the
 *  bare names. Each must ignore the other's params. */
describe('useListParams prefix isolation', () => {
  it('reads the bare q/p by default', () => {
    const { result } = renderAt('/?q=alice&p=3')
    expect(result.current.search).toBe('alice')
    expect(result.current.page).toBe(3)
  })

  it('reads the prefixed q/p when a prefix is given', () => {
    const { result } = renderAt('/?opq=bob&opp=5', 'op')
    expect(result.current.search).toBe('bob')
    expect(result.current.page).toBe(5)
  })

  it('ignores the bare q when a prefix is set', () => {
    const { result } = renderAt('/?q=leak&opq=real', 'op')
    expect(result.current.search).toBe('real')
  })

  it('ignores a prefixed q when no prefix is set', () => {
    const { result } = renderAt('/?q=real&opq=leak')
    expect(result.current.search).toBe('real')
  })

  it('namespaces the filterParam too', () => {
    const { result } = renderAt('/?opstatus=blocked&status=trusted', 'op', 'status')
    expect(result.current.filter).toBe('blocked')
  })

  it('reads the bare filterParam with no prefix', () => {
    const { result } = renderAt('/?status=trusted&opstatus=blocked', undefined, 'status')
    expect(result.current.filter).toBe('trusted')
  })
})
