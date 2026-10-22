import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CreateUserDialog } from './create-user-dialog'
import { ApiError } from '@/lib/api-error'
import { CODE } from '@/lib/constants'

const create = vi.hoisted(() => ({ mutateAsync: vi.fn() }))
const publicConfig = vi.hoisted(() => ({ data: { registrationOpen: false, loginMode: 2 } as { registrationOpen: boolean; loginMode: number } | undefined }))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('sonner', () => ({ toast }))
vi.mock('@/hooks/use-user-mutations', () => ({ useCreateUser: () => create }))
vi.mock('@/hooks/use-public-config', () => ({
  usePublicConfig: () => ({ data: publicConfig.data }),
}))

describe('CreateUserDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    publicConfig.data = { registrationOpen: false, loginMode: 2 }
  })

  it('shows client-side validation errors without calling the API', async () => {
    render(<CreateUserDialog open onClose={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('createUser.account'), {
      target: { value: '' },
    })
    fireEvent.change(screen.getByLabelText('createUser.name'), {
      target: { value: '' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'createUser.confirm' }))

    expect(await screen.findByText('createUser.accountHint')).toBeInTheDocument()
    expect(await screen.findByText('createUser.nameHint')).toBeInTheDocument()
    expect(create.mutateAsync).not.toHaveBeenCalled()
  })

  it('accepts the backend account grammar client-side', async () => {
    create.mutateAsync.mockResolvedValue({ account: '1alice' })
    render(<CreateUserDialog open onClose={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('createUser.account'), {
      target: { value: '1alice' },
    })
    fireEvent.change(screen.getByLabelText('createUser.name'), {
      target: { value: 'Valid Name' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'createUser.confirm' }))

    await waitFor(() =>
      expect(create.mutateAsync).toHaveBeenCalledWith({
        account: '1alice',
        name: 'Valid Name',
        password: undefined,
      }),
    )
  })

  it('requires a password before submitting when password login is enabled', async () => {
    publicConfig.data = { registrationOpen: false, loginMode: 1 }
    render(<CreateUserDialog open onClose={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('createUser.account'), {
      target: { value: 'valid.user' },
    })
    fireEvent.change(screen.getByLabelText('createUser.name'), {
      target: { value: 'Valid User' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'createUser.confirm' }))

    expect(await screen.findByText('createUser.passwordRequired')).toBeInTheDocument()
    expect(create.mutateAsync).not.toHaveBeenCalled()
  })

  it('does not submit before the public config is loaded', () => {
    publicConfig.data = undefined
    render(<CreateUserDialog open onClose={vi.fn()} />)

    const confirm = screen.getByRole('button', { name: 'createUser.confirm' })
    expect(confirm).toBeDisabled()
  })

  it('shows an inline error when the account already exists', async () => {
    create.mutateAsync.mockRejectedValue(
      new ApiError(CODE.ALREADY_EXISTS, 'account dup.c513a already exists', 200),
    )

    render(<CreateUserDialog open onClose={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('createUser.account'), {
      target: { value: 'dup.c513a' },
    })
    fireEvent.change(screen.getByLabelText('createUser.name'), {
      target: { value: 'C513 Duplicate' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'createUser.confirm' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'createUser.accountAlreadyExists',
    )
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('createUser.accountAlreadyExists'))
  })
})
