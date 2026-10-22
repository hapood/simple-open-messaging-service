import { request } from '@/api/client';
import type {
  AdminSettings,
  ServerKeyStatus,
  VapidHealthReport,
} from '@/types/api';

export function getAdminSettings(): Promise<AdminSettings> {
  return request<AdminSettings>('/admin/settings');
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

export function setFederationHistoryAccess(enabled: boolean) {
  return request<{ enabled: boolean }>(
    '/admin/settings/federation-history-access',
    { enabled },
  );
}

export function setFederationTransport(
  value: AdminSettings['federationTransport'],
) {
  return request<AdminSettings['federationTransport']>(
    '/admin/settings/federation-transport',
    value,
  );
}

export function setUserQuotaDefaults(
  value: AdminSettings['userQuotaDefaults'],
) {
  return request<AdminSettings['userQuotaDefaults']>(
    '/admin/settings/user-quota-defaults',
    value,
  );
}

export function setFederationQuotaDefaults(
  value: AdminSettings['federationQuotaDefaults'],
) {
  return request<AdminSettings['federationQuotaDefaults']>(
    '/admin/settings/federation-quota-defaults',
    value,
  );
}

export function setAdminSessionPolicy(
  value: AdminSettings['adminSessionPolicy'],
) {
  return request<AdminSettings['adminSessionPolicy']>(
    '/admin/settings/admin-session-policy',
    value,
  );
}

/** Validate the configured VAPID keypair + transport status (deterministic, no network). */
export function runVapidHealthCheck(): Promise<VapidHealthReport> {
  return request<VapidHealthReport>('/admin/settings/health-check');
}
