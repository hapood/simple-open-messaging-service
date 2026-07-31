/**
 * Web Push service worker (browser/PWA only — registered at scope '/push/' so it doesn't collide with the
 * Angular ngsw worker at '/'; push events fire on this registration regardless of scope, since Web Push
 * delivery is tied to the SW registration that subscribed, not to which pages it controls).
 *
 * Server-authored descriptor: the push is the identity-only wake-up (no body); this SW fetches
 * `POST <API_PREFIX>/notifications/missed` (no cursor → the current unread snapshot; same-origin → the
 * httpOnly session cookie authenticates) and renders each server-authored descriptor verbatim — the
 * localized title/body, the composited stacked-avatar `icon`, and the `tag`-based replace (one shade entry,
 * never stacks). `Accept-Language` is sent so the body honors the device language. Tap focuses/opens the app.
 *
 * The descriptor + action contract is hand-mirrored here; src/notification/notification-descriptor.ts is the
 * single source of truth — keep in sync when it changes.
 */
importScripts('./sw-config.js');
(function () {
  /** The API version prefix, loaded from sw-config.js (generated from src/app/services/constants.ts
   *  API_PREFIX by scripts/gen-sw-config.mjs — single source of truth; mirrors the Angular apiPrefix, no
   *  second hardcoded copy). importScripts is synchronous + resolves relative to this SW's /push/ scope. */
  var API_PREFIX = self.__SOMS_API_PREFIX__;

  /** Map a descriptor action ({id,title}) onto the Web Notifications API shape ({action,title}). The two
   *  contracts disagree on the id key — the API keys off `action`, so passing the descriptor straight through
   *  renders no working buttons. Inline mirror of browser-notification.adapter.ts `mapActions` (this is a
   *  classic script with no imports — keep the two in sync). */
  function mapActions(actions) {
    return (actions || []).map(function (a) {
      return { action: a.id, title: a.title };
    });
  }

  /** The per-thread shade-notification tag prefix (soms-thread-<id>) — discriminates a deep-linkable per-
   *  thread card from the cross-thread summary (soms-away → focus root). */
  var SOMS_THREAD_PREFIX = 'soms-thread-';

  self.addEventListener('push', function (event) {
    event.waitUntil(
      (async function () {
        try {
          var res = await fetch(API_PREFIX + '/notification-feed/query', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Accept-Language': (self.navigator && self.navigator.language) || 'en',
            },
            // `grouping` is the away-summary fold ("thread" = one card per conversation). NOTE: this SW path
            // sends no `since` cursor (the SW keeps none), so the server treats it as first-ever → a `clear`
            // descriptor → no notification until the page-side cursor is wired through to the SW (a pre-
            // existing gap, not introduced here). The foreground (UnreadAttentionService) path DOES send
            // `since` + `grouping` and is the working web away-surface today. Never send undeclared fields
            // (e.g. the old `take`) — MissedDto runs under forbidNonWhitelisted → a hard HTTP 400.
            body: JSON.stringify({ grouping: 'thread' }),
            credentials: 'include', // same-origin httpOnly session cookie
          });
          if (!res.ok) return;
          var json = await res.json();
          var notifs = (json && json.data && json.data.notifications) || [];
          for (var i = 0; i < notifs.length; i++) {
            var d = notifs[i];
            if (d.kind === 'clear') {
              // Server-driven cancel: close any notification with this tag (e.g. the prior away-summary when
              // nothing is unread+unmuted anymore).
              var existing = await self.registration.getNotifications({ tag: d.tag });
              for (var k = 0; k < existing.length; k++) existing[k].close();
              continue;
            }
            await self.registration.showNotification(d.title, {
              body: d.body,
              tag: d.tag, // coalesce — same tag replaces, never stacks
              renotify: !!d.renotify,
              icon: d.icon || undefined, // the composited stacked-avatar PNG (same-origin cookie auth)
              lang: d.lang,
              silent: !!d.silent,
              data: d.data,
              actions: mapActions(d.actions),
            });
          }
        } catch (e) {
          /* best-effort — a transient fetch failure just means no notification this push */
        }
      })(),
    );
  });

  self.addEventListener('notificationclick', function (event) {
    var d = event.notification.data || {};
    var tag = event.notification.tag || '';
    event.notification.close();
    event.waitUntil(
      (async function () {
        // An action button tap (event.action). `dismiss` is a pure frontend shade-close — the notification is
        // already closed above + the per-thread HWM is postMessaged to the page (never POSTed). Any other
        // action (`reply`, …) reports to the server; an inline-reply action (type:'text') carries the typed
        // text as event.reply. threadId/seq come from the descriptor's data. Best-effort — a failed POST just
        // means the action didn't land.
        if (event.action) {
          if (event.action === 'dismiss') {
            // Pure frontend shade-close (already closed above — never POST), BUT record the per-thread HWM so
            // the next /missed pull counts THIS thread from `seq` (it stops re-firing until newer messages
            // arrive). The SW can't reach the Angular WebdbService, so postMessage the page (which owns the
            // HWM store); delivered even though ngsw, not this SW, controls the page. Best-effort.
            if (d.threadId != null && typeof d.threadId === 'number' && typeof d.seq === 'number') {
              var dcs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
              for (var j = 0; j < dcs.length; j++) {
                dcs[j].postMessage({ type: self.__SOMS_NOTIF_MSG__.DISMISS, threadId: d.threadId, seq: d.seq });
              }
            }
            return;
          }
          try {
            await fetch(API_PREFIX + '/notifications/action', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include', // same-origin httpOnly session cookie
              body: JSON.stringify({
                tag: tag,
                actionId: event.action,
                threadId: d.threadId,
                seq: d.seq,
                replyText: event.reply || undefined,
              }),
            });
          } catch (e) {
            /* best-effort */
          }
          return; // an action handled it — don't also focus the app
        }
        // Body tap: a per-thread card (soms-thread-<id>) deep-links to that thread; the cross-thread summary
        // (soms-away) just focuses the app root (it may span several threads). Deep-link is a postMessage to
        // the page (it owns navigation via NavStateMachineService.openChat); the window is focused here so it
        // foregrounds either way. With no live client (tab closed — the push path), openWindow to the chat URL
        // (parsed by NavStateMachineService.initFromUrl) for a per-thread card, else the app root.
        var isOpen = typeof d.threadId === 'number' && tag.indexOf(SOMS_THREAD_PREFIX) === 0;
        var cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (var i = 0; i < cs.length; i++) {
          if (!cs[i] || !('focus' in cs[i])) continue;
          if (isOpen) cs[i].postMessage({ type: self.__SOMS_NOTIF_MSG__.OPEN, threadId: d.threadId });
          return cs[i].focus();
        }
        return self.clients.openWindow(isOpen ? '/chat/' + d.threadId : '/');
      })(),
    );
  });
})();
