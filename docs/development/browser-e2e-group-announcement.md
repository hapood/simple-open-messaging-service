# Browser E2E: Group announcements

Status: **planned; not yet run in a browser**. This checklist supplements the group and cross-domain workflows in `browser-e2e-test-plan.md`. Use isolated test accounts and two servers with federation enabled. Record browser, viewport, server versions, accounts, observed feed coordinates, screenshots, and any failure in the normal E2E result template. Do not paste announcement content containing private information into logs.

## Local group and visibility

1. Create a group as a local owner. Open its chat on desktop and narrow/mobile viewports. An initially cleared announcement shows neither a loudspeaker nor an automatic popup. An ordinary member cannot access the editor; the local owner and a local admin can find **Group announcement** under the chat More → group-info panel.
2. Publish a multiline announcement including emoji and literal `<b>not markup</b>`. Check the loudspeaker beside the group name, the chatbox-scoped popup (over both message list and composer), plain-text rendering and line wrapping, focus/keyboard-back/backdrop dismissal, and that the message history/scroll position does not move. Close it, leave and reopen the chat: it must not reopen automatically. Click the loudspeaker: it should still open manually.
3. Edit the text as an admin: it must get a new Group Meta `feedId`, not a message sequence, and auto-open once again. Change it rapidly twice while one client is offline: after reconnect only the newest compacted text may be shown, not intermediate edits. Check that a stale acknowledgement of an older displayed popup does not suppress the newest edit.
4. Try empty text, 4097 Unicode code points, double submit, unauthorized member edit and a dissolved/read-only group. The UI should prevent invalid submissions and the server should reject unauthorized writes. Clearing requires confirmation. Clear and revisit: the loudspeaker and automatic popup disappear; the known `text: null` projection must not be confused with an unknown/unfetched announcement.
5. Open the same group on two devices/sessions of one account. View the popup on device A. Device B should obtain the new per-account read watermark through the existing `THREAD_FEED_UPDATED` cursor pull and must not auto-open that announcement after convergence; a later edit should auto-open on each device once. No new SSE event type or announcement text should appear in SSE payloads.

## Federation and recovery

6. Have a remote member join an origin group. Publish/edit/clear as an origin-local owner/admin. The remote mirror should receive the current announcement through Group Meta and display it with the same loudspeaker and popup behavior. A remote admin cannot publish an announcement on the mirror. Other group/profile/roster updates must not cause an already read announcement to reappear.
7. With the remote client offline, advance and compact the announcement several times, including an explicit clear; reconnect and check that the latest current projection wins. Force a bounded full recovery with multiple pages: while recovery is incomplete the cached announcement must not be displayed. When complete, a returned announcement from an earlier page should be retained even if the last page contains no announcement; a full drain containing none makes it unknown rather than a known clear. Subsequent delta catches up when the origin replaced it above the fixed full boundary.
8. Revoke the remote relationship and attempt further reads: no more announcement data should be served. Reauthorize, recover the current projection, and verify that a stale cached copy is never displayed as current before the new Group Meta head is reached.

## Android/Tauri follow-up

9. Repeat the popup, backend acknowledgement, offline/online full recovery, and hardware-back steps in the Android app. Restart between pages of full recovery and verify that native SQLite resumes the candidate projection without displaying an uncommitted announcement. The UI is the shared Angular chatbox; there is no independent native announcement popup.
