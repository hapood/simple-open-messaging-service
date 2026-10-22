#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const LAB_PORTS = [3101, 3102, 3103];
const NODE_NAMES = ['Alpha', 'Bravo', 'Charlie'];
const args = new Set(process.argv.slice(2));
const json = args.has('--json');
const noReverse = args.has('--no-reverse');
const preferLan = args.has('--lan');

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function findAdb() {
  const names = process.platform === 'win32' ? ['adb.exe', 'adb'] : ['adb'];
  const pathDirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const roots = [
    process.env.ADB,
    process.env.ANDROID_HOME && join(process.env.ANDROID_HOME, 'platform-tools'),
    process.env.ANDROID_SDK_ROOT && join(process.env.ANDROID_SDK_ROOT, 'platform-tools'),
    join(process.env.HOME ?? '', 'Android', 'Sdk', 'platform-tools'),
    join(process.env.HOME ?? '', 'Library', 'Android', 'sdk', 'platform-tools'),
    '/run/host/home/lenovo/Android/Sdk/platform-tools',
    '/run/host/data/home/lenovo/Android/Sdk/platform-tools',
    '/run/host/usr/lib/android-sdk/platform-tools',
  ].filter(Boolean);

  for (const root of [...pathDirs, ...roots]) {
    for (const name of names) {
      const candidate = root.endsWith(name) ? root : join(root, name);
      if (await exists(candidate)) return candidate;
    }
  }
  return null;
}

function hostCandidates() {
  const ignored = /^(lo|docker|br-|veth|virbr|utun|tun|tap|dns)/;
  const candidates = ['127.0.0.1'];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    if (ignored.test(name)) continue;
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      candidates.push(entry.address);
    }
  }
  return [...new Set(candidates)];
}

async function probe(origin) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(`${origin}/api/v1/client/compat`, {
      signal: controller.signal,
    });
    if (!response.ok) return { origin, ok: false, status: response.status };
    const body = await response.json().catch(() => null);
    return {
      origin,
      ok: true,
      status: response.status,
      primaryOrigin: body?.data?.primaryOrigin,
      serverVersion: body?.data?.serverVersion,
    };
  } catch (error) {
    return { origin, ok: false, error: error?.name ?? String(error) };
  } finally {
    clearTimeout(timeout);
  }
}

async function adbDevices(adb) {
  const { stdout } = await execFileAsync(adb, ['devices'], { timeout: 5000 });
  return stdout
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => serial && state === 'device')
    .map(([serial]) => serial);
}

async function configureReverse(adb) {
  const result = { configured: [], failed: [] };
  for (const port of LAB_PORTS) {
    try {
      await execFileAsync(adb, ['reverse', `tcp:${port}`, `tcp:${port}`], {
        timeout: 5000,
      });
      result.configured.push(port);
    } catch (error) {
      result.failed.push({ port, error: error.stderr?.trim() || error.message });
    }
  }
  return result;
}

async function main() {
  const candidates = hostCandidates();
  const probes = [];
  for (const host of candidates) {
    for (const port of LAB_PORTS) probes.push(await probe(`http://${host}:${port}`));
  }

  const reachable = probes.filter((item) => item.ok);
  const loopbackUsable = LAB_PORTS.every((port) =>
    reachable.some((item) => item.origin === `http://127.0.0.1:${port}`),
  );
  const lanHosts = candidates.filter((host) => host !== '127.0.0.1');
  const lanUsable = lanHosts.find((host) =>
    LAB_PORTS.every((port) =>
      reachable.some((item) => item.origin === `http://${host}:${port}`),
    ),
  );

  const adb = await findAdb();
  let devices = [];
  let reverse = null;
  let adbError = null;
  if (adb) {
    try {
      devices = await adbDevices(adb);
      if (devices.length > 0 && !noReverse) reverse = await configureReverse(adb);
    } catch (error) {
      adbError = error.stderr?.trim() || error.message;
    }
  }

  const reverseReady = LAB_PORTS.every((port) => reverse?.configured.includes(port));
  const preferredHost = preferLan && lanUsable
    ? lanUsable
    : reverseReady && loopbackUsable
      ? '127.0.0.1'
      : lanUsable;
  const recommended = preferredHost
    ? LAB_PORTS.map((port, index) => ({
        node: NODE_NAMES[index],
        origin: `http://${preferredHost}:${port}`,
      }))
    : [];

  const output = {
    adb,
    devices,
    reverse,
    adbError,
    hostCandidates: candidates,
    reachable,
    recommended,
    note:
      preferredHost === '127.0.0.1'
        ? 'Use the 127.0.0.1 origins inside Android; adb reverse maps them to this host.'
        : lanUsable
          ? 'Use the LAN origins inside Android; the Android device must be on the same network.'
          : 'No complete lab edge set is reachable from this host.',
  };

  if (json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  console.log('Android lab server helper');
  console.log(`ADB: ${adb ?? 'not found'}`);
  if (adbError) console.log(`ADB error: ${adbError}`);
  console.log(`Devices: ${devices.length ? devices.join(', ') : 'none'}`);
  if (reverse) {
    console.log(
      `adb reverse: configured ${reverse.configured.join(', ') || 'none'}${
        reverse.failed.length ? `; failed ${JSON.stringify(reverse.failed)}` : ''
      }`,
    );
  }
  console.log(`Host candidates: ${candidates.join(', ')}`);
  console.log('Reachable lab edges:');
  for (const item of reachable) {
    console.log(
      `  ${item.origin} (${item.serverVersion ?? 'unknown'}, advertises ${
        item.primaryOrigin ?? 'unknown'
      })`,
    );
  }
  console.log('Recommended Android server origins:');
  if (recommended.length === 0) {
    console.log('  none');
  } else {
    for (const item of recommended) console.log(`  ${item.node}: ${item.origin}`);
  }
  console.log(output.note);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
