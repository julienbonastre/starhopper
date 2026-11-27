// Bundles web/src into dist/index.html (one self-contained page) and copies the baked data next to it.
//   npm run build        minified
//   npm run build:dev    readable, with the development tools (fly-through, benchmark, pose capture)
// For a pull request's preview (see .github/workflows/pages.yml): OUT=<dir> writes there instead of dist,
// PREVIEW=<number> marks the page as a preview of that pull request, and DATA_BASE=<url> makes the page load its
// data from there (the live site's copy) instead of carrying its own.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { build, transform } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url)), root = path.join(here, '..'), dist = path.resolve(process.env.OUT || path.join(root, 'dist'));
const dataBase = process.env.DATA_BASE || 'data/', preview = /^\d+$/.test(process.env.PREVIEW || '') ? process.env.PREVIEW : '';
const dev = process.argv.includes('--dev');
// the build's name: the commit it was made from and that commit's date (shown on the title screen, and written to
// version.json so that a page already open can tell when a newer one has been deployed)
const git = (a) => { try { return execSync('git ' + a, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, TZ: 'UTC' } }).toString().trim(); } catch { return ''; } };
const version = [git('rev-parse --short=7 HEAD') || 'local', git('log -1 --format=%cd --date=format-local:%Y-%m-%d\\ %H:%M\\ UTC') ].filter(Boolean).join(' \u00b7 ') + (git('status --porcelain -- web pipeline') ? ' +' : '');
// shrink the WGSL inside /*wgsl*/`...` literals before the JS is minified
const minWgsl = (s) => s.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ').replace(/ ?([{}()\[\];,:=+\-*\/<>&|!%@]) ?/g, '$1').trim();
const wgsl = {
  name: 'wgsl',
  setup(b) {
    b.onLoad({ filter: /\.js$/ }, (a) => {
      const src = readFileSync(a.path, 'utf8');
      return { contents: dev ? src : src.replace(/\/\*wgsl\*\/`([^`]*)`/g, (_, w) => '`' + minWgsl(w) + '`'), loader: 'js' };
    });
  },
};
const out = await build({
  entryPoints: [path.join(here, 'src', 'main.js')], bundle: true, write: false, format: 'iife', target: 'es2022',
  minify: !dev, legalComments: 'none', define: { DEV: String(dev), DATA_BASE: JSON.stringify(dataBase), PREVIEW: JSON.stringify(preview), VERSION: JSON.stringify(version) }, plugins: [wgsl],
});
let html = readFileSync(path.join(here, 'template.html'), 'utf8');
if (!dev) html = html.replace(/<style>([^]*?)(?=<\/style>)/, '<style>' + (await transform(html.match(/<style>([^]*?)<\/style>/)[1], { loader: 'css', minify: true })).code.trim()).replace(/>\s+</g, '><');
html = html.replace('/*SCRIPT*/', () => out.outputFiles[0].text.trim());
mkdirSync(dist, { recursive: true });
writeFileSync(path.join(dist, 'index.html'), html);
writeFileSync(path.join(dist, 'version.json'), JSON.stringify({ version }));
const data = path.join(root, 'data');
if (dataBase !== 'data/') console.log(`data is loaded from ${dataBase}`);
else if (existsSync(data)) cpSync(data, path.join(dist, 'data'), { recursive: true });
else console.warn('no ./data yet: run `npm run data` first');
console.log(`dist/index.html: ${(html.length / 1024).toFixed(1)} kB${dev ? ' (dev)' : ''}, ${(gzipSync(Buffer.from(html), { level: 9 }).length / 1024).toFixed(1)} kB gzipped`);
