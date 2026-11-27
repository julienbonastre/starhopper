// Deep-sky objects: the nebulae and star clusters of OpenNGC, placed in 3D.
//   deep.json = { kinds: [...], objects: [[name, label, kind, x, y, z, radius_pc, mag, seed], ...] }
// OpenNGC gives position, type, angular size and magnitude but no distance. Every distance is looked up in a pinned
// catalogue, the most direct measurement first; an object that none of them lists is dropped, never guessed:
//   globular clusters   Harris 1996 (2010 edition)
//   open clusters       Hunt & Reffert 2023 (Gaia DR3), by name, else by position
//   planetary nebulae   Chornay & Walton 2021 (Gaia EDR3 central stars), else Stanghellini & Haywood 2010 (statistical)
//   nebulae, remnants   SIMBAD's collected measurements of the object itself, by name; else, for a remnant, the radio
//                       shell it is part of (Green 2019 for the extent, Ranasinghe & Leahy 2022 for the distance); else,
//                       for a nebula, the cluster embedded in it (Hunt & Reffert) or the molecular cloud it lights up
//                       (Zucker et al. 2020 sightlines)
//   anything left       the galaxy it sits in, when it lies inside one of the Updated Nearby Galaxy Catalog (the
//                       Magellanic Clouds' clusters and nebulae, the HII regions of M 33 and M 101)
import { readFileSync } from 'node:fs';
import { fetchSource, readCsv, readTsv, writeOut, eq2xyz, sexa, DEG } from './lib.mjs';
import { SOURCES } from './sources.mjs';

const VIZ = 'https://vizier.cfa.harvard.edu/viz-bin/asu-tsv?-out.max=unlimited&-source=';
const VIZ_LICENCE = 'VizieR open licence (Etalab 2.0); cite the authors';
// SIMBAD is a live database, so the query is narrowed to what cannot change much: non-stellar objects with an NGC, IC,
// Messier, Sharpless, LBN or Barnard name or a "... Nebula" nickname, distances inside the Local Group, papers before 2025.
const SIMBAD_ADQL = `SELECT i.id AS id, d.dist AS dist, d.unit AS unit, d.method AS method, d.bibcode AS bibcode
FROM mesDistance d JOIN ident i ON i.oidref=d.oidref JOIN basic b ON b.oid=d.oidref
WHERE (i.id LIKE 'NGC %' OR i.id LIKE 'IC %' OR i.id LIKE 'M %' OR i.id LIKE 'SH 2-%' OR i.id LIKE 'LBN %' OR i.id LIKE 'Barnard %' OR i.id LIKE 'NAME % Nebula')
AND b.otype IN ('OpC','GlC','Cl*','As*','PN','HII','SNR','RNe','DNe','GNe','ISM','Cld','MoC','SFR','EmO','sh','bub') AND (d.unit LIKE 'pc%' OR d.unit LIKE 'kpc%') AND d.bibcode < '2025'
ORDER BY id, bibcode, dist, method`.replace(/\n/g, ' ');

