# Admin Logs Review and Follow-up Plan

Status: output-level authorization and auditing have been implemented. Other findings remain deferred; the original review evidence below is retained where applicable.

## Scope and Evidence

Review target: `http://localhost:3101/admin/logs`, including live logs, historical search, client diagnostic reports, and their backend services.

The URL returned HTTP 200, but the review did not use an authenticated browser session. Findings are primarily based on the current working-tree implementation, not a visual acceptance test or confirmation that the deployed server matches that implementation. The working tree contained unrelated in-progress changes, which were left untouched.

Overall assessment: the module provides a basic log viewer, but needs stronger stream reliability, authorization, bounded historical queries, and access to structured diagnostic information before it is a dependable troubleshooting tool.

## Priority 1: Correctness and Authorization

### 1. Idle live streams reconnect unnecessarily and replay duplicate records

Evidence:

- `admin-web/src/hooks/use-log-stream.ts` assumes a 25-second heartbeat and aborts a stream after roughly 60 seconds without a parsed event.
- `src/logger/log-viewer.service.ts` emits log records, but no heartbeat.
- Each connection replays the server ring buffer; the frontend retains existing records across reconnects and appends the replay without deduplication or a resume cursor.

Impact:

- Quiet periods, especially at the default ERROR output level, cause unnecessary reconnects.
- Replayed records appear multiple times and can evict other records from the browser's 1,000-record retention window.
- Previously cleared records can reappear after reconnection.

Follow-up:

- Define an explicit heartbeat contract understood by the client parser and watchdog.
- Introduce stable record identity and a reconnect/resume policy, including a process-restart policy.
- Define clear-view semantics independently from server retention.
- Test idle connections, reconnects, replay boundaries, buffer eviction, and clearing.

### 2. Output-level authorization and auditing (implemented)

- `src/logger/log-viewer.controller.ts` now requires `ADMIN` or `SUPER_ADMIN` for output-level mutations, enforced by `AdminRolesGuard` after authentication.
- `VIEWER` retains output-level, history, and live-stream read access.
- Changes are audited as `logs.output_level.set`; guard-rejected requests do not execute the mutation or its audit interceptor.
- The frontend disables the global output selector for read-only administrators and guards its change callback.
- The setting still controls process-local console, file, and live-stream production, not an individual viewer filter.
- PostgreSQL-backed role-matrix/audit coverage is in `test/admin-rbac.e2e-spec.ts`; frontend read-only coverage is in `admin-web/src/routes/logs/logs-live-page.spec.tsx`.

### 3. Diagnostic bundle upload and deletion are not coordinated

Evidence:

- `src/diagnostics/diagnostics.service.ts` publishes a bundle file before inserting its report row.
- `src/diagnostics/diagnostics-gc.service.ts` deletes a file when a separate database query finds no live reference.
- Per-report deletion similarly checks references before unlinking, without coordination with uploads of the same content-addressed file.

Possible interleaving:

1. An upload publishes its file.
2. Orphan GC finds no report row and removes that file.
3. The upload inserts the row and reports success.
4. Download later returns a missing-file error.

A new upload of an existing digest can also race with reference checking and deletion.

Related issue: the five-minute per-user upload window uses a separate read-before-insert check, so concurrent uploads can pass the check together.

Evidence limitation: these risks were identified from execution ordering; PostgreSQL-backed concurrent reproductions were not run.

Follow-up:

- Establish a coordinated publication/reference/deletion protocol for content-addressed bundles.
- Make per-user admission atomic.
- Preserve the repository's database lock-mode and resource-ordering requirements.
- Add PostgreSQL-backed tests for upload versus GC, upload versus delete, shared digests, and concurrent admission.

## Priority 2: Historical Query Safety and Stability

### 4. The historical scan limit is not a strict byte or memory bound

Evidence in `src/logger/log-viewer.service.ts`:

- The limit is checked before reading a whole file.
- `readFile` loads that whole file, even when only a small portion of the scan budget remains.
- Accounting uses JavaScript string length rather than UTF-8 bytes.
- Each file is split and JSON-parsed on the main thread.
- Every matching record is retained before slicing the requested page.

Impact:

