// Galaxies. Two products:
//   galaxies/      point tiles for every GLADE galaxy with a measured distance (same record format as the stars,
//                  on a grid of +-GHALF parsecs), minus the ones that get a detailed record below
//   galaxies.bin   detailed records for the OpenNGC galaxies: position, luminosity, physical size, orientation and
//                  Hubble type, which the renderer turns into a procedural spiral, elliptical or irregular.
//                  Record 0 is the Milky Way itself (a documented model, not a catalogue entry).
//   record = gx, gy, gz, packed (uint32) + radius_pc, nx, ny, nz, spheroid flattening (float32) + seed (uint32) = 40 bytes
//   packed = absmag16 << 16 | type8 << 8 | flags8      type: 0 E, 1 S0, 2 Sa .. 8 Sd/Sm, 9 Irr; +16 barred, +32 weakly barred
import { fetchSource, readCsv, readTsv, writeOut, eq2xyz, sexa, DEG } from './lib.mjs';
import { SOURCES } from './sources.mjs';
import { bakeTree } from './octree.mjs';

export const GHALF = 2 ** 29;                 // parsecs (about 537 Mpc)
export const GSTEP = (2 * GHALF) / 2 ** 31;   // 0.5 pc per grid unit
const H0 = 70;                                // km/s/Mpc, only for galaxies with no better distance
// The Milky Way as seen from outside. Centre: Sgr A* (GRAVITY 2019: 8178 pc). Pole: IAU north galactic pole.
// Size and luminosity: D25 = 26.8 kpc (Goodwin et al. 1998), M_B = -20.3; type SBbc.
const MW = { centre: eq2xyz(266.40499, -28.93617, 8178), pole: eq2xyz(192.85948, 27.12825, 1), radius: 13400, absmag: -20.3, type: 5 + 16 };

const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };
function hubble(t) {
  if (!t) return 1;
  let bar = 0, s = t;
  if (/^SB/.test(s)) { bar = 16; s = 'S' + s.slice(2); } else if (/^SAB/.test(s)) { bar = 32; s = 'S' + s.slice(3); } else if (/^I(B|AB)/.test(s)) { bar = 16; s = 'I'; }
  if (/^E-S0/.test(s) || /^S0/.test(s)) return 1 + bar;
  if (s[0] === 'E') return 0;
  if (s[0] === 'I') return 9 + bar;
  const m = { a: 2, ab: 3, b: 4, bc: 5, c: 6, cd: 7, d: 8, m: 8 }[s.slice(1)];
  return (m ?? 4) + bar;
}

