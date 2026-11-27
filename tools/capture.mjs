// Renders the fixed viewpoints in a real browser and saves them as PNGs, with a small report.
//   node tools/capture.mjs [--out captures] [--size 1920x1080] [--poses 1,2,3] [--q 0] [--headed] [--query extra=1] [--fly]
// Needs `npm run data && npm run build:dev` first, and Playwright (`npm i` installs it; it drives your Chrome).
// Set PW_CHROME to a Chromium binary to use that instead of the installed Chrome.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1]; };
const out = path.resolve(root, arg('out', 'captures')), [w, h] = arg('size', '1920x1080').split('x').map(Number);
const port = 8000 + Math.floor(Math.random() * 1000);
const { chromium } = createRequire(import.meta.url)('playwright');

mkdirSync(out, { recursive: true });
const server = spawn(process.execPath, [path.join(root, 'web', 'serve.mjs'), String(port)], { stdio: 'ignore' });
try {
  await new Promise((r) => setTimeout(r, 600));
  const browser = await chromium.launch({
    headless: !process.argv.includes('--headed'),
    ...(process.env.PW_CHROME ? { executablePath: process.env.PW_CHROME } : { channel: 'chrome' }),
    args: ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist', ...(process.platform === 'linux' ? ['--enable-features=Vulkan'] : [])],
  });
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const logs = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(m.text().slice(0, 400)); });
  page.on('pageerror', (e) => logs.push('pageerror: ' + e.message.slice(0, 400)));
  await page.goto(`http://localhost:${port}/?auto&offscreen&jd=${arg('jd', '2461390')}&q=${arg('q', '0')}&${arg('query', '')}`);
  await page.waitForFunction(() => window.SH && window.SH.ready, null, { timeout: 120000 });
  const report = { size: [w, h], adapter: await page.evaluate(async () => { const a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }); return { vendor: a.info.vendor, architecture: a.info.architecture, fallback: a.info.isFallbackAdapter }; }), userAgent: await page.evaluate(() => navigator.userAgent), poses: [] };
  const names = await page.evaluate(() => SH.POSES.map((p) => p.name));
  const list = arg('poses', names.map((_, i) => i + 1).join(',')).split(',').map(Number);
  for (const n of list) {
    await page.evaluate((i) => { SH.setPose(i - 1); SH.settle(); }, n);
    // wait until every tile this view needs has arrived, then a little longer for the exposure to settle
    for (let k = 0; k < 120; k++) { await page.waitForTimeout(250); if (k > 3 && !(await page.evaluate(() => SH.stars.stats().pending + SH.galPts.stats().pending))) break; }
    // a few more frames, so the exposure has settled on the new surroundings
    const f0 = await page.evaluate(() => { SH.settle(); return SH.frames(); });
    await page.waitForFunction((f) => SH.frames() >= f + 8, f0, { timeout: 120000 });
    const url = await page.evaluate(() => SH.capture());
    const file = `pose_${n}.png`;
    writeFileSync(path.join(out, file), Buffer.from(url.split(',')[1], 'base64'));
    const info = await page.evaluate(() => ({ stars: SH.stars.stats().drawn, galaxies: SH.galPts.stats().drawn, perf: SH.perf ? SH.perf() : null }));
    report.poses.push({ n, name: names[n - 1], file, ...info });
    console.log(`pose ${n} ${names[n - 1]}: ${info.stars} stars, ${info.galaxies} galaxy points${info.perf ? `, ${JSON.stringify(info.perf)}` : ''}`);
  }
  // --fly: pairs of frames a few frames apart along the scripted fly-through, to show popping, shimmer and seams
  if (process.argv.includes('--fly')) {
    report.fly = [];
    await page.evaluate(() => { SH.setPose(0); SH.settle(); });
    await page.waitForTimeout(1500);
    for (let leg = 1; leg <= names.length; leg++) {
      await page.evaluate((i) => { const p = SH.POSES[i % SH.POSES.length]; SH.flyTo(p.p[0], p.p[1], p.p[2], 0, 11); }, leg);
      for (const [k, at] of [[0, 3200], [1, 3600]]) {
        await page.waitForTimeout(at);
        for (const half of ['a', 'b']) {
          const f0 = await page.evaluate(() => SH.frames());
          if (half === 'b') await page.waitForFunction((f) => SH.frames() >= f + 3, f0, { timeout: 60000 });
          const url = await page.evaluate(() => SH.capture()), file = `fly_${leg}_${k}${half}.png`;
          writeFileSync(path.join(out, file), Buffer.from(url.split(',')[1], 'base64'));
          report.fly.push({ file, toward: names[leg % names.length] });
        }
      }
      await page.waitForTimeout(11000 - 6800 + 400);
    }
    console.log(`fly-through: ${report.fly.length} frames`);
  }
  report.console = logs;
  writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 1));
  console.log(`adapter: ${JSON.stringify(report.adapter)}${logs.length ? `\n${logs.length} console messages, see report.json` : ''}`);
  await browser.close();
} finally { server.kill(); }
