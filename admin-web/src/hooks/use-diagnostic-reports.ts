import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  deleteDiagnosticReport,
  listDiagnosticReports,
  type DiagnosticReportQuery,
} from '@/api/diagnostic-reports'

/** Admin diagnostic-reports list (paginated + searchable). `placeholderData: prev` avoids a flash on
 *  page/search change. */
export function useDiagnosticReports(q: DiagnosticReportQuery) {
  return useQuery({
    queryKey: ['admin', 'diagnosticReports', q],
    queryFn: () => listDiagnosticReports(q),
    placeholderData: (prev) => prev,
  })
}

/** Delete one report; invalidates the list so the row disappears on success. */
export function useDeleteDiagnosticReport() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => deleteDiagnosticReport(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'diagnosticReports'] }),
  })
}
