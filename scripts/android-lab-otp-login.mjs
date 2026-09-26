#!/usr/bin/env node
/** Issue a lab OTP and feed it directly to the Android WebView helper without logging the code. */
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { LabAdminActor } from '../dev/federation-lab/p2p/api-actors.mjs';
import { federationLabNode } from '../dev/federation-lab/topology.mjs';

let stage = 'options';
try {
  const { values } = parseArgs({ options: {
    node: { type: 'string' }, account: { type: 'string' }, create: { type: 'boolean' },
  } });
  const node = federationLabNode(values.node ?? 'alpha');
  if (!node) throw new Error('unknown node');
  const account = values.account ?? (values.create ? `androidrestore${Date.now().toString(36)}` : null);
  if (!account || !/^[a-z][a-z0-9]{2,30}$/.test(account)) throw new Error('invalid account');
  stage = 'admin-login';
  const admin = await LabAdminActor.login({
    node, password: (await readFile(process.env.SOMS_LAB_ADMIN_PASSWORD_FILE ?? '/dev/shm/soms-admin-pw', 'utf8')).trim(),
  });
  stage = 'account';
  const user = values.create
    ? await admin.post('/admin/users/create', { account, name: 'Android Restore Test' })
    : (await admin.post('/admin/users', { search: account, take: 10 })).list?.find((item) => item.account === account);
  if (!Number.isInteger(user?.id)) throw new Error('user missing');
  stage = 'issue-code';
  const issued = await admin.post(`/admin/users/${user.id}/issue-login-code`, {});
  if (typeof issued?.code !== 'string' || !/^\d{6}$/.test(issued.code)) throw new Error('invalid issue result');
  stage = 'android-login';
  const child = spawn('node', ['scripts/android-webview-flow.mjs', 'otp-login', '--account', account, '--code-stdin'], {
    cwd: new URL('..', import.meta.url).pathname, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (part) => { output += part; });
  child.stderr.on('data', () => {});
  child.stdin.end(`${issued.code}\n`);
  const exitCode = await new Promise((resolve) => child.on('close', resolve));
  if (exitCode !== 0) throw new Error('Android flow failed');
  const result = JSON.parse(output).result;
  if (!result.hasHomeShell || result.href.includes('/auth/')) throw new Error('Android home not reached');
  console.log(JSON.stringify({ account, userId: user.id, home: true }));
} catch {
  console.error(`Android lab login failed at ${stage}; secret-bearing details suppressed.`);
  process.exitCode = 1;
}
