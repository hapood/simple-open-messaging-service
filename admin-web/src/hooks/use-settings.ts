import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getNotificationSettings,
  getServerKeys,
  runVapidHealthCheck,
  setOtpTtl,
  setFederationDownloadLimits,
  setFederationHttpLimits,
  setUserQuotaDefaults,
  setFederationQuotaDefaults,
} from '@/api/settings';

/** Invalidate the settings read model — every mutation that changes VAPID state calls this. */
function useInvalidateSettings() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['admin', 'settings'] });
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

/** Notification transport config (VAPID/FCM/domain). Read by the Settings page. */
export function useNotificationSettings() {
  return useQuery({
    queryKey: ['admin', 'settings', 'notifications'],
    queryFn: () => getNotificationSettings(),
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
