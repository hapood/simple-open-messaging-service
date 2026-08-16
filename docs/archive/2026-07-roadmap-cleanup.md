# July 2026 Roadmap Cleanup

This note records why the former long-form roadmap documents were retired. It is
an index, not a copy of the superseded plans; Git history remains available when
implementation-era detail is needed.

## Consumer UI redesign

The five `consumer-ui-*` drafts described a proposed token system, responsive
shell, core chat wireframes, an implementation sequence, and a manual acceptance
matrix. A source review found that their central architecture is now implemented:

- semantic `--app-*` and chat-specific `--im-*` tokens live in
  `web/src/app/assets/_tokens.scss`;
- the shell and chat surfaces support responsive layouts;
- keyboard, safe-area, dynamic-viewport, and native-composer handling have
  dedicated implementation paths;
- light/dark themes, English/Chinese localization, focus treatment, and reduced
  motion are part of the client;
- message scrolling, composer behavior, and core presentation have focused unit
  tests and playground coverage.

The drafts were not maintained as completion trackers and their unchecked boxes
could no longer be treated as current project state. Their durable product and
verification rules were consolidated into
[Consumer UI guidelines](../design/consumer-ui-guidelines.md). The following
files were retired:

- `consumer-ui-redesign-principles.md`
- `consumer-ui-token-draft.md`
- `consumer-ui-core-wireframes.md`
- `consumer-ui-implementation-plan.md`
- `consumer-ui-acceptance-matrix.md`

## Runtime FCM configuration

`push-fcm-runtime-config.md` was an implementation plan whose shipped design had
already diverged from its proposed endpoint. The universal Android package now
receives the self-hoster's public Firebase client configuration through the shell
compatibility payload and initializes Firebase at runtime. The maintained source
is [FCM Android integration](../../src-tauri/FCM_ANDROID_PATCH.md), so the roadmap
copy was removed.

## Protocol stack

The original protocol plan mixed completed migrations, retrospective design
notes, rejected ideas, and a few production-readiness tasks. Stable HTTP behavior
is already documented by [the API reference](../api/api.md) and generated
OpenAPI. The roadmap was reduced to only the remaining production work.

## Android calls

The original follow-up captured a stabilization session in detail. Code review
showed that step-code localization, avatar palette consistency, and several log
cleanups had landed. The document was reduced to device verification and the
remaining incoming-ring reliability questions.
