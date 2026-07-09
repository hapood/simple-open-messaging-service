import { request } from '@/api/client'
import type { Ban } from '@/types/api'

export function listBans(): Promise<Ban[]> {
  return request<Ban[]>('/admin/bans')
}

export function unban(payload: { ip?: string; account?: string }): Promise<void> {
  return request<void>('/admin/bans/unban', payload)
}
