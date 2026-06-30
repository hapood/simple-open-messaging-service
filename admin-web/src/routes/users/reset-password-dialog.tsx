import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PASSWORD_REGEX } from '@/lib/constants'
import { ApiError } from '@/lib/api-error'
import { useResetPassword } from '@/hooks/use-user-mutations'
import type { User } from '@/types/api'

const schema = z.object({
  newPassword: z.string().regex(PASSWORD_REGEX, '6-20 位，允许字母数字和 .@!#$%^&*()'),
})
type FormValues = z.infer<typeof schema>

export function ResetPasswordDialog({
  user,
  onClose,
}: {
  user: User | null
  onClose: () => void
}) {
  const reset = useResetPassword()
  const [submitting, setSubmitting] = useState(false)
  const {
    register,
    handleSubmit,
    reset: resetForm,
    formState: { errors },
  } = useForm<FormValues>()

  useEffect(() => {
    if (user) resetForm({ newPassword: '' })
  }, [user, resetForm])

  const open = user !== null
  const onSubmit = async (v: FormValues) => {
    if (!user) return
    setSubmitting(true)
    try {
      await reset.mutateAsync({ id: user.id, newPassword: v.newPassword })
      toast.success('密码已重置，该用户所有会话已吊销')
      onClose()
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : '重置失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>重置 {user?.uniqName} 的密码</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="newPassword">新密码</Label>
            <Input id="newPassword" type="password" autoComplete="new-password" {...register('newPassword')} />
            {errors.newPassword && (
              <p className="text-xs text-destructive">{errors.newPassword.message}</p>
            )}
            <p className="text-xs text-muted-foreground">6-20 位，允许字母数字和 .@!#$%^&*()</p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
              取消
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
              确认重置
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
