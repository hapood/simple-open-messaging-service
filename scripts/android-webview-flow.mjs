#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const PACKAGE_NAME = process.env.ANDROID_APP_PACKAGE ?? 'com.soms.client';
const ACTIVITY_NAME = process.env.ANDROID_APP_ACTIVITY ?? '.MainActivity';
const DEVTOOLS_PORT = Number(process.env.ANDROID_WEBVIEW_DEVTOOLS_PORT ?? '9222');
const DEFAULT_ORIGIN = process.env.SOMS_ANDROID_ORIGIN ?? 'http://127.0.0.1:3101';

const args = process.argv.slice(2);
const command = args[0] ?? 'help';
const options = parseOptions(args.slice(1));

function parseOptions(items) {
  const parsed = {};
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (!item.startsWith('--')) continue;
    const eq = item.indexOf('=');
    if (eq >= 0) {
      parsed[item.slice(2, eq)] = item.slice(eq + 1);
    } else {
      parsed[item.slice(2)] = items[i + 1]?.startsWith('--') ? true : (items[++i] ?? true);
    }
  }
  return parsed;
}

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
  throw new Error('adb not found; set ADB or ANDROID_HOME');
}

async function adb(adbPath, adbArgs, opts = {}) {
  const result = await execFileAsync(adbPath, adbArgs, {
    timeout: opts.timeout ?? 15000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return result.stdout;
}

async function requireDevice(adbPath) {
  const stdout = await adb(adbPath, ['devices']);
  const devices = stdout
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => serial && state === 'device')
    .map(([serial]) => serial);
  if (devices.length === 0) throw new Error('no adb device is attached');
  const selected = process.env.ANDROID_SERIAL;
  if (selected) {
    if (!devices.includes(selected)) throw new Error(`selected adb device is not connected: ${selected}`);
    return selected;
  }
  if (devices.length > 1) throw new Error(`multiple adb devices are attached: ${devices.join(', ')}; set ANDROID_SERIAL`);
  return devices[0];
}

async function launchApp(adbPath) {
  await adb(adbPath, ['shell', 'input', 'keyevent', 'WAKEUP']).catch(() => '');
  await adb(adbPath, ['shell', 'monkey', '-p', PACKAGE_NAME, '-c', 'android.intent.category.LAUNCHER', '1']);
}

async function findWebViewSocket(adbPath) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const pid = (await adb(adbPath, ['shell', 'pidof', PACKAGE_NAME]).catch(() => '')).trim();
    if (pid && /^\d+$/.test(pid)) {
      const targetSocket = `webview_devtools_remote_${pid}`;
      const stdout = await adb(adbPath, ['shell', 'cat', '/proc/net/unix']);
      if (stdout.includes(`@${targetSocket}`)) return targetSocket;
    }
    const stdout = await adb(adbPath, ['shell', 'cat', '/proc/net/unix']);
    const sockets = stdout
      .split('\n')
      .map((line) => line.match(/@(webview_devtools_remote_\d+)/)?.[1])
      .filter(Boolean);
    if (sockets.length > 0) return sockets.at(-1);
    await delay(500);
  }
  throw new Error('no Android WebView devtools socket found');
}

async function connectWebView(adbPath) {
  await launchApp(adbPath);
  const socket = await findWebViewSocket(adbPath);
  await adb(adbPath, ['forward', `tcp:${DEVTOOLS_PORT}`, `localabstract:${socket}`]);
  const targets = await fetch(`http://127.0.0.1:${DEVTOOLS_PORT}/json/list`).then((r) => r.json());
  const target = targets.find((item) => item.type === 'page');
  if (!target) throw new Error('no WebView page target found');
  return new CdpSession(target.webSocketDebuggerUrl);
}

