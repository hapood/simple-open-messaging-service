export const ACTIVE_PAGE_LOCK = 'soms-active-page';

/** Advisory routing only; database correctness is protected by the separate feed lock. */
export async function activePageClientId(
  locks: LockManager,
): Promise<string | undefined> {
  return (await locks.query()).held?.find(
    (lock) => lock.name === ACTIVE_PAGE_LOCK,
  )?.clientId;
}

/** Hold ownership for the document lifetime, including application teardown. Workers do not take this lock. */
export async function runAsActivePage(
  start: () => Promise<void>,
): Promise<void> {
  const label = (waiting: boolean) => {
    const root = document.querySelector('app-root');
    if (!root) return;
    const message = document.createElement('p');
    message.className = 'active-page-message';
    message.setAttribute('role', 'status');
    const chinese = document.documentElement.lang.startsWith('zh');
    message.textContent = waiting
      ? chinese
        ? '应用已在其他窗口打开。关闭该窗口后，本页面会自动启动。'
        : 'The app is open in another window. This page will start when that window closes.'
      : chinese
        ? '当前环境不支持安全的多窗口协调，请使用支持 Web Locks 的浏览器和安全连接。'
        : 'This environment cannot coordinate app windows safely. Use a browser with Web Locks and a secure connection.';
    root.replaceChildren(message);
  };
  if (!navigator.locks) {
    label(false);
    return;
  }
  // A restored document must reacquire ownership before resuming account services.
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) window.location.reload();
  });
  const controller = new AbortController();
  window.addEventListener('pagehide', () => controller.abort(), { once: true });
  const hold = async () => {
    try {
      await start();
    } catch (error) {
      console.error('[bootstrap] failed', error);
    }
    // Never hand ownership over while this document can still have live workers.
    // Closing the document releases the browser-managed lock automatically.
    await new Promise<void>(() => {});
  };
  await navigator.locks.request(
    ACTIVE_PAGE_LOCK,
    { ifAvailable: true },
    async (lock) => {
      if (lock) return hold();
      label(true);
      try {
        await navigator.locks.request(
          ACTIVE_PAGE_LOCK,
          { signal: controller.signal },
          hold,
        );
      } catch (error) {
        if (!controller.signal.aborted) throw error;
      }
    },
  );
}
