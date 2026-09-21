# Browser E2E Bug: Admin diagnostic reports page duplicates description

Date: 2026-09-21

## Scope

- Platform: Browser Admin Web
- Node: Bravo (`http://localhost:3102/admin/`)
- Admin profile: `admin-bravo`
- Page: Logs → Client diagnostics (`/admin/logs/diagnostics`)

## Expected behavior

The diagnostic reports page should show its page description once above the table.

## Actual behavior

The same description is rendered twice:

```text
客户端上报的诊断日志包（Rust 日志 + 网页控制台 + 版本信息），供现场支持使用。

客户端上报的诊断日志包（Rust 日志 + 网页控制台 + 版本信息），供现场支持使用。
```

The reports API itself succeeded and returned an empty list (`total: 0`), so this is a visible Admin UI rendering defect rather than a backend data failure.

## Evidence

Browser script `scripts/.tmp-admin-diagnostics-duplicate-desc.mjs` opened `/admin/logs/diagnostics` and counted repeated visible lines. Result:

```json
{
  "apiStatus": 200,
  "total": 0,
  "descDuplicate": [
    "客户端上报的诊断日志包（Rust 日志 + 网页控制台 + 版本信息），供现场支持使用。",
    2
  ]
}
```

## Likely source

`admin-web/src/routes/diagnostic-reports/diagnostic-reports-page.tsx` renders `t('diagnosticReports.desc')` in two adjacent `<p>` blocks.


## Fix

Removed the duplicate `<p>` rendering `t('diagnosticReports.desc')` from `admin-web/src/routes/diagnostic-reports/diagnostic-reports-page.tsx`.

## Verification after fix

- `npm run build --prefix admin-web` passed.
- Browser E2E reopened `/admin/logs/diagnostics` after clearing the retained Admin profile cache. The description appeared exactly once and `POST /api/v1/admin/diagnostics` still returned success with `total: 0`.
