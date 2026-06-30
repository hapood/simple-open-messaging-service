import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'

export function NotFoundPage() {
  const navigate = useNavigate()
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-4 bg-background">
      <p className="text-3xl font-semibold tracking-tight">404</p>
      <p className="text-muted-foreground">页面不存在</p>
      <Button onClick={() => navigate('/users')}>返回用户管理</Button>
    </div>
  )
}
