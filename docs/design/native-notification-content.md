# Shared Native Notification Content

Status: implemented; OS-device visual validation remains outstanding.

## Audit and confirmed decisions

The previous shared Rust projection already supplied unread count, unread mention
state, ordered message previews, and safe status placeholders. Its body joined
multiple preview texts with newlines. Android additionally rendered those texts
through `MessagingStyle`, allowing OS-generated collapsed text and expanded
history to disagree with the shared body. Desktop adapters forwarded Rust body.

No existing design specified single-message count or group sender prefixes. The
following rules were confirmed before implementation:

- Always display the exact unread count, including one. Counts above 99 are not
  shortened to `99+` and are not derived from the number of retained previews.
- Display `[@]` exactly when the Rust unread projection has an unread mention.
  A mention in an older unread message still marks the latest-summary card.
- Group summaries include the selected message's sender name; direct messages do
  not add it. Group identity comes from the existing `GROUP` feed kind.
- Private-preview mode preserves the count and mention prefix, while hiding
  message text, sender identity, timestamps, and avatars. Conversation title
  behavior remains unchanged.

## Body contract

The body is `[localized count][optional @ marker]latest summary`, with no extra
separator between the bracketed prefix and summary.

| Case | English example |
| --- | --- |
| One direct message | `[1 message]Hello` |
| Multiple direct messages with an unread mention | `[101 messages][@]Hello` |
| Group message | `[3 messages]Alice: Hello` |
| Group with unread mention | `[3 messages][@]Alice: Hello` |
| Private preview | `[3 messages][@]New message` |
| Latest message retracted | `[3 messages][Message retracted]` |
| Latest message removed by moderation | `[3 messages][Message removed by administrator]` |

Chinese copy uses `[1条]` / `[3条]`, `新消息`, and the existing localized status
placeholders. English uses singular `message` and plural `messages`. Unknown
language identifiers fall back to English; Chinese language matching retains the
existing case-insensitive `zh` prefix behavior. The app currently ships English
and Simplified Chinese.

Rust selects the highest-sequence unread preview, regardless of input order.
An empty or whitespace-only live preview, missing text, missing/unknown status,
or no unread preview uses generic copy. Retraction and moderation use their safe
placeholders, never the original text. A missing/blank group sender adds no empty
`": "` prefix. Do not fall back to an older message when the latest is empty,
unknown, removed, or retracted. Existing preview text is used as the summary;
this change does not re-parse rich messages or invent a new truncation policy.

The sanitized `messages` payload now contains at most the selected message, or
none in private mode. Its avatar metadata is the only sender-image input forwarded
to Android. No old preview list is retained for an alternate expanded rendering.
`latestSeq` remains the authoritative refresh ceiling, not the selected preview
sequence.

## Language ownership

[LanguageService](../../web/src/app/services/language.service.ts) already writes
and restores `global/language`. Native notifications incorrectly read
`device/language`; [preferences.rs](../../src-tauri/src/native_db/preferences.rs)
now reads the same global record as the UI.

On native initialization without a valid saved selection, the UI persists its
resolved browser/WebView language (`zh-CN` or `en`) so subsequent headless Rust
presentation uses the same choice. Before that first successful persistence,
Rust's absent-value default remains English. Explicit language changes continue
to use the existing global preference. Storage errors are not treated as a
missing native connection. This change does not force redisplay of existing OS
cards merely because language changes; subsequent content generation uses the
current saved language.

Notification enablement, sound, and preview-mode keys remain in their existing
scope. The separately planned
[preference/state table split](client-preferences-and-state-ownership.md) is not
implemented by this work and must not cause privacy preferences to be reset.

## Platform mapping and privacy

- Rust [content.rs](../../src-tauri/src/native_db/notifications/content.rs) owns
  count copy, mention marker, latest selection, sender prefix, and placeholders.
- Android decodes the final body without rebuilding it. Both collapsed content
  and `BigTextStyle` use that exact body. `MessagingStyle` and historical message
  expansion are removed. The forwarded selected avatar is mapped to a large icon;
  private mode forwards none. Badge number, channel, sound, alert timing, target,
  PendingIntent, and click-refresh ceiling are unchanged.
