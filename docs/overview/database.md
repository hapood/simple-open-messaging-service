# Data Model

SOMS uses PostgreSQL, with the data model defined via Prisma 7 (Rust-free client + `@prisma/adapter-pg` driver adapter; `relationJoins` is GA). Schema source file: [prisma/schema.prisma](../../prisma/schema.prisma); CLI configuration is in [prisma.config.ts](../../prisma.config.ts).

## Table of Contents

- [Relation Overview](#relation-overview)
- [Model Details](#model-details)
- [Enums](#enums)
- [Unique Constraints](#unique-constraints)
- [Design Notes](#design-notes)

---

## Relation Overview

```
                         ┌──────────────┐
                         │   UserExtra  │  1:1
                 ┌──────▶│  name, avatar│◀──────┐
                 │       └──────────────┘       │
                 │ 1:1                           │
          ┌──────┴──────┐                ┌───────┴───────┐
          │     User    │───────────────▶│  userNotiBox  │
          │(account/pwd)│  1:1           │ hasUrFriendReq │
          └──────┬──────┘                └───────────────┘
                 │
       ┌─────────┼──────────────────────────────┐
       │ 1:N     │ 1:N                            │ 1:N
       ▼         ▼                                ▼
 ┌──────────┐  ┌────────────────────┐      ┌───────────┐
 │  Group   │  │  UserMessageThread │      │GroupMember│
 │ (owner)  │  │ (user↔thread join) │      │ groupId,  │
 └────┬─────┘  └─────────┬──────────┘      │  userId   │
   1:1│  1:N         N:1 │                     └─────┬─────┘
      │   ┌─────────────┘ 0..1                     │  N:1
      ▼   ▼                                        ▼
  ┌─────────────────┐                         (Group / User)
  │  MessageThread  │  ◀──── Message  1:N ──── (contentType,
  │  type: P2P|GROUP│        BigInt id          content,
  └─────────────────┘                         creator)

  Standalone table: Notify (userId, type, content: Json)
```

## Model Details

### User — User Account

| Field | Type | Description |
| --- | --- | --- |
| `id` | Int (PK, auto-increment) | User ID |
| `account` | VarChar(31), unique | Login account name |
| `hashPwd` | VarChar(127) | argon2 password hash |
| `isForeigner` | Boolean | Whether this is an external (cross-domain) user |
| `domain` | VarChar(63)? | Affiliated domain |
| `createdAt` / `updatedAt` | DateTime | Creation/update time |
| `isDeleted` | Boolean | Soft-delete flag |
| `userExtraId` | Int (unique, FK→UserExtra) | 1:1 profile |
| `userNotiBoxId` | Int (unique, FK→userNotiBox) | 1:1 notification box |

Composite unique: `(account, domain)` — the account name is unique within a single domain, supporting cross-domain isolation.

### UserExtra — User Profile

| Field | Type | Description |
| --- | --- | --- |
| `id` | Int (PK) | |
| `name` | String | Nickname (defaults to account at registration) |
| `avatar` | String | Avatar (URL or identifier; initially an empty string) |
| `createdAt` / `updatedAt` | DateTime | |

### userNotiBox — User Notification Box

| Field | Type | Description |
| --- | --- | --- |
| `id` | Int (PK) | |
| `hasUrFriendReq` | Boolean | Whether there is a pending (unconsumed) friend request |

> Prisma has modeled this, but the current code does not read or write this table (NotifyModule is not wired up).

### Group — Group

| Field | Type | Description |
| --- | --- | --- |
| `id` | Int (PK) | |
| `name` | String | Group name (≤31 characters) |
| `ownerId` | Int (FK→User) | Group owner |
| `avatar` | String | Group avatar |
| `threadId` | Int (FK→MessageThread) | Group message thread (1:1) |
| `createdAt` / `updatedAt` | DateTime | |

### GroupMember — Group Member

| Field | Type | Description |
| --- | --- | --- |
| `id` | Int (PK) | |
| `groupId` | Int (FK→Group) | |
| `userId` | Int (FK→User) | |

Composite unique: `(groupId, userId)` — prevents duplicate group membership.

### UserMessageThread — User↔Thread Association (Core)

This is a polymorphic association table that links a user to the threads they participate in (P2P or GROUP); it is the core of the thread lifecycle.

| Field | Type | Description |
| --- | --- | --- |
| `id` | Int (PK) | |
| `userId` | Int (FK→User) | Owning user |
| `status` | UserMessageThreadStatus | Thread status (see below) |
| `toObjType` | MessageThreadType | Target type `P2P` / `GROUP` |
| `toObjId` | Int | Target ID (user ID or group ID) |
| `reqMessage` | String | Friend request note |
| `threadId` | Int? (FK→MessageThread) | Associated message thread (bound after the friend is approved) |
| `lastRead` | BigInt? | Read position (message ID) |
| `isDeleted` | Boolean | |
| `createdAt` / `updatedAt` | DateTime | |

**P2P semantics**: When A and B are friends, each has one record, with `toObjType=P2P` and `toObjId` pointing to the other party; after approval, the two records share the same `threadId`.

### MessageThread — Message Thread

| Field | Type | Description |
| --- | --- | --- |
| `id` | Int (PK) | |
| `type` | MessageThreadType | `P2P` / `GROUP` |
| `isDeleted` | Boolean | |
| `createdAt` / `updatedAt` | DateTime | |

Referenced by `UserMessageThread.threadId`, `Message.threadId`, and `Group.threadId`.

### Message — Message

| Field | Type | Description |
| --- | --- | --- |
| `id` | **BigInt** (PK, auto-increment) | Message ID (must be transmitted as a string) |
| `contentType` | ContentType | Message type |
| `content` | String | Text content or JSON (JSON for the INVITE type) |
| `threadId` | Int (FK→MessageThread) | Owning thread |
| `creator` | Int | Sender userId |
| `isDeleted` | Boolean | |
| `createdAt` / `updatedAt` | DateTime | |

### Notify — Notification (Standalone Table, Unconsumed)

| Field | Type | Description |
| --- | --- | --- |
| `id` | BigInt (PK) | |
| `userId` | Int | Recipient |
| `type` | NotifyType | Currently only `FRIEND_REQUEST` |
| `content` | Json | Notification payload |

## Enums

```prisma
enum MessageThreadType {
  P2P      // peer-to-peer thread
  GROUP    // group thread
}

enum UserMessageThreadStatus {
  FROM_PENDING   // sent by me, awaiting their action
  TO_PENDING     // received, awaiting my action
  APPROVED       // established
  BLOCKED        // blocked
  DELETED        // deleted
}

enum ContentType {
  PURE_TEXT   // plain text
  INVITE      // group invite (content is JSON)
  IMAGE
  VIDEO
  FILE
  AUDIO
}

enum NotifyType {
  FRIEND_REQUEST
}
```

## Unique Constraints

| Table | Constraint | Meaning |
| --- | --- | --- |
| `User` | `(account, domain)` | The account name is unique within a domain |
| `GroupMember` | `(groupId, userId)` | The same user is unique within the same group |
| `UserMessageThread` | `(userId, toObjType, toObjId)` | A user has only one record per target |
| `UserMessageThread` | `(userId, threadId)` | A user has only one record per thread |
| `User` / `UserExtra` / `userNotiBox` | 1:1 (`userExtraId` / `userNotiBoxId` unique) | One-to-one relationship |

## Design Notes

1. **Polymorphic thread association**: `UserMessageThread` uses `(toObjType, toObjId)` to simultaneously express "a P2P thread with a certain user" and "a thread with a certain group", avoiding separate tables.
2. **Status-driven lifecycle**: The establishment/blocking/deletion of a thread is entirely expressed by `UserMessageThread.status`; a friend request is simply one state transition (see [architecture.md → Friend Request State Machine](./architecture.md#friend-request-state-machine)).
3. **Lazy thread binding**: During the friend-request phase `threadId` is empty; `MessageThread` is only created and back-filled in `approveFriendRequest`, avoiding meaningless empty threads.
4. **BigInt message IDs**: `Message.id` / `Notify.id` / `UserMessageThread.lastRead` use BigInt, uniformly serialized to strings by the global `SerializeInterceptor` (see [architecture.md → Unified Response Format](./architecture.md#unified-response-format)).
5. **Group = Thread**: Each group has a 1:1 relationship with a `MessageThread(GROUP)`, and group messages are written directly to that thread; membership is reflected in both `GroupMember` and `UserMessageThread`.
