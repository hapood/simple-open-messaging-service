#!/usr/bin/env node
/**
 * Manual verification for the always-mounted ChatPane exit slide (Phase 1 of the route-animation rework).
 *
 * What it checks (the original bug): on mobile, closing a chat (`/chat/:id` → `/`) used to slide the
 * EMPTY placeholder out, because the router swapped ChatPane → ChatEmpty before the [@overlaySlide] transform
 * ran. With ChatReuseStrategy + the shell's lagged close, the REAL chat must slide out, and ChatEmpty may
 * appear only AFTER the post-slide reset. This script logs in on a mobile viewport, opens a conversation,
 * triggers the close, samples `.chat-slot` every 15ms through the slide, and asserts exactly that.
 *
 * NOT a unit test — it needs the full stack running. Requirements:
 *   - web dev server: `npm --prefix web run start` (HTTPS by default — the script ignores cert errors)
 *   - API + DB up (the home shell is auth-gated and needs ≥1 conversation for the test account)
 *   - google-chrome on PATH (or set CHROME_PATH)
 *   - puppeteer-core resolvable: run with `NODE_PATH=$(pwd)/node_modules node scripts/verify-chat-slide.js`
 *     from `web/`, or `NODE_PATH=web/node_modules node web/scripts/verify-chat-slide.js` from the repo root.
 *
 * Config (env vars, defaults shown):
 *   SOMS_BASE=https://localhost:4200  SOMS_USER=hapood  SOMS_PASS=123456  OUT_DIR=/tmp
 *
 * Usage:
 *   NODE_PATH=web/node_modules node web/scripts/verify-chat-slide.js
 * Exit code 0 on PASS, 1 on FAIL/script error. Screenshots: $OUT_DIR/pg-{1-list,2-open,3-loaded,4-closed}.png.
 */
const puppeteer = require('puppeteer-core');
const { execSync } = require('child_process');

const BASE = process.env.SOMS_BASE || 'https://localhost:4200';
const USER = process.env.SOMS_USER || 'hapood';
const PASS = process.env.SOMS_PASS || '123456';
const OUT = process.env.SOMS_OUT_DIR || process.env.OUT_DIR || '/tmp';
const CHROME = process.env.CHROME_PATH || execSync('which google-chrome').toString().trim();
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--ignore-certificate-errors'],
    defaultViewport: { width: 390, height: 844, isMobile: true, hasTouch: true },
  });
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') log('[browser]', m.type(), m.text()); });
  page.on('pageerror', (e) => log('[pageerror]', e.message));

  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 30000 });
  log('1. after load:', page.url());

  await page.waitForSelector('input[name="uniqName"]', { timeout: 15000 });
  await page.type('input[name="uniqName"]', USER);
  await page.type('input[name="password"]', PASS);
  // zoneless: wait for CD to enable the submit button before clicking, else the click is a no-op.
  await page.waitForSelector('button.submit-btn:not([disabled])', { timeout: 5000 });
  await sleep(300);
  await page.click('button.submit-btn');
  await page.waitForSelector('.thread-item', { timeout: 20000 });
  log('2. logged in:', page.url(), '| threads:', await page.$$eval('.thread-item', (e) => e.length));
  await page.screenshot({ path: `${OUT}/pg-1-list.png` });

  const slotState = () =>
    page.evaluate(() => {
      const slot = document.querySelector('.chat-slot');
      if (!slot) return { absent: true };
      const cs = getComputedStyle(slot);
      return {
        url: location.pathname,
        transform: cs.transform,
        visibility: cs.visibility,
        hasThread: !!slot.querySelector('app-message-thread'),
        hasHeader: !!slot.querySelector('app-message-header'),
        hasEmpty: !!slot.querySelector('app-chat-empty'),
        rows: slot.querySelectorAll('.pg-msg-row').length,
      };
    });

  const listSlot = await slotState();
  const listSlotTransform = listSlot.transform || '';
  log('LIST slot:', JSON.stringify(listSlot));

  await Promise.all([
    page.waitForSelector('.chat-slot app-message-thread', { timeout: 10000 }),
    page.click('.thread-item'),
  ]);
  log('3. opened chat:', page.url());
  await sleep(800);
  await page.screenshot({ path: `${OUT}/pg-2-open.png` });
  log('OPEN slot:', JSON.stringify(await slotState()));

  await sleep(1500);
  await page.screenshot({ path: `${OUT}/pg-3-loaded.png` });
  log('LOADED slot:', JSON.stringify(await slotState()));

  // close (browser back → popstate → SPA to /) and sample mid-slide
  const beforeUrl = page.url();
  await page.evaluate(() => window.history.back());
  await sleep(20);
  const samples = [];
  for (let i = 0; i < 28; i++) {
    samples.push(await slotState());
    await sleep(15);
  }
  // Decisive: while the slot is ACTIVELY translating (between open 0 and fully-closed = viewport width),
  // it must hold the real chat. ChatEmpty appearing only once the slot is fully off-screen is the correct
  // post-slide reset — NOT the bug.
  const txOf = (s) => {
    const m = (s.transform || '').match(/matrix\(1, 0, 0, 1, ([\d.]+)/);
    return m ? parseFloat(m[1]) : 0;
  };
  const closedTx = txOf({ transform: listSlotTransform });
  const translating = samples.filter((s) => txOf(s) > 0 && txOf(s) < closedTx - 1);
  const realChatWhileSliding = translating.some((s) => s.hasThread);
  const emptyWhileSliding = translating.some((s) => s.hasEmpty && !s.hasThread);

  log('4. close triggered from', beforeUrl, '→', page.url());
  log('samples:', samples.length, '| actively translating:', translating.length, '(closedTx=' + closedTx + ')');
  log('   first:', JSON.stringify(samples[0]));
  log('   mid:  ', JSON.stringify(samples[Math.floor(samples.length / 2)]));
  log('   last: ', JSON.stringify(samples[samples.length - 1]));
  log('*** REAL CHAT present while slot is sliding out:', realChatWhileSliding);
  log('*** EMPTY-ONLY present while slot is sliding out:', emptyWhileSliding);

  await sleep(500);
  await page.screenshot({ path: `${OUT}/pg-4-closed.png` });
  log('FINAL slot (post-slide reset):', JSON.stringify(await slotState()));
  await browser.close();
  log(`screenshots: ${OUT}/pg-{1-list,2-open,3-loaded,4-closed}.png`);

  const pass = realChatWhileSliding && !emptyWhileSliding;
  log('VERDICT:', pass
    ? 'PASS — real chat slides out; ChatEmpty only after the post-slide reset (no empty-logo flash)'
    : 'FAIL — empty logo appears mid-slide');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('SCRIPT FAIL:', e); process.exit(1); });
