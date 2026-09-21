# Browser E2E Bug: Admin message reports filter and pagination render raw / wrong state

Date: 2026-09-21

## Scope

- Platform: Browser Admin Web
- Node: Bravo (`http://localhost:3102/admin/`)
- Admin profile: `admin-bravo`
- Page: Access & Activity → Message reports (`/admin/message-reports`)

## Expected behavior

The message reports page should use the shared pagination convention and show translated filter labels.

- Empty first page should show page 1 / 1.
- The removed-report filter should show the localized label (`已移除` / `Removed`), not the internal enum value.

## Actual behavior

On the empty Bravo dataset, switching to the removed filter showed:

```text
REMOVED
...
暂无消息举报
上一页
第 2 / 1 页
下一页
```

## Cause

`admin-web/src/routes/message-reports/message-reports-page.tsx` kept a local one-based `page` state while the shared `Pagination` component requires zero-based page indexes. The filter `Select` also lacked the `items` mapping used by the select value renderer, so it displayed the raw value (`REMOVED`).

## Fix

- Changed local page state to zero-based and computed `skip` as `page * PAGE_SIZE`.
- Reset filters to page `0`.
- Added translated `items` for the report-state select.

## Verification after fix

- `npm run build --prefix admin-web` passed.
- Browser E2E reopened `/admin/message-reports` after clearing the retained Admin profile cache. Active and removed empty states both showed page 1 / 1, and the removed filter displayed the translated label instead of `REMOVED`.
