// Luminosity-ordered octree of point tiles, shared by the star and galaxy layers.
// Each node holds the most luminous points of its volume that no ancestor holds, brightest first, so "everything
// visible from here" is always a set of whole nodes and, within a node, a prefix.
//   record = 4 x uint32 LE: gx, gy, gz (31-bit grid), packed (see the caller)
import { writeOut } from './lib.mjs';

const CAP = 4096;            // points per node
const MAX_LEVEL = 18;
const MERGE_BELOW = 1024;    // a subtree smaller than this is folded into its parent

export function bakeTree(dir, { half, step, n, gx, gy, gz, pk, am }) {
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => am[a] - am[b] || a - b);
  const nodes = [];
  const mk = (level, ix, iy, iz) => { const nd = { level, ix, iy, iz, pts: [], kids: new Array(8).fill(null) }; nodes.push(nd); return nd; };
  const root = mk(0, 0, 0, 0);
  for (let k = 0; k < n; k++) {
    const i = order[k];
    let nd = root;
    while (nd.pts.length >= CAP && nd.level < MAX_LEVEL) {
      const sh = 30 - nd.level;
      const bx = (gx[i] >>> sh) & 1, by = (gy[i] >>> sh) & 1, bz = (gz[i] >>> sh) & 1, c = bx | (by << 1) | (bz << 2);
      nd = nd.kids[c] || (nd.kids[c] = mk(nd.level + 1, nd.ix * 2 + bx, nd.iy * 2 + by, nd.iz * 2 + bz));
    }
    nd.pts.push(i);
  }
  // fold small subtrees into their parent (keeps the brightest-first order: descendants are always fainter)
  const size = (nd) => nd.kids.reduce((s, k) => s + (k ? k.pts.length + size(k) : 0), 0);
  const collect = (nd, out) => { for (const k of nd.kids) if (k) { out.push(...k.pts); collect(k, out); k.dead = true; } };
  const fold = (nd) => {
    const below = size(nd);
    if (below && below < MERGE_BELOW) { const extra = []; collect(nd, extra); extra.sort((a, b) => am[a] - am[b] || a - b); nd.pts.push(...extra); nd.kids.fill(null); }
    else for (const k of nd.kids) if (k) fold(k);
  };
  fold(root);
  const live = nodes.filter((nd) => !nd.dead);
  live.forEach((nd, id) => { nd.id = id; });

  const index = { half, step, cap: CAP, count: n, nodes: [] };
  let bytes = 0, maxLevel = 0;
  for (const nd of live) {
    const m = nd.pts.length, buf = new Uint32Array(m * 4);
    for (let j = 0; j < m; j++) { const i = nd.pts[j]; buf[j * 4] = gx[i]; buf[j * 4 + 1] = gy[i]; buf[j * 4 + 2] = gz[i]; buf[j * 4 + 3] = pk[i]; }
    writeOut(`${dir}/${nd.id}.bin`, Buffer.from(buf.buffer));
    bytes += buf.byteLength; maxLevel = Math.max(maxLevel, nd.level);
    // absolute magnitude at 9 evenly spaced ranks: lets the renderer pick the visible prefix without the tile
    const q = []; for (let r = 0; r <= 8; r++) q.push(+am[nd.pts[Math.min(m - 1, Math.round((r / 8) * (m - 1)))]].toFixed(2));
    index.nodes.push([nd.level, nd.ix, nd.iy, nd.iz, m, nd.kids.map((k) => (k ? k.id : -1)), q]);
  }
  writeOut(`${dir}/index.json`, JSON.stringify(index));
  console.log(`  ${dir}: ${n} points in ${live.length} tiles, ${(bytes / 1e6).toFixed(1)} MB, deepest level ${maxLevel}`);
  return { tiles: live.length, bytes };
}
