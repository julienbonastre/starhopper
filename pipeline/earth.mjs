// The one image in the project: NASA's Blue Marble, for the Earth the flight starts above. Copied byte for byte to
// data/earth.jpg; the browser decodes (and may downscale) it, the pipeline does no image processing.
//
// Plate carree: longitude -180 at the left edge to +180 at the right, Greenwich in the middle column, north up.
// NASA's old 2048-pixel files (land_shallow_topo_2048.jpg on eoimages.gsfc.nasa.gov) went away with that host;
// the smallest equirectangular Blue Marble NASA still serves at a fixed address is this 5400 x 2700 one.
import { readFileSync } from 'node:fs';
import { fetchSource, writeOut } from './lib.mjs';

export const EARTH_SOURCES = {
  earth: {
    title: 'Blue Marble: Next Generation, July 2004, with topography and bathymetry (5400 x 2700)',
    url: 'https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/bmng-topography-bathymetry/july/world.topo.bathy.200407.3x5400x2700.jpg',
    sha256: '4f4240673a3a1b173d61b92ca4b07bac5fd17059ea5f725ba6da5a9c5386b7ba',
    file: 'bmng_topo_bathy_200407_5400x2700.jpg',
    licence: 'Public domain (NASA)',
    credit: 'NASA Earth Observatory: Reto Stockli, Blue Marble Next Generation, from Terra/MODIS data',
    home: 'https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/base-topography-bathymetry/',
  },
};

// Width and height from the JPEG frame header (the first SOFn segment).
export function jpegSize(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('not a JPEG');
  for (let p = 2; p + 9 < buf.length;) {
    if (buf[p] !== 0xff) throw new Error('bad JPEG marker');
    const m = buf[p + 1];
    if (m === 0xff) { p++; continue; }                                   // fill byte
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { width: buf.readUInt16BE(p + 7), height: buf.readUInt16BE(p + 5) };
    if (m === 0xda) break;                                               // image data starts: no frame header before it
    p += 2 + buf.readUInt16BE(p + 2);
  }
  throw new Error('JPEG has no frame header');
}

export async function bakeEarth(opts) {
  const buf = readFileSync(await fetchSource(EARTH_SOURCES.earth, opts));
  const { width, height } = jpegSize(buf);
  if (width !== 2 * height) throw new Error(`Earth map is ${width} x ${height}, not a 2:1 equirectangular image`);
  writeOut('earth.jpg', buf);
  console.log(`  earth: ${width} x ${height}, ${buf.length} bytes`);
  return { width, height, bytes: buf.length };
}