- Android's public lock-screen version remains more restrictive than app-level
  private preview: app title and a generic body only, with no count, mention,
  sender, or conversation metadata. Rust supplies this localized `publicBody`;
  Android does not choose message copy from its system locale. Request cards also
  supply this generic public copy; their main request text/count rules are unchanged.
- Obsolete Android message-placeholder and retired group-summary resources are
  removed; there is no fallback to those strings or old formatting.
- macOS, Windows, and Linux continue forwarding the shared body through their
  existing adapters. No new desktop or negated-platform branch is introduced.

## Read changes and boundaries

Content generation consumes existing authoritative count/mention projections and
filters by the current read position. A later projection can reduce count, remove
the mention marker, and remove a card when count reaches zero. It does not alter
slot counting, local/server read reconciliation, notification identity, mute
policy, alert policy, delivery state, or restoration.

The existing read-update path is reused, not replaced:

1. [ConversationListService.markReadStable](../../web/src/app/services/conversation-list.service.ts)
   calls `commitLocalRead` to advance local read state and submits the read position
   through [UserService.markRead](../../web/src/app/services/user.service.ts).
2. `POST /thread/mark-read` advances the server read position. SSE wakes the client
   to synchronize the compacted ThreadFeed.
3. The resulting Rust notification projection uses the updated read state to
   regenerate the count, mention marker, and latest summary, or remove the card
   when no unread messages remain.

`native_db_advance_thread_read` itself persists local state without directly
invoking OS notification delivery; the renderer applies this local result with
`emitLive=false`. This does **not** mean read updates lack a notification path:
normal notification updates use the server submission and feed synchronization
above. The currently visible conversation also has the existing foreground
suppression/removal path.

Local persistence alone does not guarantee an immediate OS-card update while
offline, after a failed submission, or before feed synchronization completes.
This content-formatting change adds no separate local-read refresh mechanism and
makes no change to submission, retry, or delivery policy. Automated tests here
verify content generated from updated read projections; end-to-end verification
of read submission through OS-card replacement/removal remains a validation
follow-up, not an assumed missing implementation.

## Validation

Per user direction, content expectations use English rather than duplicating the
same behavioral tests in Chinese. Chinese production copy remains supported.

- Rust shared tests cover exact count/singular/plural, English locale variants and
  unknown-language fallback, mention on/off, group/direct sender, out-of-order
  previews, latest-only payload, empty/whitespace/unknown/removed/retracted
  content, private metadata stripping, public copy, updated reads and removal.
- A SQLite preference test verifies the UI's global language record is used and
  malformed values/database failures remain errors.
- Language-service browser tests cover persisted selection, native default
  persistence, unsupported system-language fallback, and delayed restore versus
  explicit selection.
- Android JVM mapping tests verify exact final body/public copy, count, mention,
  privacy payload, target, and refresh ceiling.
- Android instrumentation test `NotificationBodyTest` checks collapsed text and
  expanded text are identical and no `EXTRA_MESSAGES` history is attached. Its
  compilation is checked locally; execution requires a device/emulator.

Completed local validation:

- `cargo test --lib native_db::notifications -- --test-threads=1`: 92 passed.
- Final content-only rerun after test deduplication and missing-field coverage:
  18 passed.
- `cargo test --lib native_db::preferences::notification_tests`: 2 passed.
- Angular `language.service.spec.ts` in Chromium: 4 passed.
- Android `testUniversalDebugUnitTest`: 79 passed; Android instrumentation Kotlin
  compilation also passed. Rust Gradle build was excluded for this Kotlin mapping
  validation; host Rust tests above compiled the shared implementation.
- Changed-file whitespace check and local documentation links passed. A whole-
  workspace whitespace check also reported an existing trailing blank line in
  `src-tauri/src/origin_commands.rs`; that unrelated file was not edited here.

Manual follow-up: inspect English direct/group/private/retracted cards on Android,
including expansion and lock-screen redaction, and smoke-test shared body on
macOS, Windows, and Linux. OEM truncation and OS-controlled rendering remain
outside string-generation unit tests.
