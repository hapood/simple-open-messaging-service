import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { UserDetailPage } from './user-detail-page'

const state = vi.hoisted(() => ({ canManage: false, isDeleted: false }))
const disable = vi.hoisted(() => ({ isPending: false, mutateAsync: vi.fn() }))
const enable = vi.hoisted(() => ({ isPending: false, mutateAsync: vi.fn() }))
const forceLogout = vi.hoisted(() => ({
  isPending: false,
  mutateAsync: vi.fn(),
}))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('sonner', () => ({ toast }))
vi.mock('@/hooks/use-me', () => ({ useIsAdminPlus: () => state.canManage }))
vi.mock('@/hooks/use-user-detail', () => ({
  useUserDetail: () => ({
    isLoading: false,
    error: null,
    data: {
      user: {
        id: 42,
        account: 'alice',
        name: 'Alice',
        avatar: '',
        bio: '',
        domain: 'alpha.test',
        namespaceId: 0,
        isDeleted: state.isDeleted,
        createdAt: 1,
        updatedAt: 1,
      },
      groups: [],
      sessions: [],
      pushTokens: [],
    },
  }),
}))
vi.mock('@/hooks/use-user-mutations', () => ({
  useDisableUser: () => disable,
  useEnableUser: () => enable,
  useForceLogoutUser: () => forceLogout,
}))
vi.mock('./issue-login-code-dialog', () => ({
  IssueLoginCodeDialog: () => null,
}))
vi.mock('./generate-initial-password-dialog', () => ({
  GenerateInitialPasswordDialog: () => null,
}))
vi.mock('./login-codes-section', () => ({ LoginCodesSection: () => null }))
vi.mock('./user-quota-panel', () => ({ UserQuotaPanel: () => null }))

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/users/42']}>
      <Routes>
        <Route path="/users/:id" element={<UserDetailPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('UserDetailPage mutation authorization', () => {
  beforeEach(() => {
    state.canManage = false
    state.isDeleted = false
    vi.clearAllMocks()
    disable.mutateAsync.mockResolvedValue(undefined)
    enable.mutateAsync.mockResolvedValue(undefined)
    forceLogout.mutateAsync.mockResolvedValue(undefined)
  })

  it('does not expose user mutations to a VIEWER', () => {
    renderPage()

    expect(screen.getByText('Alice')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'users.action.ban' })).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'users.action.forceLogout' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'users.action.issueLoginCode' }),
    ).not.toBeInTheDocument()
  })

  it('lets ADMIN+ disable and force-logout the routed user', async () => {
    state.canManage = true
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: 'users.action.ban' }))
    await waitFor(() => expect(disable.mutateAsync).toHaveBeenCalledWith(42))
    expect(toast.success).toHaveBeenCalledWith('users.toast.banned')

    fireEvent.click(screen.getByRole('button', { name: 'users.action.forceLogout' }))
    await waitFor(() => expect(forceLogout.mutateAsync).toHaveBeenCalledWith(42))
    expect(toast.success).toHaveBeenCalledWith('users.toast.forceLoggedOut')
  })

  it('does not offer login-code issuance for a disabled user', () => {
    state.canManage = true
    state.isDeleted = true
    renderPage()

    expect(
      screen.queryByRole('button', { name: 'users.action.issueLoginCode' }),
    ).not.toBeInTheDocument()
  })
})
