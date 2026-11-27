/** Deletion cannot be cancelled. A blocked request must settle before reuse of the fixed name. */
function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () =>
      reject(request.error ?? new Error('Cache deletion failed'));
    // In particular, do not reject onblocked: that would permit a retry/new login
    // while this outstanding request can still delete its identically named cache.
  });
}

export async function deleteBrowserSessionCache(): Promise<void> {
  await deleteDatabase('soms-session-pending-sends');
  await deleteDatabase('soms-session-download-history');
  await deleteDatabase('soms-session');
}
