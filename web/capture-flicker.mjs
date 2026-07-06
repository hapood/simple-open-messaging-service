import puppeteer from 'puppeteer-core';
const URL = 'https://192.168.2.7:4200/playground/chatbox-a';
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox','--disable-gpu','--ignore-certificate-errors'], ignoreHTTPSErrors: true });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
page.on('console', m => { if (m.type() === 'error') console.log('[err]', m.text().slice(0,150)); });

await page.evaluateOnNewDocument(() => {
  window.__capture = [];
  let frames = 0;
  function tick() {
    if (window.__stop) return;
    frames++;
    const cap = document.querySelector('.cb-tail-cap');
    const content = document.querySelector('.pg-content, .msg-content');
    const viewport = document.querySelector('.pg-viewport, .msg-viewport');
    const inputBar = document.querySelector('app-chat-input, .ci-input-bar');
    let lastItem = null, itemCount = 0;
    if (content) for (const ch of content.children) {
      if (ch.classList.contains('pg-sentinel') || ch.classList.contains('msg-sentinel')) continue;
      if (ch.classList.contains('cb-tail-cap')) continue;
      lastItem = ch; itemCount++;
    }
    const r = (el) => el ? el.getBoundingClientRect() : null;
    window.__capture.push({ f: frames,
      capH: cap ? Math.round(cap.offsetHeight) : null, capCls: cap ? cap.className : null,
      contentH: content ? Math.round(content.offsetHeight) : null,
      vpH: viewport ? Math.round(viewport.offsetHeight) : null,
      scrollT: viewport ? Math.round(viewport.scrollTop) : null,
      scrollH: viewport ? Math.round(viewport.scrollHeight) : null,
      itemCount, lastBottom: lastItem ? Math.round(r(lastItem).bottom) : null,
      inputTop: inputBar ? Math.round(r(inputBar).top) : null });
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
});

await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise(r => setTimeout(r, 800));
const clicked = await page.evaluate(() => {
  const set = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Set' && !b.disabled);
  if (set) { set.click(); return true; } return false;
});
console.log('clicked Set:', clicked);
await new Promise(r => setTimeout(r, 1500));
await page.evaluate(() => { window.__stop = true; });
const capture = await page.evaluate(() => window.__capture);

console.log(`\n=== ${capture.length} frames ===`);
console.log('frame | capH | capClass            | items | lastBtm | inputTop |  GAP | contentH | vpH | scrollH | scrollT');
let prevKey = null;
for (const s of capture) {
  const gap = (s.inputTop!=null && s.lastBottom!=null) ? (s.inputTop - s.lastBottom) : null;
  const key = `${s.itemCount}|${gap}|${s.capH}`;
  if (key === prevKey) continue;
  prevKey = key;
  if (s.itemCount === 0 && s.capH == null) continue;
  console.log(
    String(s.f).padStart(5), '|', String(s.capH ?? '-').padStart(4), '|',
    (s.capCls || '(none)').slice(0,18).padEnd(18), '|', String(s.itemCount).padStart(5), '|',
    String(s.lastBottom ?? '-').padStart(7), '|', String(s.inputTop ?? '-').padStart(7), '|',
    String(gap ?? '-').padStart(4), '|', String(s.contentH ?? '-').padStart(8), '|',
    String(s.vpH ?? '-').padStart(3), '|', String(s.scrollH ?? '-').padStart(7), '|',
    String(s.scrollT ?? '-').padStart(7));
}
await browser.close();
