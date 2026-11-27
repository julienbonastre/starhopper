// Fetches every pinned catalogue and bakes the binary data the site streams. Deterministic: same inputs, same bytes.
//   npm run data                 bake everything into ./data
//   npm run data -- --print-sha  also print the checksum of each downloaded source
import { rmSync } from 'node:fs';
import path from 'node:path';
import { OUT, writeOut } from './lib.mjs';
import { SOURCES } from './sources.mjs';
import { bakeStars } from './stars.mjs';
import { bakeGalaxies } from './galaxies.mjs';
import { bakeDeep, DEEP_SOURCES } from './deep.mjs';
import { bakeEarth, EARTH_SOURCES } from './earth.mjs';
import { bakeExoplanets, EXO_SOURCES } from './exoplanets.mjs';

const opts = { printSha: process.argv.includes('--print-sha') };
const t0 = Date.now();
rmSync(OUT, { recursive: true, force: true });
const stats = {};
console.log('stars'); stats.stars = await bakeStars(opts);
console.log('galaxies'); stats.galaxies = await bakeGalaxies(opts);
console.log('nebulae and clusters'); stats.deep = await bakeDeep(opts);
console.log('exoplanet hosts'); stats.exoplanets = await bakeExoplanets(opts);
console.log('earth'); stats.earth = await bakeEarth(opts);
writeOut('manifest.json', JSON.stringify({
  sources: Object.values({ ...SOURCES, ...DEEP_SOURCES, ...EXO_SOURCES, ...EARTH_SOURCES }).map(({ title, url, sha256, licence, credit, home }) => ({ title, url, sha256, licence, credit, home })),
  stats,
}, null, 1));
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s -> ${path.relative(process.cwd(), OUT)}`);
