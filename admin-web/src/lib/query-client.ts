import { QueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { formatApiError } from '@/lib/format-error'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
    mutations: {
      // Mutation failures surface a unified toast (query errors are shown inline by
      // the page, to avoid noisy popups on list load failures).
      onError: (err) => {
        toast.error(formatApiError(err))
      },
    },
  },
})
