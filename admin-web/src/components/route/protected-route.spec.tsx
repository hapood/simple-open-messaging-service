import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProtectedRoute } from './protected-route'

const auth = vi.hoisted(() => ({ isAuthenticated: false, isChecking: true }))

vi.mock('@/auth/auth-context', () => ({ useAuth: () => auth }))
vi.mock('@/components/layout/admin-layout', () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => (
    <main>{children}</main>
  ),
}))

function renderRoute() {
  return render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <Routes>
        <Route element={<ProtectedRoute />}>
          <Route path="/dashboard" element={<div>private dashboard</div>} />
        </Route>
        <Route path="/login" element={<div>login page</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('ProtectedRoute', () => {
  beforeEach(() => {
    auth.isAuthenticated = false
    auth.isChecking = true
  })

  it('does not mount the admin layout while the session is being checked', () => {
    renderRoute()
    expect(screen.queryByRole('main')).not.toBeInTheDocument()
    expect(screen.queryByText('private dashboard')).not.toBeInTheDocument()
  })

  it('redirects to login after an unauthenticated result', () => {
    auth.isChecking = false
    renderRoute()
    expect(screen.getByText('login page')).toBeInTheDocument()
    expect(screen.queryByRole('main')).not.toBeInTheDocument()
  })

  it('mounts the protected page only after authentication succeeds', () => {
    auth.isChecking = false
    auth.isAuthenticated = true
    renderRoute()
    expect(screen.getByRole('main')).toBeInTheDocument()
    expect(screen.getByText('private dashboard')).toBeInTheDocument()
  })
})
