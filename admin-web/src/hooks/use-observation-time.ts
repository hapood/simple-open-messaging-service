import { useEffect, useState } from 'react';

/** Re-evaluate expiring observations without treating a local tick as a server refresh. */
export function useObservationTime() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
