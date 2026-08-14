// Headless gate for the fixture harness (the missing half of the v3.1.238 test rail): serves the
// repo over local http, loads test/harness.html in headless Chromium, and exits by the verdict --
// so the harness can gate releases instead of being driven by hand. release-zips.sh calls this.
//
//   node test/run-harness.js          (from the repo root; puppeteer must be resolvable,
//                                      e.g. NODE_PATH=/path/to/node_modules)
const http = require('http'), fs = require('fs'), path = require('path');
let puppeteer;
try { puppeteer = require('puppeteer'); }
catch (e) { console.error('run-harness: puppeteer not resolvable -- set NODE_PATH to a node_modules that has it'); process.exit(2); }
const ROOT = path.join(__dirname, '..');
const MIME = {'.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css'};
const srv = http.createServer((req, res) => {
    const p = path.normalize(path.join(ROOT, decodeURIComponent(req.url.split('?')[0])));
    if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, {'content-type': MIME[path.extname(p)] || 'application/octet-stream'});
    fs.createReadStream(p).pipe(res);
});
(async () => {
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const browser = await puppeteer.launch({headless: true});
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.error('pageerror:', String(e).slice(0, 200)));
    await page.goto(`http://127.0.0.1:${port}/test/harness.html`, {waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => /PASS|FAIL/.test(document.title), {timeout: 90000});
    const summary = await page.evaluate(() => document.getElementById('summary').textContent);
    const fails = await page.evaluate(() => [...document.querySelectorAll('li.fail')].map(li => li.textContent));
    console.log(summary);
    for (const f of fails) console.log('  ' + f.slice(0, 220));
    await browser.close();
    srv.close();
    process.exit(/HARNESS PASS/.test(summary) ? 0 : 1);
})().catch(e => { console.error('run-harness FATAL', e); process.exit(2); });
