import { request } from '@/api/client'
import type { PushTokenListResult, PushTestResult } from '@/types/api'

/** Paginated device-token list + FCM/Web Push transport config status. */
export function listPushTokens(params: {
  skip?: number
  take?: number
  search?: string
}): Promise<PushTokenListResult> {
  return request<PushTokenListResult>('/admin/push/tokens', params)
}

/** Unregister (delete) a device token by id. */
export function deletePushToken(id: number): Promise<void> {
  return request<void>(`/admin/push/tokens/${id}/delete`)
}

/** Send a one-off test push to a device token (FCM for ANDROID/IOS, Web Push for WEB). */
export function sendPushTest(payload: {
  id: number
  title: string
  body?: string
}): Promise<PushTestResult> {
  return request<PushTestResult>('/admin/push/test', payload)
}
