import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox','--disable-gpu','--ignore-certificate-errors'], ignoreHTTPSErrors: true });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
await page.goto('https://192.168.2.7:4200/playground/chatbox', { waitUntil: 'networkidle2', timeout: 60000 }).catch(e=>console.log('goto',e.message));
await new Promise(r=>setTimeout(r,3000));
const probe = await page.evaluate(() => {
  const dump = (sel) => { const el = document.querySelector(sel); return el ? {tag:el.tagName, cls:el.className, h:el.offsetHeight} : null; };
  return {
    url: location.href,
    bodyStart: document.body?.innerHTML?.slice(0,300),
    pg: dump('.pg'),
    pgStage: dump('.pg-stage'),
    pgViewport: dump('.pg-viewport'),
    pgContent: dump('.pg-content'),
    tailCap: dump('.cb-tail-cap'),
    rows: document.querySelectorAll('.pg-content > *').length,
    rowClasses: [...document.querySelectorAll('.pg-content > *')].slice(0,5).map(e=>e.className||e.tagName),
  };
});
console.log(JSON.stringify(probe, null, 2));
await page.screenshot({path:'/tmp/pg.png'});
await browser.close();
