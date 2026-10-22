import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { RouteTabs } from './route-tabs'

const TABS = [
  { to: '/users', label: 'Users' },
  { to: '/users/operators', label: 'Operators' },
]

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <RouteTabs tabs={TABS} />
    </MemoryRouter>,
  )
}

/** RouteTabs is the route-driven tab bar used by the five hubs. The active tab IS the current route,
 *  surfaced via NavLink's aria-current="page" — the semantically-honest indicator for navigation
 *  (not aria-selected + a tablist keyboard contract, since there is no in-page tabpanel to control). */
describe('RouteTabs', () => {
  it('marks the exact-matching tab active via aria-current="page"', () => {
    renderAt('/users/operators')
    expect(screen.getByRole('link', { name: 'Operators' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'Users' })).not.toHaveAttribute('aria-current')
  })

  it('does NOT mark the index tab active on a sibling path (end semantics)', () => {
    renderAt('/users')
    expect(screen.getByRole('link', { name: 'Users' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'Operators' })).not.toHaveAttribute('aria-current')
  })

  it('renders one anchor per tab', () => {
    renderAt('/users')
    expect(screen.getByRole('link', { name: 'Users' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Operators' })).toBeInTheDocument()
  })

  it('renders within a nav landmark', () => {
    renderAt('/users')
    expect(screen.getByRole('navigation')).toBeInTheDocument()
  })
})
