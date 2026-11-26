// Bundles web/src into dist/index.html (one self-contained page) and copies the baked data next to it.
//   npm run build        minified
//   npm run build:dev    readable, with the development tools (fly-through, benchmark, pose capture)
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, transform } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url)), root = path.join(here, '..'), dist = path.join(root, 'dist');
const dev = process.argv.includes('--dev');
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
  minify: !dev, legalComments: 'none', define: { DEV: String(dev) }, plugins: [wgsl],
});
let html = readFileSync(path.join(here, 'template.html'), 'utf8');
if (!dev) html = html.replace(/<style>([^]*?)(?=<\/style>)/, '<style>' + (await transform(html.match(/<style>([^]*?)<\/style>/)[1], { loader: 'css', minify: true })).code.trim()).replace(/>\s+</g, '><');
html = html.replace('/*SCRIPT*/', () => out.outputFiles[0].text.trim());
mkdirSync(dist, { recursive: true });
writeFileSync(path.join(dist, 'index.html'), html);
const data = path.join(root, 'data');
if (existsSync(data)) cpSync(data, path.join(dist, 'data'), { recursive: true });
else console.warn('no ./data yet: run `npm run data` first');
console.log(`dist/index.html: ${(html.length / 1024).toFixed(1)} kB${dev ? ' (dev)' : ''}, ${(gzipSync(Buffer.from(html), { level: 9 }).length / 1024).toFixed(1)} kB gzipped`);
