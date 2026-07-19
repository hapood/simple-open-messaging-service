import { request } from '@/api/client'
import { API_BASE } from '@/lib/constants'
import { getAccessToken } from '@/auth/token-store'
import { refreshOnce } from '@/auth/refresh-singleton'

/** One diagnostic-report row (the admin list view). `manifest` is the client-supplied version/platform
 *  snapshot; `createdAt` is a ms-epoch number (backend Date serialization convention). */
export interface DiagnosticReportListItem {
  id: number
  reporter: { id: number; name: string; account: string; avatar: string }
  bundleBytes: number
  manifest: Record<string, unknown>
  status: string
  createdAt: number
}

export interface DiagnosticReportListResult {
  list: DiagnosticReportListItem[]
  total: number
}

export interface DiagnosticReportQuery {
  skip?: number
  take?: number
  search?: string
}

/** List reports (POST /admin/diagnostics) — the reporter identity is JOINed server-side so reports from
 *  different users are distinguishable. `search` matches reporter name/account. */
export function listDiagnosticReports(
  q: DiagnosticReportQuery,
): Promise<DiagnosticReportListResult> {
  return request<DiagnosticReportListResult>('/admin/diagnostics', q)
}

/** Soft-delete one report (POST /admin/diagnostics/:id/delete) — the row is hidden + its bundle file is
 *  unlinked when no other row references it. */
export function deleteDiagnosticReport(
  id: number,
): Promise<{ deleted: boolean; unlinked: boolean }> {
  return request(`/admin/diagnostics/${id}/delete`)
}

/**
 * Download one diagnostic bundle as a .tar.gz. The unified `request()` client parses every response as
 * JSON, so this does a raw authenticated GET, streams the bytes into a Blob, and triggers an anchor click
 * (mirrors the 2FA backup-codes download in security-page). Throws on a non-2xx.
 */
export async function downloadDiagnosticReport(id: number): Promise<void> {
  const url = `${API_BASE}/admin/diagnostics/${id}/download`
  // Raw authenticated GET (the unified request() client parses JSON, unsuitable for a binary stream).
  const doFetch = (): Promise<Response> => {
    const at = getAccessToken()
    return fetch(url, {
      method: 'GET',
      headers: { ...(at ? { Authorization: `Bearer ${at}` } : {}) },
    })
  }
  let res = await doFetch()
  // Mirror request()'s 401 handling so a download on a page left open past the access-token lifetime
  // still succeeds after a single refresh+retry.
  if (res.status === 401 && (await refreshOnce())) {
    res = await doFetch()
  }
  if (!res.ok) throw new Error(`download HTTP ${res.status}`)
  const blob = await res.blob()
  const blobUrl = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = blobUrl
  a.download = `report-${id}.tar.gz`
  a.click()
  URL.revokeObjectURL(blobUrl)
}
