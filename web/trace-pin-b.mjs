import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox','--disable-gpu','--ignore-certificate-errors'], ignoreHTTPSErrors: true });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
page.on('console', m => { const t = m.text(); if (t.startsWith('[trace]')) console.log(t); });

await page.goto('https://192.168.2.7:4200/playground/chatbox-b', { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise(r => setTimeout(r, 600));

// Instrument: intercept scrollTop writes + childList mutations on the content/viewport.
await page.evaluate(() => {
  const log = [];
  let frame = 0;
  const raf = () => requestAnimationFrame(() => { frame++; raf(); });
  raf();
  const find = () => ({
    vp: document.querySelector('.pg-viewport, .msg-viewport'),
    ct: document.querySelector('.pg-content, .msg-content'),
  });
  // wait for elements
  const tryHook = () => {
    const { vp, ct } = find();
    if (!vp || !ct) { setTimeout(tryHook, 30); return; }
    // hook scrollTop setter on the viewport element instance
    const proto = Object.getPrototypeOf(vp);
    const desc = Object.getOwnPropertyDescriptor(proto, 'scrollTop') || Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
    Object.defineProperty(vp, 'scrollTop', {
      get: desc.get, set(v) {
        console.log(`[trace] f${frame} SET scrollTop=${Math.round(v)} childCount=${ct.children.length} scrollH=${ct.scrollHeight} vh=${vp.clientHeight}`);
        desc.set.call(vp, v);
      },
    });
    // mutation observer for child inserts
    new MutationObserver((muts) => {
      let added = 0;
      for (const m of muts) added += m.addedNodes.length;
      if (added) console.log(`[trace] f${frame} INSERT +${added} → childCount=${ct.children.length} scrollT=${Math.round(vp.scrollTop)} scrollH=${ct.scrollHeight}`);
    }).observe(ct, { childList: true });
    console.log('[trace] hooked');
  };
  tryHook();
});

await new Promise(r => setTimeout(r, 300));
const clicked = await page.evaluate(() => {
  const set = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Set' && !b.disabled);
  if (set) { set.click(); return true; } return false;
});
console.log('clicked Set:', clicked);
await new Promise(r => setTimeout(r, 1500));
await browser.close();
