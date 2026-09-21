# Bug: Local group dissolve logs unknown `GROUP_DISSOLVED` system message type

## Status

Fixed on 2026-09-21, verified in the browser lab.

## Scope

- Platform: Web Chromium persistent context
- Node: Bravo (`http://localhost:3102`)
- Account: `charlieg0921`
- Group: disposable local group `LOCAL-DISSOLVE-1789995820770`

## Reproduction

1. Charlie creates a new local group named `LOCAL-DISSOLVE-1789995820770`.
2. Charlie opens the group info panel and selects `解散群聊`.
3. Confirm the dissolve.
4. Reload the browser and reopen the dissolved group.

## Expected

The dissolved group thread renders its system notice without client console
errors. The composer remains unavailable after dissolve and after reload.

## Actual

The user-visible dissolve state is mostly correct: the composer is hidden and
the thread shows `群聊已解散。`. However, the Web client logs this console error
when rendering the dissolved system event, and logs it again after reload:

```text
[system-message] unknown system message type {"type":"GROUP_DISSOLVED"}
```

Screenshot evidence:
`/tmp/soms-browser-e2e/bug-local-group-dissolve-unknown-system-message.png`.

## Notes

This does not appear to block the dissolve operation itself. The bug is in the
client system-message rendering coverage for the `GROUP_DISSOLVED` event type.

## Fix

`SystemRowComponent` now renders `GROUP_DISSOLVED` with the localized
`chat.systemMessage.groupDissolved` label instead of falling back to the unknown
system-message path.

## Verification

- `npm test --prefix web -- --watch=false --include src/app/components/message-cards/system-row/system-row.component.spec.ts`
- `npm run build:debug --prefix web`
- Browser lab with a fresh built frontend after clearing Charlie's browser cache:
  disposable local group `LOCAL-DISSOLVE-1789996693578` dissolved and reloaded;
  the system row rendered `群聊已解散`, the composer remained hidden, and collected
  browser `consoleErrors` / `pageErrors` were empty.
