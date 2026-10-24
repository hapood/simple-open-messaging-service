import { request } from '@/api/client';
import type { WebAuthnCredentialView, WebAuthnStatus } from '@/types/api';

export function getWebAuthnStatus(): Promise<WebAuthnStatus> {
  return request<WebAuthnStatus>('/admin/webauthn/status');
}

export function listWebAuthnCredentials(): Promise<WebAuthnCredentialView[]> {
  return request<WebAuthnCredentialView[]>('/admin/webauthn/credentials');
}
