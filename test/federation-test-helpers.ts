// Shared helpers for the federation e2e — the process-boundary-safe replacements for the old in-process
// `app.get(Service)` patterns. Each helper talks to an app over HTTP (or the shared filesystem + a
// test-process PrismaClient for CAS staging) so it works with the apps running in separate processes.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import request from 'supertest';
import type { PrismaClient } from '../src/prisma/generated/client.js';

/** mimetype → CAS file extension (mirrors UploadService.IMG_EXT for the asset types the tests stage). */
const IMG_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** The minimal app surface these helpers need (baseUrl for HTTP, prisma for direct DB/fixtures). */
interface AppLike {
  baseUrl: string;
  prisma: PrismaClient;
}

/**
 * Stage a content-addressed chat-media asset on an app's CAS — the test-process equivalent of the old
 * in-process `UploadService.save(mimeType, buf)`. Writes uploads/shards/<aa>/<bb>/<digest>.<ext> (the
 * exact path resolveMediaFile globs) + the MediaAsset ref-count row (so the dedup-defeat in the
 * multi-chunk/resume tests — deleting the row — behaves identically). Returns the server-relative URL
 * (what a chat IMAGE message embeds) + the size + the digest.
 */
export async function stageCasAsset(
  prisma: PrismaClient,
  mimeType: string,
  buf: Buffer,
): Promise<{ url: string; size: number; digest: string }> {
  const ext = IMG_EXT[mimeType] ?? 'bin';
  const digest = createHash('sha256').update(buf).digest('hex');
  const rel = `shards/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}.${ext}`;
  // CAS root MUST match the server's UploadService.uploadDir (process.cwd()/data/uploads, see
  // src/upload/upload.service.ts) — /get_file + /uploads/* read shards from here. Writing to
  // process.cwd()/uploads (no data/) leaves the staged file invisible to the server, so federated
  // media localization fetches zero bytes and fails the digest check.
  const casRoot = join(process.cwd(), 'data', 'uploads');
  const abs = join(casRoot, ...rel.split('/'));
  await mkdir(join(casRoot, 'shards', digest.slice(0, 2), digest.slice(2, 4)), {
    recursive: true,
  });
  await writeFile(abs, buf);
  await prisma.mediaAsset.upsert({
    where: { digest },
    create: { digest, bytes: BigInt(buf.length), refs: 1 },
    update: { refs: { increment: 1 } },
  });
  return { url: `/uploads/${rel}`, size: buf.length, digest };
}

/** Upload an avatar via the real HTTP route (multipart) — the test-process equivalent of
 *  `UploadService.saveAvatars` + `UserService.updateAvatar`. Returns the response. */
export function uploadAvatar(app: AppLike, token: string, png: Buffer): request.Test {
  return request(app.baseUrl)
    .post('/api/v1/user/update-avatar')
    .set('Authorization', `Bearer ${token}`)
    .attach('file', png, { filename: 'avatar.png', contentType: 'image/png' });
}

/** Register a local user + log in, returning { id, token }. The standard setup for a federation user. */
export async function registerAndLogin(
  app: AppLike,
  account: string,
  name: string,
): Promise<{ id: number; token: string }> {
  const reg = await request(app.baseUrl)
    .post('/api/v1/user/register')
    .send({ account, name, password: 'Pass1234' });
  const login = await request(app.baseUrl)
    .post('/api/v1/auth/login')
    .send({ account, password: 'Pass1234' });
  return { id: reg.body.data.id as number, token: login.body.data.session_token as string };
}

/** Create a SUPER_ADMIN on an app + log in via the admin route, returning the admin access token
 *  (the real way the federation peer-block tests block a domain — through markBlocked via the admin route,
 *  not a prisma shortcut). */
export async function getAdminToken(app: AppLike, account = 'admin'): Promise<string> {
  await request(app.baseUrl)
    .post('/api/v1/user/register')
    .send({ account, name: account, password: 'Pass1234' });
  const u = await app.prisma.user.findUnique({
    where: { account_domain: { account, domain: 'local' } },
  });
  await app.prisma.admin.create({
    data: { userId: u!.id, role: 'SUPER_ADMIN', enabled: true },
  });
  const res = await request(app.baseUrl)
    .post('/api/v1/admin/login')
    .send({ account, password: 'Pass1234' });
  // Admin login returns the ADMIN access_token (JWT) — the admin system stays JWT; only user auth moved
  // to the session token. Do NOT read session_token here.
  return res.body.data.access_token as string;
}

// ─── real SSE client (replaces the in-process SseService.on* spies) ────────────────────────────

/** Open the SSE stream as a user (Bearer token) + return a reader on the response body. The caller
 *  reads frames with waitForSseEvent + cancels when done. */
export async function openSse(baseUrl: string, token: string): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const res = await fetch(`${baseUrl}/api/v1/events`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok || !res.body) throw new Error(`SSE connect failed: HTTP ${res.status}`);
  return res.body.getReader();
}

/** Read SSE frames from `reader` until one matches `predicate(event, data)`, returning the matched data.
 *  Throws on stream close or timeout. Frames are split on blank lines; `event:` + `data:` lines parsed. */
export async function waitForSseEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (event: string, data: unknown) => boolean,
  timeoutMs = 6000,
): Promise<unknown> {
  const decoder = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) throw new Error('SSE stream closed before the expected event');
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const lines = frame.split('\n');
      const event = lines.find((l) => l.startsWith('event:'))?.slice(6).trim() ?? '';
      const dataRaw = lines
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n');
      let data: unknown = undefined;
      if (dataRaw) {
        try {
          data = JSON.parse(dataRaw);
        } catch {
          /* non-JSON frame; skip */
        }
      }
      if (predicate(event, data)) return data;
    }
  }
  throw new Error(`SSE event not received within ${timeoutMs}ms`);
}
