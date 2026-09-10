import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  listMessageReports,
  dismissMessageReport,
  deleteSelectedMessages,
} from '@/api/message-reports';

export function useMessageReports(params: {
  skip: number;
  take: number;
  isDeleted?: boolean;
}) {
  return useQuery({
    queryKey: ['admin', 'messageReports', params],
    queryFn: () => listMessageReports(params),
    placeholderData: (previous) => previous,
    refetchInterval: 3000,
  });
}

export function useDismissMessageReport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: dismissMessageReport,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['admin', 'messageReports'] }),
  });
}

export function useDeleteReportedMessages() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deleteSelectedMessages,
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ['admin', 'messageReports'] }),
  });
}
