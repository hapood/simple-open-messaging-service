import { useQuery } from '@tanstack/react-query'
import { reuseAlerts } from '@/api/reuse'

export function useReuseAlerts(take = 50) {
  return useQuery({
    queryKey: ['admin', 'reuse-alerts', take],
    queryFn: () => reuseAlerts(take),
  })
}
