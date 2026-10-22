import { requireHmrFrontend } from './hmr-status.mjs';

export default async function globalSetup() {
  await requireHmrFrontend();
}
