/** Resolve only the notification registration, never a broader app-shell worker. */
export async function getPushWorkerRegistration(): Promise<
  ServiceWorkerRegistration | undefined
> {
  if (!('serviceWorker' in navigator)) return undefined;
  const scope = new URL('/push/', location.href).href;
  // getRegistration matches the longest enclosing scope, not an exact scope.
  // Without a push registration it can return the root Angular service worker.
  const registration = await navigator.serviceWorker.getRegistration(scope);
  return registration?.scope === scope ? registration : undefined;
}