class CdpSession {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async open() {
    this.ws = new WebSocket(this.url);
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
    });
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    await this.send('Runtime.enable');
    await this.send('Page.enable');
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 10000);
    });
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result?.value;
  }

  close() {
    this.ws?.close();
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function snapshot(cdp) {
  return cdp.eval(`(() => ({
    href: location.href,
    title: document.title,
    textLength: document.body?.innerText?.length ?? 0,
    hasServerLink: !!document.querySelector('.server-link'),
    hasServerForm: !!document.querySelector('app-server-config-page input[type="url"], .cfg-form input[type="url"]'),
    hasOtpForm: !!document.querySelector('app-otp-login-page input[name="account"], input[name="code"]'),
    hasHomeShell: !!document.querySelector('app-home, app-desktop-shell, app-mobile-shell'),
  }))()`);
}

async function openServerConfig(cdp) {
  const ok = await cdp.eval(`(() => {
    const existing = document.querySelector('app-server-config-page input[type="url"], .cfg-form input[type="url"]');
    if (existing) return true;
    const button = document.querySelector('.server-link');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!ok) throw new Error('server configuration entry is not available on this page');
  await waitFor(cdp, `!!document.querySelector('app-server-config-page input[type="url"], .cfg-form input[type="url"]')`, 5000);
}

async function configureServer(cdp, origin) {
  await openServerConfig(cdp);
  await cdp.eval(`((origin) => {
    const input = document.querySelector('app-server-config-page input[type="url"], .cfg-form input[type="url"]');
    if (!input) throw new Error('server URL input not found');
    input.focus();
    input.value = origin;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const submit = document.querySelector('.cfg-form button[type="submit"], button.cfg-action');
    if (!submit) throw new Error('server configuration submit button not found');
  })(${JSON.stringify(origin)})`);
  await waitFor(cdp, `!!document.querySelector('.cfg-form button[type="submit"], button.cfg-action') && !document.querySelector('.cfg-form button[type="submit"], button.cfg-action').disabled`, 5000);
  await cdp.eval(`document.querySelector('.cfg-form button[type="submit"], button.cfg-action').click()`);
  await waitFor(cdp, `!!document.querySelector('.cfg-modal') || location.pathname.startsWith('/auth')`, 30000);
  const autoFill = await cdp.eval(`!!document.querySelector('.cfg-modal')`);
  if (autoFill) {
    await cdp.eval(`(() => {
      const buttons = [...document.querySelectorAll('.cfg-modal button')];
      const ignore = buttons.at(0);
      if (!ignore) throw new Error('secondary-origin ignore button not found');
      ignore.click();
    })()`);
  }
  await waitFor(cdp, `location.href.includes('/auth/') && !document.querySelector('.cfg-modal') && !document.querySelector('.cfg-form')`, 30000);
  await waitFor(cdp, `!!document.querySelector('app-auth-method-menu') || !!document.querySelector('app-otp-login-page')`, 15000);
  return snapshot(cdp);
}

async function switchToOtp(cdp) {
  if (await cdp.eval(`!!document.querySelector('app-otp-login-page input[name="account"]')`)) return;
  await cdp.eval(`(() => {
    const trigger = document.querySelector('app-auth-method-menu button');
    if (!trigger) throw new Error('authentication method menu is not available');
    trigger.click();
  })()`);
  await waitFor(cdp, `!!document.querySelector('.cdk-overlay-pane button')`, 5000);
  await cdp.eval(`(() => {
    const items = [...document.querySelectorAll('.cdk-overlay-pane button')];
    if (items.length === 0) throw new Error('authentication method menu item not found');
    items.at(-1).click();
  })()`);
  await waitFor(cdp, `!!document.querySelector('app-otp-login-page input[name="account"]')`, 10000);
}

async function otpLogin(cdp, account, code) {
  if (!account || !/^\d{6}$/.test(code ?? '')) throw new Error('otp-login requires --account and a six-digit code');
  if (options.diagnose) await cdp.eval(`(() => {
    window.__somsOtpDiag = [];
    const core = window.__TAURI__?.core;
    if (!core) return false;
    const invoke = core.invoke.bind(core);
    core.invoke = async (command, args) => {
      try {
        const response = await invoke(command, args);
        if (command === 'api_request') window.__somsOtpDiag.push({ command, path: args?.path, status: response?.status });
        if (command === 'api_request' && args?.path?.includes('/auth/otp/login'))
          window.__somsOtpDiag.push({ command, status: response?.status });
        if (command === 'set_session_token' || command === 'secure_set_token')
          window.__somsOtpDiag.push({ command, ok: true });
        return response;
      } catch (error) {
        if (command === 'api_request' || command === 'set_session_token' || command === 'secure_set_token')
          window.__somsOtpDiag.push({ command, failed: true, kind: error?.name ?? typeof error });
        throw error;
      }
    };
    return true;
  })()`);
  await switchToOtp(cdp);
  await cdp.eval(`((account, code) => {
    const accountInput = document.querySelector('input[name="account"]');
    const codeInput = document.querySelector('input[name="code"]');
    if (!accountInput || !codeInput) throw new Error('OTP login fields not found');
    accountInput.focus();
    accountInput.value = account;
    accountInput.dispatchEvent(new Event('input', { bubbles: true }));
    codeInput.focus();
    codeInput.value = code;
    codeInput.dispatchEvent(new Event('input', { bubbles: true }));
    const submit = document.querySelector('app-otp-login-page button[type="submit"], form button[type="submit"]');
    if (!submit) throw new Error('OTP submit button not found');
  })(${JSON.stringify(account)}, ${JSON.stringify(code)})`);
  // Zoneless form validation updates the disabled state after the input events. Wait before clicking;
  // Android's software keyboard can also move the form between coordinate capture and pointer delivery.
  await waitFor(cdp, `!!document.querySelector('app-otp-login-page button[type="submit"]') && !document.querySelector('app-otp-login-page button[type="submit"]').disabled`, 5000);
  await cdp.eval(`document.querySelector('app-otp-login-page button[type="submit"]').click()`);
  try {
    await waitFor(cdp, `!location.href.includes('/auth/otp')`, 30000);
  } catch (error) {
    if (options.diagnose) {
      const diagnostic = await cdp.eval(`({ events: window.__somsOtpDiag ?? [], corePresent: !!window.__TAURI__?.core, alertPresent: !!document.querySelector('app-otp-login-page [role="alert"]:not(:empty)') })`);
      console.error(JSON.stringify({ diagnostic }));
    }
    throw error;
  }
  const state = await snapshot(cdp);
  if (state.href.includes('/auth/')) throw new Error('OTP login did not reach the authenticated app');
  return state;
}

async function waitFor(cdp, predicate, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cdp.eval(`(() => Boolean(${predicate}))()`)) return;
    await delay(250);
  }
  throw new Error(`timed out waiting for ${predicate}`);
}

async function readCodeFromStdin() {
  if (process.stdin.isTTY) throw new Error('Pipe the one-time code on stdin, not through an interactive terminal');
  let value = '';
  for await (const chunk of process.stdin) {
    value += chunk;
    if (value.length > 64) throw new Error('one-time code input is too long');
  }
  return value.trim();
}

function usage() {
  console.log(`Android WebView flow helper

Usage:
  node scripts/android-webview-flow.mjs status
  node scripts/android-webview-flow.mjs otp-form
  node scripts/android-webview-flow.mjs configure --origin http://127.0.0.1:3101
  node scripts/android-webview-flow.mjs otp-login --account ACCOUNT --code-stdin
  node scripts/android-webview-flow.mjs configure-otp-login --origin http://127.0.0.1:3101 --account ACCOUNT --code-stdin

Environment:
  ADB                         adb executable path
  ANDROID_SERIAL              required when multiple adb devices are attached
  ANDROID_APP_PACKAGE          default: com.soms.client
  ANDROID_APP_ACTIVITY         default: .MainActivity
  ANDROID_WEBVIEW_DEVTOOLS_PORT default: 9222
  SOMS_ANDROID_ORIGIN          default origin for configure commands
`);
}

async function main() {
  if (command === 'help' || command === '--help' || command === '-h') {
    usage();
    return;
  }

  if ('code' in options) throw new Error('Do not pass one-time codes as command-line arguments; use --code-stdin');
  const code = options['code-stdin'] ? await readCodeFromStdin() : undefined;
  const adbPath = await findAdb();
  const device = await requireDevice(adbPath);
  const cdp = await connectWebView(adbPath);
  await cdp.open();
  try {
    let result;
    if (command === 'status') {
      result = await snapshot(cdp);
    } else if (command === 'otp-form') {
      await switchToOtp(cdp);
      result = await snapshot(cdp);
    } else if (command === 'configure') {
      result = await configureServer(cdp, options.origin ?? DEFAULT_ORIGIN);
    } else if (command === 'otp-login') {
      result = await otpLogin(cdp, options.account, code);
    } else if (command === 'configure-otp-login') {
      await configureServer(cdp, options.origin ?? DEFAULT_ORIGIN);
      result = await otpLogin(cdp, options.account, code);
    } else {
      usage();
      throw new Error(`unknown command: ${command}`);
    }
    console.log(JSON.stringify({ adb: adbPath, device, command, result }, null, 2));
  } finally {
    cdp.close();
  }
}

main().catch((error) => {
  console.error(command === 'otp-form' ? error.message : 'Android WebView flow failed; inspect the device without exposing authentication input.');
  process.exitCode = 1;
});
