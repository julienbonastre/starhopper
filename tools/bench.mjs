// Runs the scripted fly-through in a real, visible Chrome window at the display's own resolution and refresh rate,
// and prints the frame-time and GPU-time statistics.
//   node tools/bench.mjs [--q 0] [--secs 11] [--size 1512x982] [--dpr 2] [--query fixed] [--out bench.json]
// Needs `npm run data && npm run build:dev` first. The default size is the MacBook Pro's built-in display (3024x1964 pixels).
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const port = 8000 + Math.floor(Math.random() * 1000);
const { chromium } = createRequire(import.meta.url)('playwright');
const server = spawn(process.execPath, [path.join(root, 'web', 'serve.mjs'), String(port)], { stdio: 'ignore' });
try {
  await new Promise((r) => setTimeout(r, 500));
  const browser = await chromium.launch({
    headless: false, ...(process.env.PW_CHROME ? { executablePath: process.env.PW_CHROME } : { channel: 'chrome' }),
    args: ['--enable-unsafe-webgpu'],
  });
  // Chrome will not go full screen under automation, so the page is given the display's size and pixel ratio
  // directly: the canvas is then rendered at the native resolution whatever the window shows of it
  const [vw, vh] = arg('size', '1512x982').split('x').map(Number);
  const page = await (await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: +arg('dpr', '2') })).newPage();
  const logs = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(m.text().slice(0, 400)); });
  page.on('pageerror', (e) => logs.push('pageerror: ' + e.message.slice(0, 400)));
  await page.goto(`http://localhost:${port}/?auto&bench&q=${arg('q', '0')}&${arg('query', '')}`);
  await page.waitForFunction(() => window.SH && window.SH.ready, null, { timeout: 120000 });
  await page.waitForTimeout(6000);   // let the resolution scaler settle behind the menu, as it does for a visitor
  const view = await page.evaluate(() => ({ css: [innerWidth, innerHeight], dpr: devicePixelRatio, before: SH.perf() }));
  const result = await page.evaluate((s) => SH.bench(s), +arg('secs', '11'));
  const report = { ...result, view, after: await page.evaluate(() => SH.perf()), console: logs };
  console.log(JSON.stringify(report));
  if (arg('out')) writeFileSync(path.resolve(arg('out')), JSON.stringify(report, null, 1));
  await browser.close();
} finally { server.kill(); }