export const DEEP_SOURCES = {
  harris: {
    title: 'Catalog of Parameters for Milky Way Globular Clusters, Harris 1996, 2010 edition (VizieR VII/202)',
    url: VIZ + 'VII/202/catalog&-out=ID,Name,RAJ2000,DEJ2000,Rsun',
    sha256: '2d61185d8b5bf66297f1551a11df0721bcca6cec938ca85e285360a5b6aee4c2',
    file: 'harris_gc.tsv', table: true,
    licence: VIZ_LICENCE,
    credit: 'Harris 1996, AJ 112, 1487 (2010 edition), via VizieR (CDS, Strasbourg)',
    home: 'https://cdsarc.cds.unistra.fr/viz-bin/cat/VII/202',
  },
  hunt: {
    title: 'Star clusters in Gaia DR3, Hunt & Reffert 2023 (VizieR J/A+A/673/A114)',
    url: VIZ + 'J/A%2BA/673/A114/clusters&-out=Name,AllNames,RA_ICRS,DE_ICRS,dist50,r50,Type',
    sha256: 'e38d3ccdae385708c68d0dc13b813b1bb66bdf90b96a8784e1bc2367d22dde39',
    file: 'hunt_reffert_clusters.tsv', table: true,
    licence: VIZ_LICENCE,
    credit: 'Hunt and Reffert 2023, A&A 673, A114, from ESA Gaia DR3, via VizieR (CDS, Strasbourg)',
    home: 'https://cdsarc.cds.unistra.fr/viz-bin/cat/J/A+A/673/A114',
  },
  chornay: {
    title: 'Gaia EDR3 planetary nebula central star distances, Chornay & Walton 2021 (VizieR J/A+A/656/A110)',
    url: VIZ + 'J/A%2BA/656/A110/tablea1&-out=PNG,Rel,rcomb',
    sha256: '551ed1e8d167ed45cdd14074ad1da62d8788519a31fc7752119539016684dd63',
    file: 'chornay_pn.tsv', table: true,
    licence: VIZ_LICENCE,
    credit: 'Chornay and Walton 2021, A&A 656, A110, from ESA Gaia EDR3, via VizieR (CDS, Strasbourg)',
    home: 'https://cdsarc.cds.unistra.fr/viz-bin/cat/J/A+A/656/A110',
  },
  stanghellini: {
    title: 'Galactic planetary nebulae: statistical distances, Stanghellini & Haywood 2010 (VizieR J/ApJ/714/1096)',
    url: VIZ + 'J/ApJ/714/1096/table1&-out=PNG,d',
    sha256: '394bc6a3f259eb29c47c9b7deb9db45a6ffe6738a6a34bb3714cbad30d0472b1',
    file: 'stanghellini_pn.tsv', table: true,
    licence: VIZ_LICENCE,
    credit: 'Stanghellini and Haywood 2010, ApJ 714, 1096, via VizieR (CDS, Strasbourg)',
    home: 'https://cdsarc.cds.unistra.fr/viz-bin/cat/J/ApJ/714/1096',
  },
  ranasinghe: {
    title: 'Reliable distances of Galactic supernova remnants, Ranasinghe & Leahy 2022 (VizieR J/ApJ/940/63)',
    url: VIZ + 'J/ApJ/940/63/table1&-out=SNR,l_Distl1,Distl1,l_Dist,Dist',
    sha256: '511af9dca881a22937f2c69bd8325f24d4b83d473baeb3b0b434c0da79f46de9',
    file: 'ranasinghe_snr.tsv', table: true,
    licence: VIZ_LICENCE,
    credit: 'Ranasinghe and Leahy 2022, ApJ 940, 63, via VizieR (CDS, Strasbourg)',
    home: 'https://cdsarc.cds.unistra.fr/viz-bin/cat/J/ApJ/940/63',
  },
  green: {
    title: 'A Catalogue of Galactic Supernova Remnants, Green 2019 (VizieR VII/284): positions and angular sizes',
    url: VIZ + 'VII/284/snrs&-out=SNR,RAJ2000,DEJ2000,MajDiam',
    sha256: 'aa69405febb491ffe7d4e7845c8bebf228726923a4aac0c10994e791890eaf47',
    file: 'green_snr.tsv', table: true,
    licence: VIZ_LICENCE,
    credit: 'Green 2019, J. Astrophys. Astron. 40, 36, via VizieR (CDS, Strasbourg)',
    home: 'https://cdsarc.cds.unistra.fr/viz-bin/cat/VII/284',
  },
  zucker: {
    title: 'Distances to molecular clouds in star-forming regions, Zucker et al. 2020 (VizieR J/A+A/633/A51)',
    url: VIZ + 'J/A%2BA/633/A51/handbook&-out=Name,GLON,GLAT,d50,_RAJ2000,_DEJ2000',
    sha256: '2ad3b7ffbc7051df717e88e129c0a3f8fd01d3150aef9daeb7c4b64776796e75',
    file: 'zucker_clouds.tsv', table: true,
    licence: VIZ_LICENCE,
    credit: 'Zucker et al. 2020, A&A 633, A51, via VizieR (CDS, Strasbourg)',
    home: 'https://cdsarc.cds.unistra.fr/viz-bin/cat/J/A+A/633/A51',
  },
  simbad: {
    title: 'SIMBAD distance measurements of nebulae and clusters with NGC, IC, Messier, Sharpless, LBN or Barnard names',
    url: 'https://simbad.harvard.edu/simbad/sim-tap/sync?request=doQuery&lang=adql&format=tsv&query=' + encodeURIComponent(SIMBAD_ADQL),
    sha256: 'd0cca4c64473a9e4ed3132b00d1b5235a1ec48626fdc96c9cfdee6c0459ba798',
    file: 'simbad_deep_distances.tsv', table: true,
    licence: 'SIMBAD open licence (Etalab 2.0 / ODbL); acknowledge SIMBAD',
    credit: 'SIMBAD astronomical database, CDS, Strasbourg (Wenger et al. 2000, A&AS 143, 9), with the papers it cites for each distance',
    home: 'https://simbad.cds.unistra.fr/simbad/',
  },
};

