// Shared helpers for the federation e2e — the process-boundary-safe replacements for the old in-process
// `app.get(Service)` patterns. Each helper talks to an app over HTTP (or the shared filesystem + a
// test-process Drizzle connection for CAS staging) so it works with apps running in separate processes.
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import request from 'supertest';
import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../src/database/database.service.js';
import {
  account as accountTable,
  admin,
  relationshipPair,
  mediaAsset,
  profileTable,
  sessionToken,
  account as user,
} from '../src/database/schema.js';
import { PasswordHasher } from '../src/auth/password-hasher.service.js';
import { ADMIN_SESSION_COOKIE } from '../src/admin/admin-session.js';

/** The minimal app surface these helpers need (baseUrl for HTTP, database for direct DB/fixtures). */
interface AppLike {
  baseUrl: string;
  database: Database;
  dataDir: string;
}

/**
 * Stage a content-addressed chat-media asset on an app's CAS — the test-process equivalent of the old
 * in-process `UploadService.save(mimeType, buf)`. Writes data/cas/<aa>/<bb>/<digest> (the
 * exact path resolveMediaFile globs) + the MediaAsset ref-count row (so the dedup-defeat in the
 * multi-chunk/resume tests — deleting the row — behaves identically). Returns the server-relative URL
 * (what a chat IMAGE message embeds) + the size + the digest.
 */
export async function stageCasAsset(
  app: AppLike,
  mimeType: string,
  buf: Buffer,
): Promise<{ url: string; size: number; digest: string }> {
  void mimeType;
  const digest = createHash('sha256').update(buf).digest('hex');
  const rel = `${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}`;
  // CAS root MUST match the server's UploadService.uploadDir (process.cwd()/data/uploads, see
  // src/upload/upload.service.ts) — /media/:digest + /uploads/* read shards from here. Writing to
  // process.cwd()/uploads (no data/) leaves the staged file invisible to the server, so federated
  // media localization fetches zero bytes and fails the digest check.
  const casRoot = join(app.dataDir, 'cas');
  const abs = join(casRoot, ...rel.split('/'));
  await mkdir(join(casRoot, digest.slice(0, 2), digest.slice(2, 4)), {
    recursive: true,
  });
  await writeFile(abs, buf);
  await app.database
    .insert(mediaAsset)
    .values({ digest, bytes: BigInt(buf.length), isDeleted: false })
    .onConflictDoUpdate({
      target: mediaAsset.digest,
      set: { bytes: BigInt(buf.length), isDeleted: false },
    });
  return { url: `/uploads/msg-assets/${rel}`, size: buf.length, digest };
}

/** Create a complete profile revision through the real JSON API while preserving name and bio. */
export async function uploadAvatar(
  app: AppLike,
  token: string,
  png: Buffer,
): Promise<request.Response> {
  const current = await request(app.baseUrl)
    .post('/api/v1/user/my-profile')
    .set('Authorization', `Bearer ${token}`)
    .send({})
    .expect(200);
  return request(app.baseUrl)
    .post('/api/v1/user/update-profile')
    .set('Authorization', `Bearer ${token}`)
    .send({
      name: current.body.data.name,
      bio: current.body.data.bio,
      avatarBase64: png.toString('base64'),
    })
    .expect(200);
}

/** Hash a session token exactly as SessionTokenService does (sha256 hex) — replicated in the test process
 *  so a SessionToken row inserted HERE is validated by the app running in a SEPARATE process (same DB). */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Insert a SessionToken row directly (process-boundary safe) + return its plaintext — the Bearer the
 *  app's SessionAuthGuard validates on first use (a cache miss → DB read → this row). Every client
 *  uses the default 30-day inactivity deadline, mirroring SessionTokenService.issue. */
async function seedSessionToken(
  database: Database,
  userId: number,
  client: 'app' | 'web' | 'desktop' = 'app',
): Promise<string> {
  const plaintext = randomBytes(32).toString('hex');
  await database.insert(sessionToken).values({
    userId,
    tokenHash: hashToken(plaintext),
    client,
    device: null,
    userAgent: null,
    ip: null,
    lastSeenIp: null,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    autoTerminateDays: 30,
  });
  return plaintext;
}

