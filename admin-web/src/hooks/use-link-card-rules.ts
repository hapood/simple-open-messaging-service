import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createLinkCardRule,
  deleteLinkCardRule,
  listLinkCardRules,
  updateLinkCardRule,
  type LinkCardRuleInput,
} from '@/api/link-card-rules';

const queryKey = ['admin', 'link-card-rules'] as const;

export function useLinkCardRules() {
  return useQuery({ queryKey, queryFn: listLinkCardRules });
}

export function useCreateLinkCardRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createLinkCardRule,
    onSuccess: () => qc.invalidateQueries({ queryKey }),
  });
}

export function useUpdateLinkCardRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: number; input: LinkCardRuleInput }) =>
      updateLinkCardRule(id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey }),
  });
}

export function useDeleteLinkCardRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteLinkCardRule,
    onSuccess: () => qc.invalidateQueries({ queryKey }),
  });
}
