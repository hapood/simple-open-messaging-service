import { request } from '@/api/client';
import type {
  NotificationSettings,
  ServerKeyStatus,
  VapidHealthReport,
} from '@/types/api';

/** Notification transport config — VAPID status (subject + publicKey, never privateKey), FCM status, server domain. */
export function getNotificationSettings(): Promise<NotificationSettings> {
  return request<NotificationSettings>('/admin/settings/notifications');
}

export function getServerKeys(): Promise<ServerKeyStatus[]> {
  return request<ServerKeyStatus[]>('/admin/settings/keys');
}

/** Set the one-time-code validity window (minutes, clamped 1-1440 server-side). Returns the stored value. */
export function setOtpTtl(
  ttlMinutes: number,
): Promise<{ otpTtlMinutes: number }> {
  return request<{ otpTtlMinutes: number }>('/admin/settings/otp-ttl', {
    ttlMinutes,
  });
}

export function setFederationDownloadLimits(
  global: number,
  perPeer: number,
  chunkDigestEnabled: boolean,
) {
  return request<{
    global: number;
    perPeer: number;
    chunkDigestEnabled: boolean;
  }>('/admin/settings/federation-download', {
    global,
    perPeer,
    chunkDigestEnabled,
  });
}

export function setFederationHttpLimits(global: number, perPeer: number) {
  return request<{ global: number; perPeer: number }>(
    '/admin/settings/federation-http',
    { global, perPeer },
  );
}

export function setUserQuotaDefaults(
  value: NotificationSettings['userQuotaDefaults'],
) {
  return request<NotificationSettings['userQuotaDefaults']>(
    '/admin/settings/user-quota-defaults',
    value,
  );
}

export function setFederationQuotaDefaults(
  value: NotificationSettings['federationQuotaDefaults'],
) {
  return request<NotificationSettings['federationQuotaDefaults']>(
    '/admin/settings/federation-quota-defaults',
    value,
  );
}

/** Validate the configured VAPID keypair + transport status (deterministic, no network). */
export function runVapidHealthCheck(): Promise<VapidHealthReport> {
  return request<VapidHealthReport>('/admin/settings/health-check');
}