export const KINDS = ['open cluster', 'globular cluster', 'cluster with nebula', 'planetary nebula', 'HII region', 'emission nebula', 'reflection nebula', 'nebula', 'dark nebula', 'supernova remnant'];
const TYPE = { OCl: 0, GCl: 1, 'Cl+N': 2, PN: 3, HII: 4, EmN: 5, RfN: 6, Neb: 7, DrkN: 8, SNR: 9 };
// radius in parsecs: the smallest an object of each kind is drawn, and what it gets when the catalogue has no size
const FLOOR = [0.5, 1, 0.5, 0.02, 0.2, 0.2, 0.1, 0.2, 0.2, 0.5];
const TYPICAL = [2, 10, 4, 0.15, 5, 5, 1.5, 3, 3, 8];

const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };
// One spelling per designation, whatever the catalogue: "NGC0869", "NGC  869" and "NGC_869" are all NGC869
const LONG = { MEL: 'MELOTTE', CL: 'COLLINDER', CR: 'COLLINDER', H: 'HARVARD', TR: 'TRUMPLER', B: 'BARNARD', PAL: 'PALOMAR', TER: 'TERZAN' };
const key = (s) => {
  const m = /^([A-Za-z]+)[ _]*0*(\d.*)$/.exec(s.trim());
  const squash = (t) => t.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return m ? (LONG[m[1].toUpperCase()] || m[1].toUpperCase()) + squash(m[2]) : squash(s);
};
const unit = (ra, dec) => eq2xyz(ra, dec, 1);
const sepDeg = (u, v) => Math.acos(Math.min(1, u[0] * v[0] + u[1] * v[1] + u[2] * v[2])) / DEG;
// the closest entry within tol degrees, or within the entry's own radius c.r (degrees) when it has one and it is larger
const nearest = (list, u, tol) => { let best = null, bd = Infinity; for (const c of list) { const s = sepDeg(u, c.u); if (s < Math.max(tol, c.r || 0) && s < bd) { bd = s; best = c; } } return best; };
const median = (a) => { a.sort((p, q) => p - q); const h = a.length >> 1; return a.length & 1 ? a[h] : (a[h - 1] + a[h]) / 2; };

