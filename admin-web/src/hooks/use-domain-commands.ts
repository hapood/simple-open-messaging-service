import { useQuery } from '@tanstack/react-query';
import {
  listDomainCommands,
  type DomainCommandQuery,
} from '@/api/domain-commands';

export function useDomainCommands(q: DomainCommandQuery) {
  return useQuery({
    queryKey: ['admin', 'domain-commands', q],
    queryFn: () => listDomainCommands(q),
    placeholderData: (previous) => previous,
  });
}
