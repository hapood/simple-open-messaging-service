import { QueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ApiError } from '@/lib/api-error'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
    mutations: {
      // mutation 失败统一 toast（query 的错误由页面 inline 展示，避免列表加载失败弹窗太吵）
      onError: (err) => {
        toast.error(err instanceof ApiError ? err.message : '操作失败')
      },
    },
  },
})
