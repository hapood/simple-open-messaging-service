import { request } from '@/api/client'
import type {
  FirebaseConfigDescriptor,
  GenerateVapidPayload,
  NotificationSettings,
  SaveVapidPayload,
  VapidHealthReport,
  VapidMutationResult,
} from '@/types/api'

/** Notification transport config — VAPID status (subject + publicKey, never privateKey), FCM status, server domain. */
export function getNotificationSettings(): Promise<NotificationSettings> {
  return request<NotificationSettings>('/admin/settings/notifications')
}

/** Generate a fresh VAPID keypair server-side and persist it (privateKey never returned). */
export function generateVapid(payload: GenerateVapidPayload): Promise<VapidMutationResult> {
  return request<VapidMutationResult>('/admin/settings/vapid/generate', payload)
}

/** Save (paste) an existing VAPID keypair — validated first server-side. */
export function saveVapid(payload: SaveVapidPayload): Promise<VapidMutationResult> {
  return request<VapidMutationResult>('/admin/settings/vapid/save', payload)
}

/** Remove the VAPID keypair (disables Web Push). */
export function clearVapid(): Promise<void> {
  return request<void>('/admin/settings/vapid/clear')
}

/** Upload the operator's google-services.json — the server parses + validates it (the Android client must
 *  target package com.soms.client) and publishes the 4 Firebase client fields to Android clients. The body
 *  is the RAW file contents (not multipart); throws ApiError(FCM_CONFIG_INVALID) on a malformed/wrong file. */
export function saveFirebaseConfig(googleServicesJson: string): Promise<FirebaseConfigDescriptor> {
  return request<FirebaseConfigDescriptor>('/admin/settings/firebase/save', { googleServicesJson })
}

/** Remove the Firebase client config — clients clear their native FCM config on the next /push/firebase-config
 *  fetch ({configured:false}). Does NOT touch the send-side GOOGLE_APPLICATION_CREDENTIALS. */
export function clearFirebaseConfig(): Promise<void> {
  return request<void>('/admin/settings/firebase/clear')
}

/** Set the one-time-code validity window (minutes, clamped 1-1440 server-side). Returns the stored value. */
export function setOtpTtl(ttlMinutes: number): Promise<{ otpTtlMinutes: number }> {
  return request<{ otpTtlMinutes: number }>('/admin/settings/otp-ttl', { ttlMinutes })
}

/** Validate the configured VAPID keypair + transport status (deterministic, no network). */
export function runVapidHealthCheck(): Promise<VapidHealthReport> {
  return request<VapidHealthReport>('/admin/settings/health-check')
}
