import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { configureServer, otpLogin } from './android-webview-flow.mjs';

let browser;
before(async () => {
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
});

async function fixture(t, html) {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.route('http://flow.test/**', (route) =>
    route.fulfill({ body: html, contentType: 'text/html' }),
  );
  await page.goto('http://flow.test/auth/login');
  return { page, cdp: { eval: (expression) => page.evaluate(expression) } };
}

for (const http of [false, true]) {
  for (const pair of [false, true]) {
    test(`server setup handles HTTP=${http}, advertised pair=${pair}`, async (t) => {
      const { page, cdp } = await fixture(
        t,
        `
        <form class="cfg-form" onsubmit="event.preventDefault(); begin()">
          <input type="url"><button type="submit">Connect</button>
        </form><div id="overlay"></div>
        <script>
          window.actions = [];
          function finish() {
            document.querySelector('.cfg-form').remove();
            document.querySelector('#overlay').innerHTML = '<app-login></app-login>';
          }
          function pairPrompt() {
            ${pair ? `document.querySelector('#overlay').innerHTML = ${JSON.stringify('<div class="cfg-modal" aria-labelledby="server-pair-confirm-title"><button class="app-secondary-action" onclick="actions.push(\'ignore-pair\'); finish()">Ignore</button></div>')};` : 'finish();'}
          }
          function begin() {
            ${http ? `document.querySelector('#overlay').innerHTML = ${JSON.stringify('<div class="cfg-modal" aria-labelledby="server-http-confirm-title"><button onclick="actions.push(\'cancel-http\')">Back</button><button mat-flat-button onclick="actions.push(\'accept-http\'); pairPrompt()">Continue</button></div>')};` : 'pairPrompt();'}
          }
        </script>`,
      );
      await configureServer(cdp, `${http ? 'http' : 'https'}://server.example`);
      assert.deepEqual(await page.evaluate(() => window.actions), [
        ...(http ? ['accept-http'] : []),
        ...(pair ? ['ignore-pair'] : []),
      ]);
    });
  }
}

test('OTP uses only the active tab fields and submit action', async (t) => {
  const { page, cdp } = await fixture(
    t,
    `
    <form onsubmit="event.preventDefault()">
      <div hidden><input name="account"><button type="submit" onclick="window.wrong=true">Password</button></div>
      <button type="button" role="tab" onclick="document.querySelector('#otp').className='mat-mdc-tab-body-active'">OTP</button>
      <div id="otp"><input name="otpAccount"><input name="code">
        <button type="submit" onclick="window.values=[document.querySelector('[name=otpAccount]').value,document.querySelector('[name=code]').value];history.pushState({},'', '/home')">Login</button>
      </div>
    </form>`,
  );
  await otpLogin(cdp, 'test-account', '123456');
  assert.deepEqual(await page.evaluate(() => window.values), [
    'test-account',
    '123456',
  ]);
  assert.equal(await page.evaluate(() => window.wrong), undefined);
});