export async function bakeDeep(opts = {}) {
  const F = {};
  for (const [k, s] of Object.entries(DEEP_SOURCES)) F[k] = await fetchSource(s, opts);
  const ngcF = await fetchSource(SOURCES.openngc, opts), addF = await fetchSource(SOURCES.openngcAddendum, opts);

  // ---- the distance catalogues (everything in parsecs)
  const harris = [], harrisBy = new Map();
  readTsv(F.harris, (f) => {
    const d = +f[4] * 1000; if (!(d > 0)) return;
    const g = { d, u: unit(sexa(f[2]) * 15, sexa(f[3])) };
    harris.push(g); harrisBy.set(key(f[0]), g);
  });
  // a cluster's own name outranks an alias: the catalogue lists "Collinder 50" under the Hyades and under a second group
  const hunt = [], huntBy = new Map(), huntAlias = new Map();
  readTsv(F.hunt, (f) => {
    const d = +f[4]; if (!(d > 0)) return;
    const c = { d, u: unit(+f[2], +f[3]), r50: +f[5] || 0, moving: f[6].trim() === 'm' };
    hunt.push(c); huntBy.set(key(f[0]), c);
    for (const n of f[1].split(',')) { const k = key(n); if (k && !huntAlias.has(k)) huntAlias.set(k, c); }
  });
  // For "which cluster is this nebula part of": not the moving groups, which cover whole constellations, and a cluster's
  // own extent (the radius holding half its members) only counts while it is a compact patch of sky
  const compact = hunt.filter((c) => !c.moving), haloed = compact.filter((c) => c.r50 <= 1.5).map((c) => ({ ...c, r: c.r50 }));

  const pn = new Map(), pnStat = new Map();
  readTsv(F.chornay, (f) => { const d = +f[2]; if (d > 0 && +f[1] >= 0.8) pn.set(f[0].trim(), d); });   // reliability of the central-star match
  readTsv(F.stanghellini, (f) => { const d = +f[1] * 1000; if (d > 0) pnStat.set(f[0].trim(), d); });
  const snrKey = (s) => { const m = /G(\d+\.\d+)([+-])(\d+\.\d+)/.exec(s); return m ? `${+m[1]}${m[2]}${+m[3]}` : ''; };   // G074.0-08.5 = G74.0-8.5
  const snrDist = new Map(), snr = [];
  readTsv(F.ranasinghe, (f) => {
    // the authors' revised distance, else the literature one; limits ("<", ">", "~") are not measurements
    const d = (f[4].trim() && !f[3].trim() ? +f[4] : f[2].trim() && !f[1].trim() ? +f[2] : 0) * 1000;
    if (d > 0) snrDist.set(snrKey(f[0]), d);
  });
  readTsv(F.green, (f) => { const d = snrDist.get(snrKey(f[0])); if (d) snr.push({ d, u: unit(sexa(f[1]) * 15, sexa(f[2])), r: +f[3] / 2 / 60 + 0.1 }); });
  // host galaxies. Open clusters and nebulae need a gas-rich host (T > 0); a globular can belong to any
  const hosts = [];
  readTsv(await fetchSource(SOURCES.ungc, opts), (f) => {
    const d = +f[6] * 1e6, a26 = +f[3]; if (!(d > 0) || !(a26 > 0) || f[0].trim() === 'Milky Way') return;
    hosts.push({ d, u: unit(sexa(f[1]) * 15, sexa(f[2])), r: a26 / 2 / 60, late: f[5].trim() !== '' && +f[5] > 0 });
  });
  const lateHosts = hosts.filter((h) => h.late);
  const clouds = [];
  readTsv(F.zucker, (f) => { const d = +f[3]; if (d > 0) clouds.push({ d, u: unit(+f[4], +f[5]) }); });
  // SIMBAD: every measurement on file for an object. Parallaxes are trusted over the rest; the median settles disagreements.
  const simbad = new Map();
  for (const l of readFileSync(F.simbad, 'utf8').split('\n').slice(1)) {
    if (!l) continue;
    const f = l.split('\t').map((s) => s.replace(/"/g, '').trim()), d = +f[1] * (f[2] === 'kpc' ? 1000 : 1);
    if (!(d > 0)) continue;
    const k = key(f[0]);
    if (!simbad.has(k)) simbad.set(k, { plx: [], all: [] });
    const e = simbad.get(k); e.all.push(d); if (f[3] === 'paral' || f[3] === 'plx') e.plx.push(d);
  }
  const fromSimbad = (keys) => { for (const k of keys) { const e = simbad.get(k); if (e) return median(e.plx.length ? e.plx : e.all); } return 0; };

  // ---- OpenNGC
  const rows = [];
  for (const file of [ngcF, addF]) {
    let col;
    await readCsv(file, (f) => {
      if (!col) { col = Object.fromEntries(f.map((k, i) => [k, i])); return; }
      const kind = TYPE[f[col.Type]];
      if (kind === undefined || !f[col.RA]) return;
      const id = f[col.Name], idents = f[col.Identifiers] ? f[col.Identifiers].split(',') : [];
      const commons = f[col['Common names']] ? f[col['Common names']].split(',') : [], m = f[col.M] ? +f[col.M] : 0;
      const cat = id.replace(/^([A-Za-z]+)0*(\d)/, '$1 $2');
      rows.push({
        kind, id, m, cat, common: commons[0] || '', order: rows.length,
        ra: sexa(f[col.RA]) * 15, dec: sexa(f[col.Dec]), maj: +f[col.MajAx] || 0,
        mag: f[col['V-Mag']] ? +f[col['V-Mag']] : f[col['B-Mag']] ? +f[col['B-Mag']] : null,
        png: (/PN G(\d{3}\.\d[+-]\d{2}\.\d)/.exec(f[col.Identifiers]) || [])[1],
        keys: [key(id), ...(m ? ['M' + m] : []), ...idents.map(key), ...commons.map((c) => key('NAME ' + c))],
      });
    }, { sep: ';' });
  }
  // Messier objects first, so that they keep a nickname two entries share (M 16 and IC 4703 are both the Eagle Nebula)
  rows.sort((a, b) => (a.m || 1e3) - (b.m || 1e3) || a.order - b.order);

  const objects = [], taken = new Set(), kept = KINDS.map(() => 0), dropped = KINDS.map(() => 0), by = {};
  let far = 0;
  for (const o of rows) {
    const u = unit(o.ra, o.dec), r = o.maj / 2 / 60, k = o.kind;   // r: catalogued radius in degrees
    const named = () => { for (const m of [huntBy, huntAlias]) for (const n of o.keys) if (m.has(n)) return m.get(n); };
    let d = 0, src = '', hit;
    const take = (dist, s) => { if (dist > 0) { d = dist; src = s; } return d > 0; };
    const host = () => (hit = nearest(k === 1 ? hosts : lateHosts, u, 0)) && take(hit.d, 'host galaxy');
    if (k === 1) {
      (hit = harrisBy.get(o.keys[0]) || nearest(harris, u, 0.05)) && take(hit.d, 'harris')
        || (hit = named()) && take(hit.d, 'hunt') || take(fromSimbad(o.keys), 'simbad');
    } else if (k === 3) {
      take(pn.get(o.png), 'chornay') || take(pnStat.get(o.png), 'stanghellini') || take(fromSimbad(o.keys), 'simbad');
    } else if (k === 0) {
      (hit = named() || nearest(hunt, u, Math.max(0.05, Math.min(0.2, r / 2)))) && take(hit.d, 'hunt') || take(fromSimbad(o.keys), 'simbad');
    } else {
      // nebulae and remnants: a measurement of the object itself; else of the shell it is an arc of (the Veil's pieces all
      // lie inside the Cygnus Loop); else the galaxy it is in; else the cluster inside it, the cloud it belongs to, or
      // the cluster it surrounds (the Merope Nebula in the Pleiades)
      (hit = named()) && take(hit.d, 'hunt') || take(fromSimbad(o.keys), 'simbad')
        || k === 9 && (hit = nearest(snr, u, 0)) && take(hit.d, 'ranasinghe')
        || host()
        || k !== 9 && ((hit = nearest(compact, u, Math.max(0.1, Math.min(1, r)))) && take(hit.d, 'hunt (embedded cluster)')
          || (hit = nearest(clouds, u, 1.5)) && take(hit.d, 'zucker')
          || (hit = nearest(haloed, u, 0)) && take(hit.d, 'hunt (surrounding cluster)'));
    }
    if (!d) host();
    if (!d) { dropped[k]++; continue; }
    kept[k]++; by[src] = (by[src] || 0) + 1; if (d > 30000) far++;
    let name = [o.common, o.m ? 'M ' + o.m : '', o.cat].find((n) => n && !taken.has(n)) || `${o.cat} (${o.id})`;
    taken.add(name);
    const radius = o.maj ? Math.max(FLOOR[k], r * DEG * d) : TYPICAL[k];
    objects.push([name, name === o.common || name === 'M ' + o.m ? 1 : 0, k, ...eq2xyz(o.ra, o.dec, d).map((v) => Math.round(v * 100) / 100), +radius.toPrecision(3), o.mag, hash(name)]);
  }
  writeOut('deep.json', JSON.stringify({ kinds: KINDS, objects }));
  const perKind = Object.fromEntries(KINDS.map((n, i) => [n, { kept: kept[i], dropped: dropped[i] }]));
  console.log(`  deep sky: ${objects.length} placed, ${rows.length - objects.length} without a distance skipped (${KINDS.map((n, i) => `${n} ${kept[i]}/${kept[i] + dropped[i]}`).join(', ')})`);
  return { objects: objects.length, noDistance: rows.length - objects.length, beyond30kpc: far, kinds: perKind, distanceFrom: by };
}
