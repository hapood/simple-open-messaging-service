import {
  restoreSessionCacheDescriptor,
  type SessionCacheDescriptor,
} from './session-identity';

/** A blocked request may finish later, but its ended UUID is never reused. */
function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () =>
      reject(request.error ?? new Error('Cache deletion failed'));
    request.onblocked = () =>
      reject(new Error('Close other cache connections and retry'));
  });
}

export async function deleteBrowserSessionCache(
  value: SessionCacheDescriptor,
): Promise<void> {
  const descriptor = restoreSessionCacheDescriptor(value);
  await Promise.all([
    deleteDatabase(descriptor.indexedDbName),
    deleteDatabase(descriptor.messageIndexedDbName),
  ]);
}

/** Never delete preference storage or arbitrary same-origin application databases. */
export async function deleteLegacyBrowserCaches(): Promise<void> {
  if (typeof indexedDB === 'undefined' || !indexedDB.databases) {
    throw new Error('Cache discovery is unavailable');
  }
  const databases = await indexedDB.databases();
  await Promise.all(
    databases.flatMap(({ name }) =>
      name && /^soms-(?:webdb|msgdb)-u[1-9]\d*$/.test(name)
        ? [deleteDatabase(name)]
        : [],
    ),
  );
}
