import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LoginPage } from './login-page'

const auth = vi.hoisted(() => ({
  login: vi.fn(),
  verifyTwoFactor: vi.fn(),
  verifyPasskey: vi.fn(),
}))
const navigate = vi.hoisted(() => vi.fn())
const toastError = vi.hoisted(() => vi.fn())

vi.mock('@/auth/auth-context', () => ({
  useAuth: () => ({ ...auth, isAuthenticated: false, logout: vi.fn() }),
}))
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }))
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('sonner', () => ({ toast: { error: toastError } }))

describe('LoginPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true })
  })

  it('submits the password and enters the admin console after a complete login', async () => {
    auth.login.mockResolvedValue({ done: true })
    render(<LoginPage />)

    fireEvent.change(screen.getByLabelText('login.password'), {
      target: { value: 'correct horse battery staple' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'login.submit' }))

    await waitFor(() =>
      expect(auth.login).toHaveBeenCalledWith('admin', 'correct horse battery staple'),
    )
    expect(navigate).toHaveBeenCalledWith('/users', { replace: true })
  })

  it('keeps the password challenge and verifies a TOTP before navigating', async () => {
    auth.login.mockResolvedValue({
      twoFactorRequired: true,
      challengeToken: 'challenge-1',
      factors: { totp: true, webauthn: false },
    })
    auth.verifyTwoFactor.mockResolvedValue(undefined)
    render(<LoginPage />)

    fireEvent.change(screen.getByLabelText('login.password'), {
      target: { value: 'secret' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'login.submit' }))

    const code = await screen.findByLabelText('login.code')
    fireEvent.change(code, { target: { value: '12a34567' } })
    expect(code).toHaveValue('123456')
    fireEvent.click(screen.getByRole('button', { name: 'login.verify' }))

    await waitFor(() =>
      expect(auth.verifyTwoFactor).toHaveBeenCalledWith(
        'challenge-1',
        '123456',
        undefined,
      ),
    )
    expect(navigate).toHaveBeenCalledWith('/users', { replace: true })
  })

  it('offers the enrolled passkey and completes the same challenge', async () => {
    auth.login.mockResolvedValue({
      twoFactorRequired: true,
      challengeToken: 'challenge-passkey',
      factors: { totp: false, webauthn: true },
    })
    auth.verifyPasskey.mockResolvedValue(undefined)
    render(<LoginPage />)

    fireEvent.change(screen.getByLabelText('login.password'), {
      target: { value: 'secret' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'login.submit' }))
    fireEvent.click(
      await screen.findByRole('button', { name: 'login.usePasskey' }),
    )

    await waitFor(() =>
      expect(auth.verifyPasskey).toHaveBeenCalledWith('challenge-passkey'),
    )
    expect(navigate).toHaveBeenCalledWith('/users', { replace: true })
  })
})
