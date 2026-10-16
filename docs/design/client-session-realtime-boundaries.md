# Client session, realtime, and native storage boundaries

## Ownership

The Angular renderer separates session state, authentication actions, realtime
transport mechanics, application orchestration, and native storage notifications.
Constructor injection must form an acyclic graph on browser, Tauri desktop, and
Android. Platform provider factories must be included in dependency-graph tests.

- `SessionStateService` owns the credential-free authentication flag and the
  browser's readable presence-cookie check. Its signal is read-only to consumers;
  authentication publishes state transitions through `setAuthenticated`. No
  session token is stored in this service.
- `AuthService` owns credential restoration, login/logout, durable cleanup and
  the associated user-facing authentication actions. Its existing `loggedIn` and
  `isLoggedIn()` APIs delegate to the same session-state instance, not a second
  flag.
- `WebsocketService` owns platform transport selection, connection state, HELLO
  validation/deadlines, reconnect countdown and account-epoch guards. It reads
  the leaf session state to reject unauthenticated connection requests. It stops
  receiving and reports forced logout; it neither calls authentication actions
  nor navigates or orchestrates push registration.
- `SseLifecycleService` is the application-level owner of authentication-driven
  connection lifecycle, backend-origin changes, forced-logout reactions, push
  event forwarding, and browser foreground recovery. Native foreground/background
  connection ownership remains in Kotlin/Rust.
- `NativeCommitEventsService` is a non-replaying completion port for the five
  native database commit event kinds. It owns no connection, authentication,
  storage execution, or platform listeners. The existing epoch-guarded transport
  ingress publishes recognized notifications to it. `TauriWebdbStorage` consumes
  this port, filters by active user and account-maintenance state, and maps events
  into its platform-independent committed observables.

## Dependency direction

```text
Application initializer -> SseLifecycleService -> AuthService
                                              -> WebsocketService
                                              -> PushRegistrationService

AuthService -> SessionStateService
            -> user-facing authentication dependencies
               -> UserService -> WebdbService -> NativeCommitEventsService

WebsocketService -> SessionStateService
                 -> SessionLifecycleService
                 -> NativeCommitEventsService
```

Storage does not construct realtime transport. Realtime does not construct auth,
user, navigation, or storage services. The application coordinator depends on
both sides; neither side depends on the coordinator. This is structural
separation, not a delayed-injection workaround.

## Startup and teardown

The initializer constructs the coordinator and installs forced-logout and push
subscriptions and eagerly constructs `ThreadRepository` before calling the
awaited session restoration. Android can replay cached HELLO synchronously from
transport start, so repository subscriptions cannot depend on home-route mounting.
Authentication
becomes active only at the existing credential/cache readiness boundary. The
coordinator then starts the transport. Direct transport recovery commands retain
an authenticated guard, so callers cannot bypass the pre-login restriction.

Logout invalidates the account epoch synchronously before durable cleanup. Old
transport callbacks remain rejected even if login-state effects have not run.
Native user-partition open/recreation re-arms the account lifetime after logout;
otherwise the maintenance latch would permanently reject subsequent operations.
Native completion notifications are not buffered across sessions; durable reads
and feed catch-up recover data instead. Injector teardown removes application
subscriptions/visibility listeners and stops renderer transport reception.

Existing native event lanes and native stop semantics are unchanged. This port
decouples notification consumers; it does not introduce new Android/Rust event
sources or claim physical-device media/network acceptance.

## Regression coverage

- `web/src/app/services/session-bootstrap.spec.ts` exercises production
  `appConfig.providers`, including the real platform storage factory, for browser,
  desktop, and Android. It resolves auth/storage/transport in different orders and
  awaits the initializer without mocking the services on the former cycle. It also
  verifies synchronous Android HELLO replay before any home route mounts.
- `sse-lifecycle.service.spec.ts` covers login/logout, origin changes, revocation,
  push forwarding and listener teardown.
- `native-commit-events.service.spec.ts` covers all five notification mappings,
  user isolation, invalidation/maintenance, closed storage and non-replay.
- `websocket.service.spec.ts` verifies forced-logout reporting and originating-epoch
  filtering on the notification ingress, alongside connection mechanics.

Real APK cold-start remains required to verify native IPC and WebView behavior.
