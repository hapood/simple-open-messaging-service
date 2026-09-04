import { uuid } from './uuid';

const DEVICE_ID_KEY = 'device_id';
let memoryDeviceId: string | undefined;

/** Stable browser-install identifier shared by Push registration and the browser SSE connection. */
export function clientDeviceId(): string {
  if (memoryDeviceId) return memoryDeviceId;
  try {
    const stored = localStorage.getItem(DEVICE_ID_KEY);
    if (stored && stored.length <= 127) return (memoryDeviceId = stored);
    const created = uuid();
    localStorage.setItem(DEVICE_ID_KEY, created);
    return (memoryDeviceId = created);
  } catch {
    return (memoryDeviceId = uuid());
  }
}
