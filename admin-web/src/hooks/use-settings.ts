import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getAdminSettings,
  getServerKeys,
  runVapidHealthCheck,
  setOtpTtl,
  setFederationDownloadLimits,
  setFederationHttpLimits,
  setFederationHistoryAccess,
  setUserQuotaDefaults,
  setFederationQuotaDefaults,
  setAdminSessionPolicy,
  setFederationTransport,
} from '@/api/settings';

export function useSetFederationTransport() {
  const invalidate = useInvalidateSettings();
  return useMutation({
    mutationFn: setFederationTransport,
    onSuccess: invalidate,
  });
}

/** Invalidate the complete settings read model after any settings mutation. */
function useInvalidateSettings() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['admin', 'settings'] });
}

export function useSetAdminSessionPolicy() {
  const invalidate = useInvalidateSettings();
  return useMutation({
    mutationFn: setAdminSessionPolicy,
    onSuccess: invalidate,
  });
}

export function useSetFederationQuotaDefaults() {
  const invalidate = useInvalidateSettings();
  return useMutation({
    mutationFn: setFederationQuotaDefaults,
    onSuccess: invalidate,
  });
}

export function useSetUserQuotaDefaults() {
  const invalidate = useInvalidateSettings();
  return useMutation({
    mutationFn: setUserQuotaDefaults,
    onSuccess: invalidate,
  });
}

export function useSetFederationHttpLimits() {
  const invalidate = useInvalidateSettings();
  return useMutation({
    mutationFn: (limits: { global: number; perPeer: number }) =>
      setFederationHttpLimits(limits.global, limits.perPeer),
    onSuccess: invalidate,
  });
}

export function useSetFederationHistoryAccess() {
  const invalidate = useInvalidateSettings();
  return useMutation({
    mutationFn: setFederationHistoryAccess,
    onSuccess: invalidate,
  });
}

export function useSetFederationDownloadLimits() {
  const invalidate = useInvalidateSettings();
  return useMutation({
    mutationFn: (limits: {
      global: number;
      perPeer: number;
      chunkDigestEnabled: boolean;
    }) =>
      setFederationDownloadLimits(
        limits.global,
        limits.perPeer,
        limits.chunkDigestEnabled,
      ),
    onSuccess: invalidate,
  });
}

export function useAdminSettings() {
  return useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: () => getAdminSettings(),
  });
}

export function useServerKeys() {
  return useQuery({
    queryKey: ['admin', 'settings', 'keys'],
    queryFn: () => getServerKeys(),
  });
}

/** Save the one-time-code validity window (minutes). Invalidates the settings read model on success. */
export function useSetOtpTtl() {
  const invalidate = useInvalidateSettings();
  return useMutation({
    mutationFn: (ttlMinutes: number) => setOtpTtl(ttlMinutes),
    onSuccess: invalidate,
  });
}

/** Manual-trigger health check (not cached — it re-runs validation each click). The report is the
 *  mutation's return value; callers render it in local state. */
export function useVapidHealthCheck() {
  return useMutation({
    mutationFn: () => runVapidHealthCheck(),
  });
}
