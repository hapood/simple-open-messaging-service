import { createServer } from 'node:net';
import { it, expect } from 'vitest';
import { assertPortAvailable } from './playground-server.mjs';

it('refuses occupied ports without taking over the existing service', async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected TCP address');
  try {
    await expect(assertPortAvailable(address.port)).rejects.toThrow(
      'refusing to reuse',
    );
    expect(server.listening).toBe(true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await expect(assertPortAvailable(address.port)).resolves.toBeUndefined();
});
