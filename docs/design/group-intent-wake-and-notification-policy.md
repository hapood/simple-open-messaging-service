# Group intent wake and projection notification policy

Status: resolved (2026-09-12). This records the two deferred review findings on
[GroupAuthoredMembershipIntentService](../../src/business/group/membership-intent/group-authored-membership-intent.service.ts)
(from the 2026-09-11 v2-vs-legacy comparison) and the decisions taken. The
[unified group intent decision](./unified-group-intent-decision.md) keeps the
statement-level detail.

## Notification layering (the resolved rule)

The server's job is to make state reachable and to wake the right clients; the
red-dot policy is the client's.

| Layer | Responsibility |
| --- | --- |
| Decision statement | Intent write, projection counter advance, one `GroupRequestProjection` row per manager (all sharing the group's event number), admit `FAN_OUT_GROUP_PROJECTION`, and one inline `RELATIONSHIP_INTENT` feed row for the single affected member. No manager is woken here. |
| `FAN_OUT_GROUP_PROJECTION` executor | Advances each manager's two per-direction watermarks on `AccountThreadState` (`joinRequestEndFeedId` ← `applicationEndId`, `groupInviteEndFeedId` ← `invitationEndId`). The `thread_feed_before_write` trigger turns any movement into a thread-feed item; the executor's `captureThreadStateUpdatesInTx` adds the coalesced SSE wake. Clients pull `/thread/feed-delta` (HTTP-throttled) and decide their own badge. |
| Offline push | Unchanged: it only fires on thread-feed count/preview changes, so projection/watermark movement never pushes. |

Consequences accepted: decision-time flips (accept/reject/complete) move no
manager watermark, so other managers' badges do not decrease until their next
list fetch; badge counting and read positions belong to the client.

## Current behavior (as implemented today)

| Command | Projection write | Manager wake | Member wake | Task admissions |
| --- | --- | --- | --- | --- |
| ACK (manager) | flips APPLICATION rows to `ACCEPTED` | none (executor's job) | local: `RELATIONSHIP_INTENT` feed row + in-process wake; remote: peer intent + content head events | thread content, meta head, departure/reverse when membership changes |
| REVOKE (manager, reject) | flips rows to `REVOKED` | none | member feed row / peer event | none (`departed = false`) |
| REVOKE (manager, kick) | same | none — reached via the meta head fan-out | `GROUP_LEFT` + watermark, departure effects | meta head, thread content, departure, reverse task |
| REQUESTED (manager, invite) | upserts one INVITATION row per manager | none — the admitted task owns it | invitee feed row / peer event, audience open | `FAN_OUT_GROUP_PROJECTION` when manager rows changed |
| REQUESTED (member, apply) | advances `applicationEndId`, upserts one APPLICATION row per manager | none — the admitted task owns it | applicant's own outgoing feed row + wake | `FAN_OUT_GROUP_PROJECTION` when manager rows changed |
| ACK (member, accept invitation) | flips INVITATION rows to `ACCEPTED`; authors side B | none | member feed row + full activation effects | thread content, meta head |
| REVOKE (member, withdraw / decline / leave) | flips own rows to `REVOKED` | none | member feed row + departure effects when rostered | departure/reverse only on leave |

## Topic A (review item 4): resolved as A2

`applyAcceptanceInTx` pushes `recipientUserId`/`recipientFeedId` exactly like
the REVOKE and REQUESTED branches, restoring the manager-driven ACK's
synchronous wake for a local applicant. The content head still travels through
the admitted `FAN_OUT_THREAD_CONTENT` / `FAN_OUT_GROUP_META_HEAD` tasks.

## Topic B (review item 5): resolved

The originally proposed rule — "only a new request triggers projection
notification" — was replaced by the owner with the layering above: **both**
directions notify through the same task-mediated path, and the client decides
what counts for its badge. Three changes landed:

1. **The manager in-process wake loop in `applyRequestInTx` was removed** (the
   admission stays). Managers learn about invitations from the executor's
   watermark advance, not a decision-time push — removing the double wake.
2. **The executor's summed watermark was a bug and is fixed.** It advanced
   `joinRequestEndFeedId` to `applicationEndId + invitationEndId`, so every
   invitation moved the application cursor and erased the direction. It now
   assigns each column from its own number stream with a per-column
   forward-only guard (migration 0009's documented design; the
   `groupInviteEndFeedId` column always existed).
3. **The member-authored family exists**:
   [MemberAuthoredGroupMembershipIntentService](../../src/business/group/membership-intent/member-authored-group-membership-intent.service.ts)
   covers user→group REQUESTED (application), ACCEPTED (invitation
   completion), and REVOKED (withdraw / decline / leave), so the application
   direction has a v2 admission source. Legacy inbound paths are unchanged.
