# `INVITE` Message

Status: `RELEASE CANDIDATE` (`v1.0.0-rc.0`)

This document defines the group-invitation display card in a P2P timeline. It is a snapshot taken at send time, not membership authority; authoritative group membership converges through state-feed. See [Message Envelope](./envelope.md) for the shared outer message shape.

## 1. Content schema

```ts
interface GroupInviteContent {
  group: GroupAccount;
  groupName: string;
  groupDomain: Domain;
}
```

This is a closed schema with no optional fields.

## 2. Combined constraints

- The outer message thread MUST be the P2P thread containing the inviter and invitee.
- The outer message `author` identifies the inviter; content does not repeat the inviter.
- `group` MUST be a valid `GroupAccount` beginning with `!`.
- `group/groupDomain` MUST form a valid GROUP `ThreadAddress` identity.
- `groupName` is an untrusted display snapshot. v1 requires only a string and does not require it to be non-empty.
- The outer message `assets` MUST be empty; the group avatar is resolved from authoritative group state or profile.
- Invitation acceptance or rejection MUST converge through a state-feed membership intent and origin `GROUP_META`; it cannot be expressed by modifying the INVITE message.

## 3. Complete example

```json
{
  "thread": {
    "type": "P2P",
    "participants": [
      { "account": "alice", "domain": "a.example" },
      { "account": "bob", "domain": "b.example" }
    ]
  },
  "author": { "account": "alice", "domain": "a.example" },
  "seq": 73,
  "originSeq": null,
  "originCreatedAt": null,
  "createdAt": 1770000020000,
  "contentType": "INVITE",
  "content": "{\"group\":\"!engineering\",\"groupName\":\"Engineering\",\"groupDomain\":\"groups.example\"}",
  "assets": []
}
```

## 4. Required rejections

A consumer MUST reject at least the following cases:

- The message is in a GROUP thread.
- P2P participants do not include the inviter or are not exactly two distinct addresses.
- Content repeats the inviter or invitee, carries an avatar locator, or contains another unknown field.
- `group` is not a valid `GroupAccount`.
- `groupDomain` is not a canonical Domain.
- `groupName` is not a string.
- The outer message `assets` is non-empty.
