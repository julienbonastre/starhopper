import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CACHE = path.join(ROOT, '.cache');
export const OUT = path.join(ROOT, 'data');

export const sha256File = async (file) => {
  const h = createHash('sha256');
  await pipeline(createReadStream(file), h);
  return h.digest('hex');
};

// Download a pinned source into .cache (once) and verify its checksum. Returns the local path.
export async function fetchSource(src, { printSha = false } = {}) {
  mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, src.file);
  // Live databases have no versioned release to pin: the bytes fetched from src.url on the stated date are kept in
  // pipeline/snapshots and used in place of a fresh query. To refresh one, delete it there and in .cache, run with
  // --print-sha, then copy the new .cache file back and update the checksum.
  const kept = path.join(ROOT, 'pipeline', 'snapshots', src.file);
  if (!existsSync(file) && existsSync(kept)) copyFileSync(kept, file);
  if (!existsSync(file)) {
    console.log(`  fetching ${src.url}`);
    let err;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await fetch(src.url, { redirect: 'follow' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (src.table) {
          // a VizieR query: keep the data lines only, so the checksum does not depend on the request date header
          const text = (await res.text()).split('\n').filter((l) => l && l[0] !== '#').join('\n') + '\n';
          if (text.length < 200) throw new Error('empty table');
          writeFileSync(file + '.part', text);
        } else await pipeline(Readable.fromWeb(res.body), createWriteStream(file + '.part'));
        renameSync(file + '.part', file);
        err = null;
        break;
      } catch (e) { err = e; await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt)); }
    }
    if (err) throw new Error(`could not fetch ${src.url}: ${err.message}`);
  }
  const sum = await sha256File(file);
  if (printSha) console.log(`  ${src.file} sha256 ${sum}`);
  if (src.sha256 && sum !== src.sha256) throw new Error(`checksum mismatch for ${src.file}: expected ${src.sha256}, got ${sum}. Delete .cache/${src.file} if the download was cut off.`);
  return file;
}

// Streaming CSV reader (RFC 4180 quotes). Calls row(fields[]) for every record; fields[] is reused between calls.
export async function readCsv(file, row, { sep = ',', gz = file.endsWith('.gz') } = {}) {
  let stream = createReadStream(file);
  if (gz) stream = stream.pipe(createGunzip());
  const dec = new TextDecoder();
  const sepC = sep.charCodeAt(0);
  let rest = '';
  const fields = [];
  const emit = (line) => {
    fields.length = 0;
    if (line.indexOf('"') < 0) { let a = 0; for (let i = 0; i <= line.length; i++) if (i === line.length || line.charCodeAt(i) === sepC) { fields.push(line.slice(a, i)); a = i + 1; } }
    else {
      let cur = '', q = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
        else if (c === '"') q = true;
        else if (c === sep) { fields.push(cur); cur = ''; }
        else cur += c;
      }
      fields.push(cur);
    }
    row(fields);
  };
  for await (const chunk of stream) {
    const text = rest + dec.decode(chunk, { stream: true });
    let a = 0, b;
    while ((b = text.indexOf('\n', a)) >= 0) { const l = text.charCodeAt(b - 1) === 13 ? text.slice(a, b - 1) : text.slice(a, b); if (l) emit(l); a = b + 1; }
    rest = text.slice(a);
  }
  if (rest) emit(rest);
}

export const writeOut = (rel, data) => {
  const f = path.join(OUT, rel);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, data);
  return f;
};

// J2000 equatorial (ra hours or degrees, dec degrees, distance) to cartesian, same frame as AT-HYG x0,y0,z0.
export const DEG = Math.PI / 180;
export const eq2xyz = (raDeg, decDeg, d) => {
  const a = raDeg * DEG, b = decDeg * DEG, c = Math.cos(b);
  return [d * c * Math.cos(a), d * c * Math.sin(a), d * Math.sin(b)];
};

// Read a tab-separated VizieR table saved by fetchSource: row(fields[]) for each data line (header lines skipped).
export function readTsv(file, row) {
  const lines = readFileSync(file, 'utf8').split('\n');
  let seen = 0;
  for (const l of lines) { if (!l) continue; if (seen < 3) { seen++; continue; } row(l.split('\t')); }
}
export const sexa = (s) => { const m = s.trim().split(/[: ]+/).map(Number), neg = s.trim()[0] === '-'; return (neg ? -1 : 1) * (Math.abs(m[0]) + (m[1] || 0) / 60 + (m[2] || 0) / 3600); };