- Two files near the default 50 MB rotation size can cause a query with a 64 MB scan budget to read close to 100 MB.
- Decoded strings, split lines, and parsed objects increase memory use beyond input size.
- Even a small result page performs the entire scan; concurrent queries can affect API responsiveness.

Follow-up:

- Enforce the byte budget during bounded reads, with explicit partial-line handling.
- Retain only records needed for the requested result rather than all matches.
- Bound CPU work and concurrent searches, and define cancellation behavior.
- Describe truncated results accurately: unscanned data may contain matches, but matching older records are not guaranteed.
- Test multibyte text, oversized files, malformed/partial lines, scan boundaries, and concurrent requests.

### 5. Offset pagination does not provide a stable historical result set

Evidence:

- `admin-web/src/routes/logs/history-panel.tsx` requests offset pages.
- Each backend request rescans the latest current file and archives without a stable search boundary or cursor.

Impact: new writes between page requests can shift offsets and cause repeated or skipped records while browsing.

Follow-up:

- Define stable pagination using a search boundary and suitable cursor/record identity.
- Include rotation and retention behavior in that contract.

## Priority 3: Troubleshooting Usability

### 6. Structured fields are captured but largely inaccessible in the viewer

Evidence:

- `admin-web/src/routes/logs/log-line.tsx` and `admin-web/src/routes/logs/history-panel.tsx` display timestamp, level, context, and message.
- There is no detail view for error stacks, request IDs, request/response fields, scope, task ID, or other structured data.
- Historical substring search only examines `msg` and `context` in `src/logger/log-viewer.service.ts`.

Impact: operators may have a request or task identifier but cannot find or inspect the relevant information through this page unless it also appears in message text.

Follow-up:

- Add expandable structured details and copy/export support with appropriate sensitive-data handling.
- Support explicit correlation-field searches and navigation.
- Keep text summaries readable without discarding access to full diagnostic information.

### 7. Viewer filtering and global production settings need separate controls

Evidence:

- The live page exposes the global output threshold but no independent local level or keyword filter.
- The historical API supports time bounds, but the history page provides no time-range inputs.
- Historical level options omit TRACE and FATAL.

Follow-up:

- Separate “produce these logs on the server” from “show these records in my view.”
- Add local live-view filters and historical time-range controls.
- Provide all supported levels and label minimum-severity semantics clearly.

### 8. Client diagnostic-report functionality has incomplete integrations

Evidence:

- `admin-web/src/routes/diagnostic-reports/diagnostic-reports-page.tsx` displays a `shell` manifest field.
- `web/src/app/services/diagnostics-report.service.ts` does not supply that field, so reports from the current uploader display a placeholder there.
- The diagnostic-report page exposes Delete without checking the user's role, although the backend restricts deletion.
- The default 90-day retention in `src/diagnostics/diagnostics-gc.service.ts` is applied only when GC is invoked. No automatic invocation was found; the page has no GC action.

Follow-up:

- Align displayed version fields with the actual manifest contract.
- Hide or disable unauthorized actions consistently.
- Add an explicit, observable retention execution mechanism; do not present a retention duration as automatically enforced until it is.

## Verification Performed

Commands:

```sh
npm test -- src/logger/log-viewer.service.spec.ts src/logger/log-level.service.spec.ts
npm test --prefix admin-web -- src/routes/logs/logs-live-page.spec.tsx
```

Results:

- Backend: 2 test files, 8 tests passed.
- Frontend: 1 test file, 3 tests passed.

The original tests did not establish correctness for these findings. Follow-up verification now includes VIEWER mutation rejection and successful output-level audit records in `test/admin-rbac.e2e-spec.ts`, plus frontend read-only control coverage. Idle heartbeats, reconnect deduplication, hard scan budgets, and concurrent diagnostic publication/deletion remain unverified.

## Recommended Implementation Order

1. Fix live-stream heartbeat/resume behavior (output-level authorization/auditing is complete).
2. Coordinate diagnostic publication/deletion and enforce atomic upload admission.
3. Implement bounded historical reading and stable pagination.
4. Add structured details, correlation searches, time ranges, and local viewer filters.
5. Complete diagnostic manifest, permission, and retention integrations.

Recheck the current implementation before starting each item: this document records a working-tree review, not a permanent specification of the codebase.
