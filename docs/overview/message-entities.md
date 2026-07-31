# Message inline entities

SOMS stores rich text entities inline in `Message.content`. The wire and storage
format stays a string, so existing message replication and persistence do not
need a second entity table.

## Version 1 syntax

The generic form is:

```text
[<sigil><label>](soms://<entity-type>/<percent-encoded-id>?v=<version>)
```

A user mention is:

```text
[@张三](soms://user/zhangsan%40example.com?v=1)
```

The readable prefix is deliberately `[@张三]`: text search can find the display
snapshot, while the URI contains the stable canonical account. More entity
types can be added without changing the outer grammar:

```text
[@所有人](soms://audience/all?v=1)
[#发布计划](soms://topic/release?v=1)
```

Version 1 initially authors only `user` entities. Unknown types and versions
must degrade to their readable fallback and must never make a message
unrenderable.

## Escaping and authorship

An entity selected from the composer roster is an editor mention node. Its
serializer emits an unescaped entity:

```text
[@张三](soms://user/zhangsan%40example.com?v=1)
```

Text typed or pasted by a user remains text, even when it is byte-for-byte the
same as the protocol. The plain-text serializer escapes the opening bracket:

```text
\[@张三](soms://user/zhangsan%40example.com?v=1)
```

Rendering removes that escape and shows the literal input. A literal backslash
is encoded as `\\`. The codec must maintain this invariant:

```text
toDisplayText(escapePlainText(input)) === input
```

Only `\\` and `\[` have escape meaning. Other backslashes remain literal for
compatibility with legacy text such as Windows paths.

Labels escape `\`, `[` and `]` with a preceding backslash. Entity IDs and query
parameters use standard URI percent encoding.

## Failure behavior

- An incomplete or malformed token is ordinary text.
- An escaped token is ordinary text.
- A valid entity with an unknown type/version is exposed as a generic entity;
  a consumer without a handler renders its sigil and label.
- Parsing never returns HTML. UI clients create text nodes/components and must
  not render message content through unsanitized `innerHTML`.

## Canonicalization

Clients supply the stable account selected from the current group roster.
Before persistence, the server will validate that account against the active
roster and rewrite the label from the authoritative current profile. That
integration is separate from the codec itself.