/** Seed a local user + an `app` session directly (registration is closed + password login is disabled
 *  under APP_OTP_AND_QR, so the old register→login pair no longer works) — the standard setup for a
 *  federation user. Returns { id, account, token }. */
export async function registerAndLogin(
  app: Pick<AppLike, 'database'>,
  account: string,
  name: string,
): Promise<{ id: number; account: string; token: string }> {
  const u = await app.database.transaction(async (tx) => {
    const [created] = await tx
      .insert(user)
      .values({
        account,
        domain: 'local',
        defaultProfileRev: 1,
        updatedAt: new Date(),
      })
      .returning({ id: user.id });
    await tx.insert(profileTable).values({
      account,
      publisherNamespaceId: 0,
      profileNamespaceId: 0,
      profileRev: 1,
      displayName: name,
      avatar: '',
      bio: '',
    });
    return created;
  });
  const token = await seedSessionToken(app.database, u.id, 'app');
  return { id: u.id, account, token };
}

export async function resolveFederatedCard(
  app: AppLike,
  token: string,
  account: string,
  domain: string,
): Promise<{ event: 'resolved' | 'failed'; data: Record<string, unknown> }> {
  const response = await request(app.baseUrl)
    .get('/api/v1/user/resolve-federated-stream')
    .query({ account, domain })
    .set('Authorization', `Bearer ${token}`)
    .set('Accept', 'text/event-stream');
  const terminalFrame = response.text
    .split(/\r?\n\r?\n/)
    .map((frame) => ({
      event: /^event:\s*(resolved|failed)$/m.exec(frame)?.[1] as
        | 'resolved'
        | 'failed'
        | undefined,
      raw: /^data:\s*(.+)$/m.exec(frame)?.[1],
    }))
    .find((frame) => frame.event !== undefined);
  const event = terminalFrame?.event;
  const raw = terminalFrame?.raw;
  if (response.status !== 200 || !event || !raw)
    throw new Error(`invalid federated resolve stream: ${response.text}`);
  return { event, data: JSON.parse(raw) as Record<string, unknown> };
}

