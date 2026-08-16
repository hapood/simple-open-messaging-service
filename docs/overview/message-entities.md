# SOMS message inline-entity implementation

> This document describes the SOMS editor, storage, and rendering implementation. The normative
> wire grammar, validation, escaping, and failure behavior are defined only by
> [Federation v1 Message](../../spec/v1/message.md#51-inline-entities-and-mentions).

SOMS stores rich-text entities inline in `Message.content`. The database keeps the serialized text;
it does not maintain a second entity table. This is an implementation choice, not a Federation
requirement.

## Editor and serialization

An entity selected from the composer roster is represented as an editor mention node. The serializer
emits the canonical v1 token defined by the protocol. Text typed or pasted by a user remains plain
text, even if it resembles a valid entity token; the serializer escapes it according to the protocol.

The local codec maintains this round-trip invariant:

```text
toDisplayText(escapePlainText(input)) === input
```

## Server integration

The SOMS server validates a user mention against the active thread audience before first persistence.
For a group submission, the group origin validates the mention again against its authoritative group
state. These checks implement the protocol rules; they do not define a second wire grammar.

The readable label is a display snapshot. SOMS may derive it from the current profile when composing
a message, but identity and notification matching use the stable entity ID.

## Rendering

The parser returns text and typed entity nodes, never HTML. The Angular client renders them with text
nodes and components. Unknown or malformed input follows the fallback behavior defined by the
normative specification.
