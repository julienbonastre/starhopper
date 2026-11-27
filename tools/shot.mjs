// One-off renders for development: runs a snippet against the page's SH hooks, then saves the frame.
//   node tools/shot.mjs --out /tmp/a.png [--size 1920x1080] [--pose 5] [--js "SH.cam.p[0] += 10"] [--wait 8] [--q 0] [--query fixed] [--headed] [--uncapped]
// --js runs after the pose is set (several --js are run in order, each followed by a settle); the snippet's value is printed.
// --uncapped lets frames run as fast as they can: the GPU then stays at full clock, so SH.perf() times are comparable.
// Needs `npm run data && npm run build:dev` first.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const all = (k) => args.flatMap((a, i) => (a === '--' + k ? [args[i + 1]] : []));
const out = path.resolve(arg('out', 'shot.png')), [w, h] = arg('size', '1920x1080').split('x').map(Number);
const port = 8000 + Math.floor(Math.random() * 1000);
const { chromium } = createRequire(import.meta.url)('playwright');
const server = spawn(process.execPath, [path.join(root, 'web', 'serve.mjs'), String(port)], { stdio: 'ignore' });
try {
  await new Promise((r) => setTimeout(r, 500));
  const browser = await chromium.launch({
    headless: !args.includes('--headed'),
    ...(process.env.PW_CHROME ? { executablePath: process.env.PW_CHROME } : { channel: 'chrome' }),
    args: ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist', ...(args.includes('--uncapped') ? ['--disable-frame-rate-limit', '--disable-gpu-vsync'] : [])],
  });
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('console: ' + m.text().slice(0, 600)); });
  page.on('pageerror', (e) => console.log('pageerror: ' + e.message.slice(0, 600)));
  await page.goto(`http://localhost:${port}/?auto&offscreen&q=${arg('q', '0')}&${arg('query', '')}`);
  await page.waitForFunction(() => window.SH && window.SH.ready, null, { timeout: 120000 });
  const settle = async () => {
    for (let k = 0; k < 120; k++) { await page.waitForTimeout(250); if (k > 3 && !(await page.evaluate(() => SH.stars.stats().pending + SH.galPts.stats().pending))) break; }
    const f0 = await page.evaluate(() => { SH.settle(); return SH.frames(); });
    await page.waitForFunction((f) => SH.frames() >= f + +new URLSearchParams(location.search).get('w') + 8, f0, { timeout: 120000 }).catch(() => {});
  };
  await page.evaluate((i) => { SH.setPose(i - 1); SH.settle(); }, +arg('pose', '1'));
  await settle();
  for (const js of all('js')) {
    const v = await page.evaluate(`(async () => { const r = await (async () => { ${js.includes('return') ? js : 'return ' + js} })(); SH.basis(); SH.settle(); return r; })()`);
    if (v !== undefined && v !== null) console.log(typeof v === 'string' ? v : JSON.stringify(v));
    await settle();
  }
  await page.waitForTimeout(+arg('wait', '0') * 1000);
  const url = await page.evaluate(() => SH.capture());
  writeFileSync(out, Buffer.from(url.split(',')[1], 'base64'));
  console.log(`${out}  ${JSON.stringify(await page.evaluate(() => SH.perf()))}`);
  await browser.close();
} finally { server.kill(); }