/** Establish a new cross-server friendship through the no-stub Address flow. */
export async function establishFederatedFriendship(params: {
  local: AppLike;
  remote: AppLike;
  localUserId: number;
  remoteUserId: number;
  localToken: string;
  remoteToken: string;
  localAccount: string;
  remoteAccount: string;
  localDomain: string;
  remoteDomain: string;
  note?: string;
}): Promise<{ localThreadId: number; remoteThreadId: number }> {
  let card: Awaited<ReturnType<typeof resolveFederatedCard>> | undefined;
  for (let attempt = 1; attempt <= 3; attempt++) {
    card = await resolveFederatedCard(
      params.local,
      params.localToken,
      params.remoteAccount,
      params.remoteDomain,
    );
    const transient =
      card.event === 'failed' &&
      (card.data.reason === 'UNREACHABLE' || card.data.reason === 'TIMEOUT');
    if (!transient || attempt === 3) break;
    await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
  }
  if (!card) throw new Error('federated card lookup did not run');
  if (card.event !== 'resolved')
    throw new Error(
      `federated card lookup failed: ${JSON.stringify(card.data)}`,
    );
  const sent = await request(params.local.baseUrl)
    .post('/api/v1/relationship/request')
    .set('Authorization', `Bearer ${params.localToken}`)
    .send({
      account: params.remoteAccount,
      domain: params.remoteDomain,
      displayName: params.remoteAccount,
      note: params.note ?? '',
    });
  if (sent.body.code !== 0)
    throw new Error(`federated request failed: ${JSON.stringify(sent.body)}`);

  let incomingFound = false;
  const requestDeadline = Date.now() + 30_000;
  while (Date.now() < requestDeadline) {
    const incoming = await params.remote.database.execute(sql`
      SELECT 1
      FROM "RelationshipPair" pair
      JOIN "RelationshipIntent" intent
        ON intent."authorAccount" = pair."endpointAAccount"
       AND intent."authorNamespaceId" = pair."endpointANamespaceId"
       AND intent."receiverAccount" = pair."endpointBAccount"
       AND intent."receiverNamespaceId" = pair."endpointBNamespaceId"
      WHERE pair.kind = 'P2P'
        AND intent.status = 'REQUESTED'
        AND intent."expiresAt" > CURRENT_TIMESTAMP
        AND pair."endpointAAccount" = ${params.remoteAccount}
        AND pair."endpointBAccount" = ${params.localAccount}
        AND pair."endpointANamespaceId" <> 0
        AND pair."endpointBNamespaceId" = 0
      LIMIT 1
    `);
    incomingFound = incoming.rows.length > 0;
    if (incomingFound) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!incomingFound) throw new Error('federated request did not reach remote');
  const accepted = await request(params.remote.baseUrl)
    .post('/api/v1/relationship/accept')
    .set('Authorization', `Bearer ${params.remoteToken}`)
    .send({ account: params.localAccount, domain: params.localDomain });
  if (accepted.body.code !== 0)
    throw new Error(
      `federated accept failed: ${JSON.stringify(accepted.body)}`,
    );

  // Acceptance starts a separate asynchronous S2S propagation phase. Give it
  // its own deadline: reusing the request deadline makes time spent waiting for
  // delivery silently reduce the convergence budget, especially under a busy
  // multi-worker run.
  const convergenceDeadline = Date.now() + 30_000;
  while (Date.now() < convergenceDeadline) {
    // The local endpoint is always side A, so each server's own account
    // names the A side of the same canonical pair.
    const [localPair, remotePair] = await Promise.all([
      params.local.database.query.relationshipPair.findFirst({
        where: and(
          eq(relationshipPair.endpointAType, 'USER'),
          eq(relationshipPair.endpointAAccount, params.localAccount),
          eq(relationshipPair.endpointBType, 'USER'),
          eq(relationshipPair.endpointBAccount, params.remoteAccount),
          eq(relationshipPair.active, true),
        ),
      }),
      params.remote.database.query.relationshipPair.findFirst({
        where: and(
          eq(relationshipPair.endpointAType, 'USER'),
          eq(relationshipPair.endpointAAccount, params.remoteAccount),
          eq(relationshipPair.endpointBType, 'USER'),
          eq(relationshipPair.endpointBAccount, params.localAccount),
          eq(relationshipPair.active, true),
        ),
      }),
    ]);
    if (localPair?.threadId && remotePair?.threadId)
      return {
        localThreadId: localPair.threadId,
        remoteThreadId: remotePair.threadId,
      };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('federated friendship did not converge');
}

/** Create a SUPER_ADMIN identity + log in via the admin route, returning the admin_session cookie pair.
 *  The identity user is seeded directly with a peppered password (registration is closed — hashed via the
 *  app's PasswordHasher, the exact path /admin/login verifies against), the Admin row is attached, then
 *  /admin/login verifies the password over HTTP. Admin auth is an opaque session delivered via the
 *  httpOnly admin_session cookie (set by the controller, never the response body), so the caller attaches
 *  the returned pair with .set('Cookie', …) on admin routes (this is the real way the federation
 *  peer-block tests block a domain — through markBlocked via the admin route, not a database shortcut). */
export async function getAdminCookie(
  app: AppLike,
  account = 'admin',
): Promise<string> {
  const passwordHash = await new PasswordHasher().hash('Pass1234');
  await app.database.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: user.id })
      .from(user)
      .where(
        and(
          eq(user.account, account),
          eq(user.domain, 'local'),
          eq(user.namespaceId, 0),
        ),
      )
      .limit(1);
    const created =
      existing ??
      (
        await tx
          .insert(user)
          .values({
            account,
            domain: 'local',
            namespaceId: 0,
            defaultProfileRev: 1,
            updatedAt: new Date(),
          })
          .returning({ id: user.id })
      )[0];
    await tx
      .update(user)
      .set({ defaultProfileRev: 1, updatedAt: new Date() })
      .where(eq(user.id, created.id));
    await tx
      .update(accountTable)
      .set({
        hashPwd: passwordHash,
        mustChangePassword: false,
        disabledAt: null,
      })
      .where(eq(accountTable.id, created.id));
    await tx
      .insert(profileTable)
      .values({
        account,
        publisherNamespaceId: 0,
        profileNamespaceId: 0,
        profileRev: 1,
        displayName: account,
        avatar: '',
        bio: '',
      })
      .onConflictDoNothing();
    await tx
      .insert(admin)
      .values({
        userId: created.id,
        role: 'SUPER_ADMIN',
        enabled: true,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: admin.userId,
        set: { role: 'SUPER_ADMIN', enabled: true, updatedAt: new Date() },
      });
    return created;
  });
  const res = await request(app.baseUrl)
    .post('/api/v1/admin/login')
    .send({ account, password: 'Pass1234' });
  return extractAdminCookie(res);
}

