import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getLogOutputLevel, setLogOutputLevel } from '@/api/logs';

const queryKey = ['admin', 'logs', 'output-level'];

export function useLogOutputLevel() {
  return useQuery({
    queryKey,
    queryFn: getLogOutputLevel,
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchInterval: 5000,
  });
}

export function useSetLogOutputLevel() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: setLogOutputLevel,
    onMutate: async () => {
      await client.cancelQueries({ queryKey });
    },
    onSuccess: (settings) => {
      client.setQueryData(queryKey, settings);
    },
    onSettled: () => client.invalidateQueries({ queryKey }),
  });
}
