export function assertPortAvailable(port: number, host?: string): Promise<void>;
export function startPlaygroundServer(
  logPath: string,
  timeoutMs?: number,
): Promise<() => Promise<void>>;