/** Pull the `admin_session=<token>` pair out of a login response's Set-Cookie header. supertest exposes
 *  set-cookie as a string (single cookie) or string[] (several); join then regex so the parse is
 *  shape-agnostic. login sets exactly one cookie (admin_session), so there is no comma-in-expires hazard. */
function extractAdminCookie(res: request.Response): string {
  const raw = res.headers['set-cookie'];
  const text = Array.isArray(raw) ? raw.join('; ') : String(raw ?? '');
  const m = new RegExp(`${ADMIN_SESSION_COOKIE}=([^;]+)`).exec(text);
  if (!m) throw new Error('admin/login did not set an admin_session cookie');
  return `${ADMIN_SESSION_COOKIE}=${m[1]}`;
}

// ─── real SSE client (replaces the in-process SseService.on* spies) ────────────────────────────

/** Open the SSE stream as a user (Bearer token) + return a reader on the response body. The caller
 *  reads frames with waitForSseEvent + cancels when done. */
export async function openSse(
  baseUrl: string,
  token: string,
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const res = await fetch(`${baseUrl}/api/v1/events`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok || !res.body)
    throw new Error(`SSE connect failed: HTTP ${res.status}`);
  return res.body.getReader();
}

/** Read SSE frames from `reader` until one matches `predicate(event, data)`, returning the matched data.
 *  Throws on stream close or timeout. Frames are split on blank lines; `event:` + `data:` lines parsed. */
export async function waitForSseEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (event: string, data: unknown) => boolean,
  timeoutMs = 5000,
): Promise<unknown> {
  const decoder = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`SSE event not received within ${timeoutMs}ms`)),
        remaining,
      );
    });
    const { value, done } = await Promise.race([
      reader.read(),
      timeout,
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    if (done) throw new Error('SSE stream closed before the expected event');
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const lines = frame.split('\n');
      const event =
        lines
          .find((l) => l.startsWith('event:'))
          ?.slice(6)
          .trim() ?? '';
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

/** Continuously consume an SSE reader while retaining parsed events. Tests that learn an event's exact
 * identity only after its durable row commits can therefore match the already-arrived frame without
 * assuming it was the first event on a multiplexed stream. */
export function collectSseEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): {
  waitFor: (
    predicate: (event: string, data: unknown) => boolean,
    timeoutMs?: number,
  ) => Promise<unknown>;
} {
  const decoder = new TextDecoder();
  const events: Array<{ event: string; data: unknown }> = [];
  const changed = new Set<() => void>();
  let buf = '';
  let terminal: Error | undefined;

  const notify = () => {
    for (const listener of changed) listener();
    changed.clear();
  };
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done)
          throw new Error('SSE stream closed before the expected event');
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const lines = frame.split('\n');
          const event =
            lines
              .find((line) => line.startsWith('event:'))
              ?.slice(6)
              .trim() ?? '';
          const dataRaw = lines
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).replace(/^ /, ''))
            .join('\n');
          let data: unknown;
          if (dataRaw) {
            try {
              data = JSON.parse(dataRaw);
            } catch {
              continue;
            }
          }
          events.push({ event, data });
        }
        notify();
      }
    } catch (error) {
      terminal = error as Error;
      notify();
    }
  })();

  return {
    async waitFor(predicate, timeoutMs = 5000): Promise<unknown> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const match = events.find(({ event, data }) => predicate(event, data));
        if (match) return match.data;
        if (terminal) throw terminal;
        const remaining = deadline - Date.now();
        if (remaining <= 0)
          throw new Error(`SSE event not received within ${timeoutMs}ms`);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            changed.delete(onChanged);
            resolve();
          }, remaining);
          const onChanged = () => {
            clearTimeout(timer);
            resolve();
          };
          changed.add(onChanged);
        });
      }
    },
  };
}
