import { join, resolve } from 'node:path';

/** Root for mutable application data, configurable for isolated instances. */
export function dataDirectory(...segments: string[]): string {
  const root = process.env.SOMS_DATA_DIR
    ? resolve(process.env.SOMS_DATA_DIR)
    : join(process.cwd(), 'data');
  return join(root, ...segments);
}
