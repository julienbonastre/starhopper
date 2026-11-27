// What is known about a target, for the info card. Two parts:
//  - facts: worked out from the catalogue entry itself (kind, distance, size, light), plus a few fixed figures for
//    the Sun's planets and the Moon (NASA planetary fact sheets: https://nssdc.gsfc.nasa.gov/planetary/factsheet/);
//  - a short summary and picture from Wikipedia, fetched when the card is opened and credited there. Nothing from
//    Wikipedia is stored with the site, and no request is made until the card is asked for.
const LY = 3.26156, AU = 206264.806, KM = 3.0856775814913673e13;
const num = (x, d = 0) => x.toLocaleString('en', { maximumFractionDigits: d });
const sig = (x) => (x >= 100 ? num(x) : x >= 10 ? num(x, 1) : x >= 0.1 ? num(x, 2) : x.toPrecision(2));
const dist = (pc) => (pc * AU < 0.01 ? num(pc * KM) + ' km' : pc * AU < 2000 ? sig(pc * AU) + ' AU' : pc * LY < 1e3 ? sig(pc * LY) + ' light years' : pc * LY < 1e6 ? sig(pc * LY / 1e3) + ' thousand light years' : pc * LY < 1e9 ? sig(pc * LY / 1e6) + ' million light years' : sig(pc * LY / 1e9) + ' billion light years');
const suns = (absmag) => { const l = Math.pow(10, 0.4 * (4.83 - absmag)); return l >= 1e9 ? sig(l / 1e9) + ' billion Suns' : l >= 1e6 ? sig(l / 1e6) + ' million Suns' : l >= 1000 ? num(l) + ' Suns' : sig(l) + (l === 1 ? ' Sun' : ' Suns'); };

// kind, radius in Earths, day (hours; negative: turns backwards), year, moons, a line
const BODY = {
  Mercury: ['Rocky planet', 0.383, 1407.6, '88 days', 'none', 'The smallest planet and the closest to the Sun, with almost no air: 430 °C by day, −180 °C by night.'],
  Venus: ['Rocky planet', 0.949, -5832.5, '225 days', 'none', 'Nearly the Earth’s size, under a crushing carbon dioxide atmosphere: the hottest surface of any planet. It turns backwards, and its day is longer than its year. The map shows its cloud tops.'],
  Earth: ['Rocky planet', 1, 23.93, '365.25 days', 'one', 'Home. The only world known to have liquid water on its surface and life.'],
  Mars: ['Rocky planet', 0.532, 24.62, '687 days', 'two, Phobos and Deimos', 'A cold desert with a thin atmosphere, polar caps of ice, the tallest volcano and the longest canyon known.'],
  Jupiter: ['Gas giant', 10.97, 9.93, '11.9 years', 'more than 90 known', 'The largest planet, more than twice the mass of all the others together. The Great Red Spot is a storm wider than the Earth.'],
  Saturn: ['Gas giant', 9.14, 10.66, '29.4 years', 'more than 270 known', 'Less dense than water, and circled by rings of ice a few tens of metres thick but 270,000 km across.'],
  Uranus: ['Ice giant', 3.98, -17.24, '84 years', 'more than 25 known', 'Tipped on its side, so that each pole has 42 years of daylight and then 42 of night.'],
  Neptune: ['Ice giant', 3.86, 16.11, '165 years', '16 known', 'The farthest planet, found in 1846 from its pull on Uranus before anyone had seen it. Its winds are the fastest known.'],
  Moon: ['Moon of the Earth', 0.2727, 655.7, '27.3 days around the Earth', '', 'It always keeps the same face to the Earth. Twelve people walked on it between 1969 and 1972.'],
};
const KIND = ['Star', 'Galaxy', '', 'Nebula or star cluster'];

// row: [key, name, x, y, z, stop, absmag, kind, radius] (parsecs; the Sun is the origin)
export function facts(row, camDist, earthDist) {
  const [, name, x, y, z, , absmag, kind, radius] = row, out = [], fromSun = Math.hypot(x, y, z);
  const b = kind === 2 ? BODY[name] : null;
  out.push(['What', b ? b[0] : /planets?$/.test(name) ? 'Star with known planets' : KIND[kind]]);
  out.push(['From here', dist(camDist)]);
  if (b) {
    if (name !== 'Earth') out.push(['From the Earth', dist(earthDist)]);
    out.push(['From the Sun', dist(fromSun)]);
    out.push(['Size', num(radius * KM * 2) + ' km across' + (name === 'Earth' ? '' : ' (' + sig(b[1]) + ' × the Earth)')]);
    const h = Math.abs(b[2]);
    out.push(['Turns once in', (h < 48 ? sig(h) + ' hours' : sig(h / 24) + ' days') + (b[2] < 0 ? ', backwards' : '')]);
    out.push([name === 'Moon' ? 'Orbit' : 'Year', b[3]]);
    if (b[4]) out.push(['Moons', b[4]]);
    return { facts: out, line: b[5] };
  }
  out.push(['From the Earth', dist(fromSun)]);
  if (kind === 0) {
    if (absmag < 25) {
      out.push(['Light', suns(absmag)]);
      const m = absmag + 5 * Math.log10(Math.max(fromSun, 1e-9) / 10);
      out.push(['From the Earth’s sky', 'magnitude ' + m.toFixed(1) + (m < 6.5 ? ' (visible to the eye)' : m < 10 ? ' (binoculars)' : ' (a telescope)')]);
    }
    const pl = /, (\d+) planets?$/.exec(name);
    if (pl) out.push(['Known planets', pl[1]]);
  } else {
    if (radius > 0) out.push(['Size', dist(radius * 2) + ' across']);
    if (kind === 1 && absmag > -30 && absmag < 0) out.push(['Light', suns(absmag)]);
  }
  return { facts: out, line: '' };
}

// The Wikipedia article a catalogue name most likely has
function title(row) {
  let n = row[1].replace(/, \d+ planets?$/, '');
  if (row[7] === 2) return n === 'Mercury' ? 'Mercury (planet)' : n;
  n = n.replace(/^M (\d+)$/, 'Messier $1');
  return n === 'Sol' ? 'Sun' : n;
}
const SKY = /\b(star|stars|galaxy|galaxies|nebula|cluster|planet|moon|constellation|supernova|dwarf|giant|pulsar|binary|astronom|asterism|quasar|black hole)/i;
const cache = new Map();
// A short summary and a picture, or null when Wikipedia has no page that is plainly about this object.
export function wiki(row) {
  const t = title(row);
  if (!cache.has(t)) cache.set(t, fetch('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(t.replace(/ /g, '_')) + '?redirect=true')
    .then((r) => (r.ok ? r.json() : null)).then((j) => {
      if (!j || j.type !== 'standard' || !j.extract || !SKY.test((j.description || '') + ' ' + j.extract.slice(0, 300))) return null;
      // two or three sentences
      let text = j.extract; if (text.length > 380) { const cut = text.slice(0, 380), end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.\n')); text = end > 120 ? cut.slice(0, end + 1) : cut.replace(/\s\S*$/, '') + ' …'; }
      return { text, img: j.thumbnail ? j.thumbnail.source : '', url: j.content_urls && j.content_urls.desktop ? j.content_urls.desktop.page : 'https://en.wikipedia.org/wiki/' + encodeURIComponent(t), title: j.title };
    }).catch(() => null));
  return cache.get(t);
}
