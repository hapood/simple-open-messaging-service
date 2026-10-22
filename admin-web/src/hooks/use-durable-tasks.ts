import { useQuery } from '@tanstack/react-query';
import { listDurableTasks, type DurableTaskQuery } from '@/api/durable-tasks';

export function useDurableTasks(q: DurableTaskQuery) {
  return useQuery({
    queryKey: ['admin', 'durable-tasks', q],
    queryFn: () => listDurableTasks(q),
    placeholderData: (previous) => previous,
  });
}
