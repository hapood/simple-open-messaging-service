#!/usr/bin/env node
/** Authenticated lab peer for bounded Android text/file checks. Credentials and OTPs stay in memory. */
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { LabAdminActor, LabApiError, LabUserActor } from '../dev/federation-lab/p2p/api-actors.mjs';
import { federationLabNode } from '../dev/federation-lab/topology.mjs';

const usage = `Usage:
  node scripts/android-chat-peer.mjs send-text --node alpha --peer ACCOUNT --thread-id N --text TEXT
  node scripts/android-chat-peer.mjs check-text --node alpha --peer ACCOUNT --thread-id N --text TEXT
  node scripts/android-chat-peer.mjs check-file --node alpha --peer ACCOUNT --thread-id N --file PATH [--name PICKED_NAME]

Read the lab admin password from SOMS_LAB_ADMIN_PASSWORD_FILE (default: /dev/shm/soms-admin-pw).
Never supply an OTP or password on the command line.`;

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      node: { type: 'string' },
      peer: { type: 'string' },
      'thread-id': { type: 'string' },
      text: { type: 'string' },
      file: { type: 'string' },
      name: { type: 'string' },
    },
  });
  const [action] = positionals;
  const threadId = Number(values['thread-id']);
  if (!['send-text', 'check-text', 'check-file'].includes(action) || !values.peer ||
      !Number.isSafeInteger(threadId) || threadId <= 0 ||
      (action === 'check-file' ? !values.file : !values.text)) {
    throw new Error(usage);
  }
  const node = federationLabNode(values.node ?? 'alpha');
  if (!node) throw new Error('Unknown lab node');
  const password = (await readFile(process.env.SOMS_LAB_ADMIN_PASSWORD_FILE ?? '/dev/shm/soms-admin-pw', 'utf8')).trim();
  const admin = await LabAdminActor.login({ node, password });
  const users = await admin.post('/admin/users', { search: values.peer, take: 10 });
  const matches = users.list?.filter((user) => user.account === values.peer);
  if (matches?.length !== 1) throw new Error('Peer account not uniquely found');
  const user = matches[0];
  const issued = await admin.post(`/admin/users/${user.id}/issue-login-code`, {});
  if (typeof issued.code !== 'string' || !/^\d{6}$/.test(issued.code))
    throw new Error('OTP issuance failed');
  const response = await fetch(`${node.backendBaseUrl}/api/v1/auth/otp/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account: values.peer, code: issued.code, client: 'app', device: 'android-chat-peer' }),
  });
  const auth = await response.json();
  if (!response.ok || auth.code !== 0 || typeof auth.data?.session_token !== 'string')
    throw new Error('Peer login failed');
  const peer = new LabUserActor({ node, id: user.id, account: values.peer, token: auth.data.session_token });
  if (action === 'send-text') {
    await peer.sendText(threadId, values.text, randomUUID());
    console.log(JSON.stringify({ action, sent: true }));
    return;
  }
  let before;
  try {
    await peer.post('/query-messages', { threadId });
  } catch (error) {
    if (!(error instanceof LabApiError) || error.details?.code !== 30006 ||
        !Number.isSafeInteger(error.details?.data?.resumeBefore)) throw error;
    before = error.details.data.resumeBefore;
  }
  if (before === undefined) throw new Error('Missing history recovery cursor');
  const messages = [];
  for (;;) {
    const page = await peer.post('/query-messages', { threadId, before, take: 50 });
    messages.push(...page.messages);
    if (!page.hasMore) break;
    if (!Number.isSafeInteger(page.scannedThrough) || page.scannedThrough >= before)
      throw new Error('History cursor did not advance');
    before = page.scannedThrough;
  }
  if (action === 'check-text') {
    const count = messages.filter((message) => {
      if (message.contentType !== 'PURE_TEXT') return false;
      try { return JSON.parse(message.content).text === values.text; }
      catch { return false; }
    }).length;
    if (count !== 1) throw new Error(`Expected one peer-visible text message, found ${count}`);
    console.log(JSON.stringify({ action, peerReceivedOnce: true }));
    return;
  }
  const source = await readFile(values.file);
  const digest = createHash('sha256').update(source).digest('hex');
  const name = values.name ?? values.file.split('/').at(-1);
  const found = messages.filter((message) => {
    if (message.contentType !== 'FILE') return false;
    try {
      const content = JSON.parse(message.content);
      return content.name === name && content.size === source.length;
    } catch { return false; }
  });
  if (found.length !== 1) throw new Error(`Expected one peer-visible file, found ${found.length}`);
  const url = new URL(JSON.parse(found[0].content).url, `${node.backendBaseUrl}/`);
  if (url.origin !== new URL(node.backendBaseUrl).origin || !url.pathname.startsWith('/uploads/msg-assets/'))
    throw new Error('Unexpected file origin or path');
  url.searchParams.set('threadId', String(threadId));
  url.searchParams.set('seq', String(found[0].seq));
  const download = await fetch(url, { headers: { authorization: `Bearer ${auth.data.session_token}` } });
  if (!download.ok) throw new Error(`Peer file download failed with HTTP ${download.status}`);
  const downloaded = Buffer.from(await download.arrayBuffer());
  if (downloaded.length !== source.length || createHash('sha256').update(downloaded).digest('hex') !== digest)
    throw new Error('Peer file digest mismatch');
  console.log(JSON.stringify({ action, peerReceivedOnce: true, size: source.length, sha256: digest }));
}

main().catch(() => {
  // Lab API errors may include request or session details; do not dump them or the OTP.
  console.error('Android peer check failed; secret-bearing details suppressed.');
  process.exitCode = 1;
});
