import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IssueLoginCodeDialog } from './issue-login-code-dialog'

const issue = vi.hoisted(() => ({ mutateAsync: vi.fn() }))

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/hooks/use-user-mutations', () => ({ useIssueLoginCode: () => issue }))

describe('IssueLoginCodeDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    issue.mutateAsync.mockImplementation(() => new Promise(() => undefined))
  })

  it('issues only once when the confirm button is clicked repeatedly', () => {
    render(
      <IssueLoginCodeDialog
        user={{ id: 42, account: 'alice' }}
        onClose={vi.fn()}
      />,
    )

    const confirm = screen.getByRole('button', { name: 'issueLoginCode.confirm' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)

    expect(issue.mutateAsync).toHaveBeenCalledTimes(1)
    expect(issue.mutateAsync).toHaveBeenCalledWith(42)
    expect(confirm).toBeDisabled()
  })
})