export async function bakeGalaxies(opts) {
  const [gladeF, cfF, ngcF, addF, ungcF] = [await fetchSource(SOURCES.glade, opts), await fetchSource(SOURCES.cosmicflows, opts), await fetchSource(SOURCES.openngc, opts), await fetchSource(SOURCES.openngcAddendum, opts), await fetchSource(SOURCES.ungc, opts)];
  // Local Volume galaxies, matched to OpenNGC by position (the catalogue has no PGC numbers)
  const ungc = [], cell = new Map();
  readTsv(ungcF, (f) => {
    const d = +f[6]; if (!(d > 0) || f[0].trim() === 'Milky Way') return;
    const g = { name: f[0].trim(), ra: sexa(f[1]) * 15, dec: sexa(f[2]), a26: +f[3] || 0, B: f[4].trim() ? +f[4] : NaN, T: f[5].trim() ? +f[5] : 10, d, inc: f[7].trim() ? +f[7] : NaN, hit: false };
    ungc.push(g);
    const k = Math.round(g.ra * 4) + ',' + Math.round(g.dec * 4);
    if (!cell.has(k)) cell.set(k, []); cell.get(k).push(g);
  });
  const nearUngc = (ra, dec, tol) => {
    let best = null, bd = tol;
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const g of cell.get((Math.round(ra * 4) + i) + ',' + (Math.round(dec * 4) + j)) || []) {
      const sep = Math.hypot((g.ra - ra) * Math.cos(dec * DEG), g.dec - dec);
      if (sep < bd) { bd = sep; best = g; }
    }
    return best;
  };
  const cf = new Map();
  readTsv(cfF, (f) => { const pgc = +f[0], d = +f[1]; if (pgc && d > 0) cf.set(pgc, d); });
  const gl = [], glByPgc = new Map();
  readTsv(gladeF, (f) => {
    const d = +f[3]; if (!(d > 0) || f[7].trim() !== 'G') return;   // G: galaxies only (the list also holds globular clusters and quasars)
    const g = { pgc: +f[0] || 0, ra: +f[1], dec: +f[2], d, B: f[4].trim() ? +f[4] : NaN, K: f[5].trim() ? +f[5] : NaN };
    gl.push(g); if (g.pgc) glByPgc.set(g.pgc, g);
  });

  // ---- detailed galaxies from OpenNGC
  const det = [], names = [], used = new Set();
  let noDist = 0, fromUngc = 0, fromCf = 0, fromGlade = 0, fromFlow = 0;
  const push = (name, label, x, y, z, absmag, type, radius, n, q) => {
    det.push({ x, y, z, absmag, type, radius, n, q, seed: hash(name) }); names.push([name, label ? 1 : 0]);
  };
  push('Milky Way', true, ...MW.centre, MW.absmag, MW.type, MW.radius, MW.pole, 0.6);
  for (const file of [ngcF, addF]) {
    let col;
    await readCsv(file, (f) => {
      if (!col) { col = Object.fromEntries(f.map((k, i) => [k, i])); return; }
      if (f[col.Type] !== 'G') return;
      const ra = sexa(f[col.RA]) * 15, dec = sexa(f[col.Dec]);
      const pgc = +(/PGC (\d+)/.exec(f[col.Identifiers]) || [])[1] || 0;
      const v = +f[col.RadVel];
      let dMpc;
      const lv = nearUngc(ra, dec, Math.max(0.03, (+f[col.MajAx] || 1) / 60 / 4));
      if (lv) { dMpc = lv.d; lv.hit = true; fromUngc++; }
      else if (cf.has(pgc)) { dMpc = cf.get(pgc); fromCf++; }
      else if (glByPgc.has(pgc)) { dMpc = glByPgc.get(pgc).d; fromGlade++; }
      else if (v > 500) { dMpc = v / H0; fromFlow++; }
      else { noDist++; return; }
      const d = dMpc * 1e6;
      if (d >= GHALF * 0.98) return;
      if (pgc) used.add(pgc);
      const B = f[col['B-Mag']] ? +f[col['B-Mag']] : f[col['V-Mag']] ? +f[col['V-Mag']] + 0.7 : NaN;
      const g = glByPgc.get(pgc);
      const app = B === B ? B : g && g.B === g.B ? g.B : g && g.K === g.K ? g.K + 3.7 : 15;
      const absmag = app - 5 * Math.log10(d / 10);
      const maj = +f[col.MajAx] || 0.5, min = +f[col.MinAx] || maj, q = Math.max(0.1, Math.min(1, min / maj));
      const radius = Math.max(300, (maj / 2 / 60) * DEG * d);
      // orientation: inclination from the axis ratio (intrinsic thickness 0.2), major axis at PosAng east of north.
      // Which side is nearer and which way the arms wind are unknown: both are picked from a hash of the name.
      const id = f[col.Name], h = hash(id);
      // discs: intrinsic thickness 0.2. Ellipticals: an oblate spheroid a little flatter than it appears (c = 0.85 q),
      // tilted so that its outline matches the catalogued axis ratio; c is stored in place of q.
      const type = hubble(f[col.Hubble]), c0 = type === 0 ? 0.85 * q : 0.2;
      const cosi = Math.sqrt(Math.max(0, (q * q - c0 * c0) / (1 - c0 * c0))), sini = Math.sqrt(1 - cosi * cosi);
      const pa = (f[col.PosAng] !== '' ? +f[col.PosAng] : (h % 180)) * DEG;
      const a = ra * DEG, b = dec * DEG;
      const L = [Math.cos(b) * Math.cos(a), Math.cos(b) * Math.sin(a), Math.sin(b)];
      const N = [-Math.sin(b) * Math.cos(a), -Math.sin(b) * Math.sin(a), Math.cos(b)], E = [-Math.sin(a), Math.cos(a), 0];
      const minor = [0, 1, 2].map((k) => -Math.sin(pa) * N[k] + Math.cos(pa) * E[k]);
      const sgn = h & 1 ? 1 : -1;
      const n = [0, 1, 2].map((k) => -L[k] * cosi + minor[k] * sini * sgn);
      const m = f[col.M], common = f[col['Common names']].split(',')[0];
      const cat = /^NGC/.test(id) ? 'NGC ' + +id.slice(3, 7) + id.slice(7) : /^IC/.test(id) ? 'IC ' + +id.slice(2, 6) + id.slice(6) : id;
      const name = common || (m ? 'M ' + +m : cat);
      push(name, !!(common || m), ...eq2xyz(ra, dec, d), absmag, type, radius, n, type === 0 ? c0 : 0.6);
    }, { sep: ';' });
  }
  // Local Volume galaxies OpenNGC does not list (mostly dwarfs): type from the T code, size from the Holmberg diameter
  let extra = 0;
  for (const g of ungc) {
    if (g.hit || !(g.B === g.B)) continue;
    const d = g.d * 1e6, h = hash(g.name), a = g.ra * DEG, b = g.dec * DEG;
    const cosi = g.inc === g.inc ? Math.cos(g.inc * DEG) : 0.7, sini = Math.sqrt(1 - cosi * cosi), pa = (h % 180) * DEG;
    const L = [Math.cos(b) * Math.cos(a), Math.cos(b) * Math.sin(a), Math.sin(b)];
    const N = [-Math.sin(b) * Math.cos(a), -Math.sin(b) * Math.sin(a), Math.cos(b)], E = [-Math.sin(a), Math.cos(a), 0];
    const minor = [0, 1, 2].map((k) => -Math.sin(pa) * N[k] + Math.cos(pa) * E[k]);
    const n = [0, 1, 2].map((k) => -L[k] * cosi + minor[k] * sini * (h & 1 ? 1 : -1));
    const type = g.T <= -1 ? 0 : g.T <= 0 ? 1 : g.T >= 9 ? 9 : Math.min(8, Math.max(2, Math.round(g.T) + 1));
    push(g.name, d < 1.4e6, ...eq2xyz(g.ra, g.dec, d), g.B - 5 * Math.log10(d / 10), type, Math.max(150, (g.a26 / 2 / 60) * DEG * d), n, 0.6);
    extra++;
  }
  const rec = new ArrayBuffer(det.length * 40), u = new Uint32Array(rec), fl = new Float32Array(rec);
  det.forEach((g, i) => {
    const o = i * 10;
    u[o] = Math.round((g.x + GHALF) / GSTEP); u[o + 1] = Math.round((g.y + GHALF) / GSTEP); u[o + 2] = Math.round((g.z + GHALF) / GSTEP);
    u[o + 3] = ((Math.max(0, Math.min(65535, Math.round((g.absmag + 40) * 1000))) << 16) | (g.type << 8)) >>> 0;
    fl[o + 4] = g.radius; fl[o + 5] = g.n[0]; fl[o + 6] = g.n[1]; fl[o + 7] = g.n[2]; fl[o + 8] = g.q; u[o + 9] = g.seed;
  });
  writeOut('galaxies.bin', Buffer.from(rec));
  writeOut('galaxies.json', JSON.stringify({ half: GHALF, step: GSTEP, count: det.length, names }));
  console.log(`  galaxies: ${det.length} detailed (distance from the Nearby Galaxy Catalog ${fromUngc} + ${extra} dwarfs of its own, Cosmicflows-3 ${fromCf}, GLADE ${fromGlade}, Hubble flow ${fromFlow}; ${noDist} without one skipped)`);

  // ---- point layer: the rest of GLADE
  const n0 = gl.length;
  const gx = new Int32Array(n0), gy = new Int32Array(n0), gz = new Int32Array(n0), pk = new Uint32Array(n0), am = new Float32Array(n0);
  let n = 0, noMag = 0;
  for (const g of gl) {
    if (g.pgc && used.has(g.pgc)) continue;
    const d = g.d * 1e6;
    if (d >= GHALF * 0.98) continue;
    // no photometry at all: the position is measured, so keep it, as a faint dwarf (M_B = -17)
    const app = g.B === g.B ? g.B : g.K === g.K ? g.K + 3.7 : NaN;
    if (!(app === app)) noMag++;
    const absmag = app === app ? app - 5 * Math.log10(d / 10) : -17;
    const bk = g.B === g.B && g.K === g.K ? g.B - g.K : 3.4;
    const ci = Math.max(0.3, Math.min(1.1, 0.35 + (bk - 2.4) * 0.3));       // blue star-forming .. red and old
    const [x, y, z] = eq2xyz(g.ra, g.dec, d);
    gx[n] = Math.round((x + GHALF) / GSTEP); gy[n] = Math.round((y + GHALF) / GSTEP); gz[n] = Math.round((z + GHALF) / GSTEP);
    am[n] = absmag;
    pk[n] = ((Math.max(0, Math.min(65535, Math.round((absmag + 40) * 1000))) << 16) | (Math.round((ci + 0.5) * 80) << 8)) >>> 0;
    n++;
  }
  if (noMag) console.log(`  galaxies: ${noMag} GLADE entries have no magnitude and are placed as faint dwarfs`);
  const tree = bakeTree('galaxies', { half: GHALF, step: GSTEP, n, gx, gy, gz, pk, am });
  return { detailed: det.length, points: n, tiles: tree.tiles, bytes: tree.bytes };
}
