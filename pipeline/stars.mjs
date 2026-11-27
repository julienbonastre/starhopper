// Bakes AT-HYG into a luminosity-ordered octree of binary star tiles, plus the named-star and constellation indexes.
//
// Positions sit on one global 31-bit integer grid centred on the Sun (cube of +-HALF parsecs), so the renderer can
// subtract the camera in exact integer arithmetic and keep sub-AU precision anywhere in the cube.
//   star record = 4 x uint32 LE: gx, gy, gz, packed
//   packed      = absmag16 << 16 | colour8 << 8 | flags8
//   absmag16    = round((absmag + 20) * 1000)      colour8 = round((B-V + 0.5) * 80), 1..255
// Each octree node holds the most luminous stars of its volume that no ancestor holds, brightest first, so that
// "everything visible from here" is always a set of whole nodes and, within a node, a prefix.
import { fetchSource, readCsv, writeOut, eq2xyz } from './lib.mjs';
import { SOURCES } from './sources.mjs';
import { readFileSync } from 'node:fs';
import { bakeTree } from './octree.mjs';

export const HALF = 131072;                 // parsecs; the cube spans +-HALF around the Sun
export const STEP = (2 * HALF) / 2 ** 31;   // parsecs per grid unit (about 25 AU)
const SPECT_CI = { O: -0.3, B: -0.17, A: 0.08, F: 0.42, G: 0.68, K: 1.05, M: 1.55, L: 2.0, T: 2.0, C: 1.8, S: 1.7, N: 1.8, R: 1.4, W: -0.3, D: 0.1 };

export async function bakeStars(opts) {
  const file = await fetchSource(SOURCES.athyg, opts);
  // ---- pass 1: read
  let cap = 2_600_000, n = 0;
  let gx = new Int32Array(cap), gy = new Int32Array(cap), gz = new Int32Array(cap), pk = new Uint32Array(cap), am = new Float32Array(cap);
  const hipIdx = new Map();   // HIP number -> star index
  const named = [];           // stars that get a label / search entry
  let col, skippedNoDist = 0, skippedFar = 0, ciFromSpect = 0, ciDefault = 0;
  await readCsv(file, (f) => {
    if (!col) { col = Object.fromEntries(f.map((k, i) => [k, i])); return; }
    const dist = +f[col.dist];
    if (f[col.dist] === '' || !(dist > 0) || dist >= 99999) { skippedNoDist++; return; }
    let x = +f[col.x0], y = +f[col.y0], z = +f[col.z0];
    const proper = f[col.proper];
    if (proper === 'Sol') x = y = z = 0;
    if (Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) >= HALF) { skippedFar++; return; }
    const absmag = +f[col.absmag];
    let ci = f[col.ci] === '' ? NaN : +f[col.ci];
    if (!(ci === ci)) {
      const s = SPECT_CI[(f[col.spect] || '').replace(/^(sd|d|g|c)/, '')[0]];
      if (s === undefined) { ci = 0.65; ciDefault++; } else { ci = s; ciFromSpect++; }
    }
    const i = n++;
    gx[i] = Math.round((x + HALF) / STEP); gy[i] = Math.round((y + HALF) / STEP); gz[i] = Math.round((z + HALF) / STEP);
    am[i] = absmag;
    const a16 = Math.max(0, Math.min(65535, Math.round((absmag + 20) * 1000)));
    const c8 = Math.max(1, Math.min(255, Math.round((ci + 0.5) * 80)));
    pk[i] = ((a16 << 16) | (c8 << 8)) >>> 0;
    const hip = f[col.hip];
    if (hip) hipIdx.set(+hip, i);
    const bayer = f[col.bayer], flam = f[col.flam], con = f[col.con];
    if (proper || bayer || flam) {
      named.push({ i, proper, des: bayer ? `${bayer} ${con}` : `${flam} ${con}`, hip: hip ? +hip : 0, mag: +f[col.mag], absmag, ci, spect: f[col.spect], dist });
    }
  });
  console.log(`  stars: ${n} placed, ${skippedNoDist} without a distance, ${skippedFar} outside the cube; colour from spectral type for ${ciFromSpect}, default for ${ciDefault}`);

  const tree = bakeTree('stars', { half: HALF, step: STEP, n, gx, gy, gz, pk, am });

  // ---- named stars and constellations (exact float positions, decoded from the same grid)
  const pos = (i) => [gx[i] * STEP - HALF, gy[i] * STEP - HALF, gz[i] * STEP - HALF];
  const sky = JSON.parse(readFileSync(await fetchSource(SOURCES.constellations, opts), 'utf8'));
  const iauNames = new Map();
  for (const [k, v] of Object.entries(sky.common_names)) if (k.startsWith('HIP ') && v[0]?.english) iauNames.set(+k.slice(4), v[0].english);
  const r5 = (v) => +v.toPrecision(9);
  const stars = named.map((s) => {
    const name = s.proper || iauNames.get(s.hip) || '';
    return [name, s.des.replace(/undefined|^ | $/g, '').trim(), ...pos(s.i).map(r5), +s.absmag.toFixed(2), +s.ci.toFixed(2), s.spect || '', s.hip];
  });
  stars.sort((a, b) => a[5] - b[5]);
  const missing = new Set();
  const cons = sky.constellations.map((c) => {
    const abbr = c.id.split(' ').pop();
    const pts = [], at = new Map(), lines = [];
    for (const line of c.lines) {
      const seg = [];
      for (const hip of line) {
        const i = hipIdx.get(hip);
        if (i === undefined) { missing.add(hip); if (seg.length > 1) lines.push(seg.slice()); seg.length = 0; continue; }
        if (!at.has(hip)) { at.set(hip, pts.length / 3); pts.push(...pos(i).map(r5)); }
        seg.push(at.get(hip));
      }
      if (seg.length > 1) lines.push(seg);
    }
    return { abbr, name: c.common_name.native, english: c.common_name.english, pts, lines };
  });
  if (missing.size) console.log(`  constellations: ${missing.size} figure stars have no usable distance and are skipped: HIP ${[...missing].join(', ')}`);
  writeOut('names.json', JSON.stringify({ stars }));
  writeOut('constellations.json', JSON.stringify(cons));
  console.log(`  names: ${stars.length} named or designated stars, ${cons.length} constellations`);
  return { stars: n, tiles: tree.tiles, bytes: tree.bytes, named: stars.length };
}
