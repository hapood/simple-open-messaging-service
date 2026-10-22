import { requestGet } from '@/api/client'
import type { PublicConfig } from '@/lib/constants'

/** Public site config (registration flag + loginMode) — unauthenticated GET /config. Drives admin-side
 *  gating such as whether the create-user password field is shown/required. */
export function getPublicConfig(): Promise<PublicConfig> {
  return requestGet<PublicConfig>('/config')
}
