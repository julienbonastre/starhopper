// Surface maps for the planets and the Moon: Solar System Scope's 2048 x 1024 textures, which are assembled from
// NASA mission imagery (MESSENGER for Mercury, Viking for Mars, Cassini for Jupiter and Saturn, Voyager for Neptune,
// Lunar Reconnaissance Orbiter for the Moon) and colour-tuned by their authors to match true-colour photographs.
// They are pictures of the real surfaces, not measurements: the gas giants' weather is from the day of the flyby,
// gaps the spacecraft never saw are filled in, and Venus is its cloud tops (painted, after Mariner 10 and Pioneer
// Venus), since its surface cannot be seen. Each is copied byte for byte to data/maps/<body>.jpg.
//
// Plate carree, like the Earth: longitude -180 at the left edge to +180 at the right, zero in the middle, north up.
// The bytes are kept in pipeline/snapshots (fetched from Wikimedia Commons, where each file's page records its
// origin and licence) so the build does not lean on an image host.
import { readFileSync } from 'node:fs';
import { fetchSource, writeOut } from './lib.mjs';
import { jpegSize } from './earth.mjs';

const src = (body, name, dir, sha256, basis) => ({
  title: `Solar System Scope texture: ${body} (2048 x 1024), ${basis}`,
  url: `https://upload.wikimedia.org/wikipedia/commons/${dir}/Solarsystemscope_texture_2k_${name}.jpg`,
  sha256, file: `Solarsystemscope_texture_2k_${name}.jpg`,
  licence: 'CC BY 4.0',
  credit: 'Solar System Scope (INOVE), from NASA mission imagery',
  home: 'https://www.solarsystemscope.com/textures/',
});
export const MAP_SOURCES = {
  mercury: src('Mercury', 'mercury', '9/92', '5a5c80607f643496bac9a631e71957def35ed788895f18b678ac849c2b38e48a', 'from MESSENGER'),
  venus: src('Venus, cloud tops', 'venus_atmosphere', '6/63', '225012ad4911730605c4e189ca2a3bf674fce50cc48aab4102b936b47d6991ac', 'an artist\'s map after spacecraft photographs'),
  mars: src('Mars', 'mars', '4/46', '2d187f3e77a98eaa8cea5f4cc722f633c122ef170b9e94ace6b5fb6cbc3f8e01', 'from the Viking orbiters'),
  jupiter: src('Jupiter', 'jupiter', 'b/be', 'b0f04d005350252636b0e3396fc592548cbd9e9126b269d32d5c6abd4b0e4f2b', 'from Cassini\'s flyby in December 2000'),
  saturn: src('Saturn', 'saturn', 'e/ea', '54a900ca9bf7ab62e70f862852759abdf342e6d6436a95a2fe9ebdb6bcd3bbac', 'from Cassini'),
  uranus: src('Uranus', 'uranus', '9/95', 'd15239d46f82d3ea13d2b260b5b29b2a382f42f2916dae0694d0387b1204a09d', 'after Voyager 2'),
  neptune: src('Neptune', 'neptune', '1/1e', 'cb42ea82709741d28b0af44d8b283cbc6dbd0c521a7f0e1e1e010ade00977df6', 'after Voyager 2'),
  moon: src('Moon', 'moon', '2/26', '2764ba6535ea0481a062846ee033cc7a909dae05b31a8fd13f3e98f3a7fd92bd', 'from the Lunar Reconnaissance Orbiter'),
};

export async function bakeMaps(opts) {
  const out = {};
  for (const [body, s] of Object.entries(MAP_SOURCES)) {
    const buf = readFileSync(await fetchSource(s, opts));
    const { width, height } = jpegSize(buf);
    if (width !== 2 * height) throw new Error(`${body} map is ${width} x ${height}, not a 2:1 equirectangular image`);
    writeOut(`maps/${body}.jpg`, buf);
    out[body] = { width, height, bytes: buf.length };
  }
  console.log(`  maps: ${Object.keys(out).length}, ${Object.values(out).reduce((a, m) => a + m.bytes, 0)} bytes`);
  return out;
}
