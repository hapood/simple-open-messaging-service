import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getNotificationSettings,
  generateVapid,
  saveVapid,
  clearVapid,
  runVapidHealthCheck,
  setOtpTtl,
  saveFirebaseConfig,
  clearFirebaseConfig,
} from '@/api/settings'
import type { GenerateVapidPayload, SaveVapidPayload } from '@/types/api'

/** Invalidate the settings read model — every mutation that changes VAPID state calls this. */
function useInvalidateSettings() {
  const qc = useQueryClient()
  return () => qc.invalidateQueries({ queryKey: ['admin', 'settings'] })
}

/** Notification transport config (VAPID/FCM/domain). Read by the Settings page. */
export function useNotificationSettings() {
  return useQuery({
    queryKey: ['admin', 'settings', 'notifications'],
    queryFn: () => getNotificationSettings(),
  })
}

export function useGenerateVapid() {
  const invalidate = useInvalidateSettings()
  return useMutation({
    mutationFn: (payload: GenerateVapidPayload) => generateVapid(payload),
    onSuccess: invalidate,
  })
}

export function useSaveVapid() {
  const invalidate = useInvalidateSettings()
  return useMutation({
    mutationFn: (payload: SaveVapidPayload) => saveVapid(payload),
    onSuccess: invalidate,
  })
}

export function useClearVapid() {
  const invalidate = useInvalidateSettings()
  return useMutation({
    mutationFn: () => clearVapid(),
    onSuccess: invalidate,
  })
}

/** Upload the operator's google-services.json (parses + validates server-side; publishes the 4 FCM client
 *  fields to Android clients). */
export function useSaveFirebaseConfig() {
  const invalidate = useInvalidateSettings()
  return useMutation({
    mutationFn: (googleServicesJson: string) => saveFirebaseConfig(googleServicesJson),
    onSuccess: invalidate,
  })
}

/** Remove the Firebase client config. */
export function useClearFirebaseConfig() {
  const invalidate = useInvalidateSettings()
  return useMutation({
    mutationFn: () => clearFirebaseConfig(),
    onSuccess: invalidate,
  })
}

/** Save the one-time-code validity window (minutes). Invalidates the settings read model on success. */
export function useSetOtpTtl() {
  const invalidate = useInvalidateSettings()
  return useMutation({
    mutationFn: (ttlMinutes: number) => setOtpTtl(ttlMinutes),
    onSuccess: invalidate,
  })
}

/** Manual-trigger health check (not cached — it re-runs validation each click). The report is the
 *  mutation's return value; callers render it in local state. */
export function useVapidHealthCheck() {
  return useMutation({
    mutationFn: () => runVapidHealthCheck(),
  })
}
