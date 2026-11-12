# Native server setup and authentication transitions

Rust owns the native server configuration. The browser remains a same-origin host and does not use this setup flow.

## Configuration flow

The Angular setup page serializes submissions with RxJS. Verification and the advertised-address confirmation are cancellable. Cancelling also releases a native setup ID that arrives after the page has closed.

Submitting the decision is the commit boundary. The page disables dismissal and duplicate submissions. Once Rust admits the commit, an independent task owns persistence and endpoint selection until success or failure, even if the IPC caller disappears. Conflicting native login operations fail immediately rather than queueing.

Rust stores the primary and optional backup together in `server_origins.json`, using an atomic file replacement. Endpoint selection is serialized with persistence; it must not reacquire the selection lock while still holding it.

Android preferences are a presentation mirror of the committed Rust configuration. They are refreshed at cold start and never write configuration back into Rust. Desktop and Android use the same Rust login-time endpoint selection.

## Authentication boundary

`AuthLifecycle` describes the native transition currently executing: idle, server configuration commit, or login preparation/restoration/activation. It does not remain occupied while the user edits a form or while HTTP authentication waits for a response.

Between commands, a setup ID owns cancellable verification and a prepared login UUID owns authentication. Configuration commits invalidate preparations for the previous server, so late authentication responses cannot activate them. A fresh login must obtain a new preparation after that boundary.

After credential activation, initialization and synchronization belong to the active `LoginConnection` and its cancellation epoch, not to `AuthLifecycle`.

## Configuration compatibility

The old `api_origin` and `api_origin_secondary` files and Android-origin fallback are no longer read. Existing installations that only have those settings must configure their server again. There is no automatic conversion or legacy setter endpoint.

## Implementation and validation

- [Native setup](../../src-tauri/src/server_setup.rs): verification cancellation, atomic persistence, detached commit lifetime, and backup-selection deadlock regression tests.
- [Authentication lifecycle](../../src-tauri/src/auth_lifecycle.rs): transition exclusion and rejection of superseded login preparations.
- [Frontend setup operations](../../web/src/app/services/server-setup.ts): cancellable verification resource and commit handoff.
- [Setup page flow tests](../../web/src/app/pages/server-config-page/server-config-flow.spec.ts): late admission, destruction, confirmation cancellation, duplicate submission, and retry behavior.
