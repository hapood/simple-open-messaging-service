import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  listMessageReports,
  resolveMessageReports,
  type MessageReportStatus,
} from '@/api/message-reports';

export function useMessageReports(params: {
  skip: number;
  take: number;
  status?: MessageReportStatus;
}) {
  return useQuery({
    queryKey: ['admin', 'messageReports', params],
    queryFn: () => listMessageReports(params),
    placeholderData: (previous) => previous,
  });
}

export function useResolveMessageReports() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: resolveMessageReports,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['admin', 'messageReports'] }),
  });
}
