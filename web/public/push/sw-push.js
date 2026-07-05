/**
 * Web Push service worker (browser/PWA only — registered at scope '/push/' so it doesn't collide with
 * the Angular ngsw worker at '/'; push events fire on this registration regardless of scope, since
 * Web Push delivery is tied to the SW registration that subscribed, not to which pages it controls).
 *
 * The backend (PushService) sends the SAME data-only wake-up signal as FCM: { threadId, messageId,
 * contentType, ts[, preview] }. There's no `notification` wrapper — this SW builds the visible
 * notification. The copy is generic (preview or a content-type label) — the per-thread "{name}" wording
 * is reserved for the WorkManager missed-path; real-time push is immediate so "{preview}" fits.
 *
 * i18n: the SW can't reach Angular's transloco, so it picks zh vs en by navigator.language. Keep these
 * strings in sync with web/src/app/i18n/{en,zh-CN}.json notif.*.
 */
(function () {
  var zh = (self.navigator && self.navigator.language ? self.navigator.language : 'en')
    .toLowerCase()
    .indexOf('zh') === 0;

  var LABELS = {
    IMAGE: '📷 Photo',
    VIDEO: '🎬 Video',
    FILE: '📎 File',
    AUDIO: '🎤 Voice message',
    INVITE: '🔗 Group invite',
  };

  function newMsg() { return zh ? '新消息' : 'New message'; }

  self.addEventListener('push', function (event) {
    var data = {};
    try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }
    var fallback = data.contentType
      ? (LABELS[data.contentType] || newMsg())
      : newMsg();
    var body = data.preview || fallback;
    var threadId = data.threadId;
    event.waitUntil(
      self.registration.showNotification('SOMS', {
        body: body,
        tag: threadId ? 'thread_' + threadId : undefined, // collapse same-thread into one shade entry
        data: { threadId: threadId || null },
      })
    );
  });

  self.addEventListener('notificationclick', function (event) {
    event.notification.close();
    var threadId = event.notification.data && event.notification.data.threadId;
    // PathLocationStrategy → plain path, not hash. The SPA fallback serves index.html for /chat/*.
    var path = threadId ? '/chat/' + threadId : '/';
    event.waitUntil(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (cs) {
        for (var i = 0; i < cs.length; i++) {
          var c = cs[i];
          if (c && 'focus' in c) {
            if ('navigate' in c) c.navigate(path);
            return c.focus();
          }
        }
        return self.clients.openWindow(path);
      })
    );
  });
})();
