// Every external input, pinned. A file source is pinned by commit and sha256; the build fails on a mismatch.
// To update one: change the commit/url, run `npm run data -- --print-sha`, and paste the new checksum.
export const SOURCES = {
  athyg: {
    title: 'AT-HYG v4.0 (Augmented Tycho-HYG star catalogue)',
    url: 'https://codeberg.org/astronexus/athyg/media/commit/eebe42b3552ae04e67d27ae085a8aad997b42bc0/data/athyg_40.csv.gz',
    sha256: '69ad04dd33d7c7bb4f5e1b4682798075811547ea9fb8d0e802e5b319c46818a6',
    file: 'athyg_40.csv.gz',
    licence: 'CC BY-SA 4.0',
    credit: 'David Nash, astronexus.com. Built on Tycho-2, Gaia DR3 (ESA/Gaia/DPAC), Hipparcos, Yale BSC and Gliese-Jahreiss.',
    home: 'https://codeberg.org/astronexus/athyg',
  },
  constellations: {
    title: 'Stellarium "modern" sky culture (IAU constellations, figures and star names)',
    url: 'https://raw.githubusercontent.com/Stellarium/stellarium/dd6415953e9a9821bfbc526b76f3b70594340f23/skycultures/modern/index.json',
    sha256: '1f2f5ffd6c9e25a7d0dcfdbf1f756e2db03dd3b8ed4ec016a2839b09f6b0fe1e',
    file: 'stellarium_modern.json',
    licence: 'CC BY-SA 4.0',
    credit: 'Stellarium contributors',
    home: 'https://github.com/Stellarium/stellarium/tree/master/skycultures/modern',
  },
  openngc: {
    title: 'OpenNGC (NGC/IC/Messier objects)',
    url: 'https://raw.githubusercontent.com/mattiaverga/OpenNGC/be3cd6c5498806a2fbb2f7e0452ef802dbb02be0/database_files/NGC.csv',
    sha256: '54abea0b57b0a103831bfc7a8e3a99a23acfbf4bb581fcf3d8af539cbb826c84',
    file: 'NGC.csv',
    licence: 'CC BY-SA 4.0',
    credit: 'Mattia Verga and OpenNGC contributors',
    home: 'https://github.com/mattiaverga/OpenNGC',
  },
  openngcAddendum: {
    title: 'OpenNGC addendum (Messier objects without NGC numbers, Magellanic Clouds and others)',
    url: 'https://raw.githubusercontent.com/mattiaverga/OpenNGC/be3cd6c5498806a2fbb2f7e0452ef802dbb02be0/database_files/addendum.csv',
    sha256: 'c93f983dda6780b76b7b2e9271a856a892627710148a982ee98101a54c642fdd',
    file: 'addendum.csv',
    licence: 'CC BY-SA 4.0',
    credit: 'Mattia Verga and OpenNGC contributors',
    home: 'https://github.com/mattiaverga/OpenNGC',
  },
};
