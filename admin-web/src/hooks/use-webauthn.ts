import { useQuery } from '@tanstack/react-query';
import { getWebAuthnStatus, listWebAuthnCredentials } from '@/api/webauthn';

export function useWebAuthnStatus(enabled = true) {
  return useQuery({
    queryKey: ['admin', 'webauthn', 'status'],
    queryFn: getWebAuthnStatus,
    enabled,
  });
}

export function useWebAuthnCredentials(enabled = true) {
  return useQuery({
    queryKey: ['admin', 'webauthn', 'credentials'],
    queryFn: listWebAuthnCredentials,
    enabled,
  });
}
