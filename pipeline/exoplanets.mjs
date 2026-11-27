// Exoplanet host stars from the NASA Exoplanet Archive (Planetary Systems Composite Parameters), as a marker layer:
//   data/exoplanets.json = { hosts: [[name, x, y, z, planets] or [name, x, y, z, planets, alias], ...] }
// in J2000 equatorial parsecs, nearest first. `planets` counts the confirmed planets in the pinned snapshot.
// `alias` is there when the planets carry a different stem from the archive's host name (the archive files
// Kepler-90 under KOI-351, 14 Her's planets under HD 145675), so that a search for either finds the star.
//
// The pin. The archive is a live database with no versioned releases, so the query is made as still as it can be:
// explicit columns, a total order, and only planets announced up to the end of YEAR, a year that has closed.
// The checksum then covers the exact bytes the service returns. It will still break when the archive revises a
// position or distance, renames a host, or files a late planet under an old year; that is the build telling you the
// catalogue moved, not a download fault. To re-pin: delete .cache/<file>, run with --print-sha, paste the checksum.
import { fetchSource, readCsv, writeOut, eq2xyz } from './lib.mjs';

const YEAR = 2025;
export const EXO_SOURCES = {
  exoplanets: {
    title: `NASA Exoplanet Archive, Planetary Systems Composite Parameters (planets announced to ${YEAR}; snapshot of 2026-11-27)`,
    url: `https://exoplanetarchive.ipac.caltech.edu/TAP/sync?query=select+pl_name,hostname,ra,dec,sy_dist+from+pscomppars+where+disc_year<=${YEAR}+order+by+pl_name&format=csv`,
    sha256: 'ba28949b593ec7006c36c758c9fd41bd9ec061f4386d05015daebde34f51011c',
    file: `exoplanet_archive_pscomppars_${YEAR}.csv`,
    licence: 'Public domain (NASA/IPAC, US Government work); acknowledgement requested',
    credit: 'NASA Exoplanet Archive, operated by Caltech under contract with NASA (Exoplanet Exploration Program). DOI 10.26133/NEA13',
    home: 'https://exoplanetarchive.ipac.caltech.edu/',
  },
};

export async function bakeExoplanets(opts) {
  const file = await fetchSource(EXO_SOURCES.exoplanets, opts);
  const hosts = new Map();
  let col, planets = 0;
  await readCsv(file, (f) => {
    if (!col) { col = Object.fromEntries(f.map((k, i) => [k, i])); return; }
    planets++;
    const name = f[col.hostname];
    let h = hosts.get(name);
    if (!h) hosts.set(name, h = { name, ra: +f[col.ra], dec: +f[col.dec], dist: f[col.sy_dist] === '' ? NaN : +f[col.sy_dist], n: 0, alias: new Set() });
    h.n++;
    // "Kepler-90 i" -> "Kepler-90"; candidates-turned-planets keep a ".01" style suffix instead of a letter
    const stem = f[col.pl_name].replace(/( [a-z]|\.\d+)$/, '');
    if (stem !== name && stem.replace(/ [AB]+$/, '') !== name.replace(/ [AB]+$/, '')) h.alias.add(stem);
  });
  if (!col || col.sy_dist === undefined) throw new Error('exoplanet table has no header; the archive returned something else');
  const r = (v) => +v.toPrecision(8);   // distances are known to 4-6 figures; this keeps the direction to 0.01 arcsec
  const out = [];
  let noDist = 0, noDistPlanets = 0;
  for (const h of hosts.values()) {
    if (!(h.dist > 0) || !Number.isFinite(h.ra + h.dec)) { noDist++; noDistPlanets += h.n; continue; }
    const row = [h.name, ...eq2xyz(h.ra, h.dec, h.dist).map(r), h.n];
    if (h.alias.size) row.push([...h.alias].sort().join(', '));
    out.push([h.dist, row]);
  }
  // nearest first; code-unit name order breaks ties, so the file does not depend on the server's collation
  out.sort((a, b) => a[0] - b[0] || (a[1][0] < b[1][0] ? -1 : a[1][0] > b[1][0] ? 1 : 0));
  writeOut('exoplanets.json', JSON.stringify({ hosts: out.map((o) => o[1]) }));
  console.log(`  exoplanets: ${out.length} host stars with ${planets - noDistPlanets} planets; ${noDist} hosts (${noDistPlanets} planets) without a distance dropped`);
  return { hosts: out.length, planets: planets - noDistPlanets, noDistance: noDist, year: YEAR };
}
