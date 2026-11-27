// Text labels drawn by the GPU. Each visible label owns a slot in a small atlas, painted with canvas text only when
// the label first appears; per frame the labels are just projected and written into one preallocated buffer.
import { GLOBALS, HDR } from './gpu.js';
import { cam } from './camera.js';

const SLOTS = 64, COLS = 2, SW = 256, SH = 26;     // slot size in CSS pixels
const SHADER = /*wgsl*/`
${GLOBALS}
@group(0) @binding(1) var atlas: texture_2d<f32>;
@group(0) @binding(2) var smp: sampler;
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) col: vec4f }
@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) p: vec4f, @location(1) col: vec4f, @location(2) uvr: vec4f) -> VO {
  var o: VO;
  let c = vec2f(f32(vi & 1u), f32(vi >> 1u));
  let px = p.xy + c * p.zw;                            // device pixels, origin top left
  o.pos = vec4f(px.x / G.viewport.x * 2.0 - 1.0, 1.0 - px.y / G.viewport.y * 2.0, 0.5, 1.0);
  o.uv = uvr.xy + c * uvr.zw; o.col = col;
  return o;
}
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let a = textureSampleLevel(atlas, smp, i.uv, 0.0).r * i.col.a;
  return vec4f(i.col.rgb * a, a);
}`;

// kinds: how a label looks and where it sits relative to its anchor
export const KIND = {
  star: { font: '500 12px', colour: [0.80, 0.86, 1.0], dx: 9, dy: -9, upper: false, spacing: '0.02em' },
  con: { font: '500 10.5px', colour: [0.45, 0.60, 0.95], dx: 0, dy: -8, upper: true, spacing: '0.22em', centre: true },
  body: { font: '500 12px', colour: [1.0, 0.92, 0.78], dx: 0, dy: 15, upper: false, spacing: '0.02em', centre: true },
  deep: { font: '500 11.5px', colour: [0.86, 0.80, 1.0], dx: 10, dy: -9, upper: false, spacing: '0.03em' },
  target: { font: '600 12px', colour: [0.62, 0.86, 1.0], dx: 0, dy: 15, upper: false, spacing: '0.04em', centre: true },
  galaxy: { font: '500 11.5px', colour: [0.98, 0.84, 0.88], dx: 0, dy: 16, upper: false, spacing: '0.03em', centre: true },
};

export function initLabels(gpu, globalsBuf, getScale) {
  const { device, queue } = gpu;
  let scale = Math.min(2, Math.max(1, Math.round(getScale())));
  const AW = COLS * SW * scale, AH = (SLOTS / COLS) * SH * scale;
  const cv = document.createElement('canvas'); cv.width = AW; cv.height = AH;
  const g = cv.getContext('2d', { willReadFrequently: false });
  const tex = device.createTexture({ size: [AW, AH], format: 'r8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
  const module = device.createShaderModule({ code: SHADER });
  const layout = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} }, { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} }] });
  const pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: { module, entryPoint: 'vs', buffers: [{ arrayStride: 48, stepMode: 'instance', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }, { shaderLocation: 1, offset: 16, format: 'float32x4' }, { shaderLocation: 2, offset: 32, format: 'float32x4' }] }] },
    fragment: { module, entryPoint: 'fs', targets: [{ format: HDR, blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }] },
    primitive: { topology: 'triangle-strip' },
  });
  const bind = device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: globalsBuf } }, { binding: 1, resource: tex.createView() }, { binding: 2, resource: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }) }] });
  const out = new Float32Array(SLOTS * 12), buf = device.createBuffer({ size: out.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });

  const items = [];                                  // every label that could ever show
  const slotItem = new Int32Array(SLOTS).fill(-1), slotAlpha = new Float32Array(SLOTS), slotWant = new Uint8Array(SLOTS), slotW = new Float32Array(SLOTS);
  const cand = new Int32Array(4096), candScore = new Float32Array(4096), grid = new Uint8Array(64 * 64);
  let live = 0, cursor = 0, nCand = 0, hidden = null;       // hidden(dx, dy, dz): is that point behind something solid?
  const copySrc = { source: cv, origin: [0, 0] }, copyDst = { texture: tex, origin: [0, 0] }, copySize = [SW * scale, SH * scale];

  // text, kind, world position (pc). radius (pc) moves a centred label out below an extended object. Priority is the apparent magnitude from absmag, or the fixed rank if absmag is NaN.
  function add(text, kind, x, y, z, absmag, maxDist = Infinity, minDist = 0, rank = 0, radius = 0) {
    items.push({ rank, radius, text: KIND[kind].upper ? text.toUpperCase() : text, kind, x, y, z, absmag, maxDist, minDist, slot: -1, sx: 0, sy: 0, vis: 0 });
    return items.length - 1;
  }
  // repoint an existing label (the target marker): new text and place; its slot is repainted when it next shows
  function move(i, text, x, y, z, radius) {
    const it = items[i]; it.text = text; it.x = x; it.y = y; it.z = z; it.radius = radius;
    if (it.slot >= 0) paint(it.slot, it);
  }
  function paint(slot, it) {
    const k = KIND[it.kind], x = (slot % COLS) * SW * scale, y = Math.floor(slot / COLS) * SH * scale;
    g.clearRect(x, y, SW * scale, SH * scale);
    g.save(); g.beginPath(); g.rect(x, y, SW * scale, SH * scale); g.clip();
    g.font = k.font.replace(/([\d.]+)px/, (_, v) => v * scale + 'px') + ' ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
    try { g.letterSpacing = k.spacing; } catch {}
    g.textBaseline = 'middle'; g.fillStyle = '#fff';
    g.fillText(it.text, x + 2 * scale, y + SH * scale / 2);
    slotW[slot] = Math.min(SW - 2, g.measureText(it.text).width / scale + 4);
    g.restore();
    copySrc.origin[0] = copyDst.origin[0] = x; copySrc.origin[1] = copyDst.origin[1] = y;
    queue.copyExternalImageToTexture(copySrc, copyDst, copySize);
  }

  // choose which labels show: called a few times a second, looks at a slice of the items each call
  function choose(W, H, pxScale, magLimit, kindGain) {
    const f = 1 / Math.tan(cam.fov / 2), asp = W / H;
    // score a slice of the items (lower is better), keep those on screen and bright enough
    nCand = 0;
    for (let i = 0; i < items.length && nCand < 4096; i++) {
      const it = items[i]; it.vis = 0;
      if (kindGain[it.kind] <= 0.05) continue;
      const dx = it.x - cam.p[0], dy = it.y - cam.p[1], dz = it.z - cam.p[2];
      const vz = dx * cam.fwd[0] + dy * cam.fwd[1] + dz * cam.fwd[2];
      if (vz <= 0) continue;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d > it.maxDist || d < it.minDist) continue;
      if (hidden && hidden(dx, dy, dz)) continue;
      const m = it.absmag === it.absmag ? it.absmag + 5 * Math.log10(Math.max(d, 1e-9) / 10) : it.rank;
      if (m > magLimit[it.kind]) continue;
      const nx = (dx * cam.right[0] + dy * cam.right[1] + dz * cam.right[2]) * f / asp / vz, ny = (dx * cam.up[0] + dy * cam.up[1] + dz * cam.up[2]) * f / vz;
      if (Math.abs(nx) > 0.98 || Math.abs(ny) > 0.94 || (nx * 0.5 + 0.5) * W + (it.text.length * 7.5 + 14) * pxScale > W) continue;
      it.sx = (nx * 0.5 + 0.5) * W; it.sy = (0.5 - ny * 0.5) * H;
      cand[nCand] = i; candScore[nCand] = m - (it.slot >= 0 ? 0.6 : 0); nCand++;   // a label already showing is a little sticky
    }
    // take the best, skipping any that would overlap one already taken (coarse occupancy grid)
    grid.fill(0); slotWant.fill(0);
    const cw = 110 * pxScale, chh = 20 * pxScale, gw = Math.min(64, Math.ceil(W / cw)), gh = Math.min(64, Math.ceil(H / chh));
    let taken = 0;
    while (taken < SLOTS - 8) {
      let best = -1, bs = Infinity;
      for (let c = 0; c < nCand; c++) if (candScore[c] < bs) { bs = candScore[c]; best = c; }
      if (best < 0) break;
      candScore[best] = Infinity;
      const it = items[cand[best]], gx = Math.min(gw - 1, Math.floor(it.sx / cw)), gy = Math.min(gh - 1, Math.floor(it.sy / chh));
      // a label covers its own cell and the next two to the right; refuse if any of those, or the rows touching them, are taken
      let clash = 0;
      for (let yy = Math.max(0, gy - 1); yy <= Math.min(gh - 1, gy + 1); yy++) for (let xx = Math.max(0, gx - 2); xx <= Math.min(gw - 1, gx + 2); xx++) clash |= grid[yy * 64 + xx];
      if (clash) continue;
      grid[gy * 64 + gx] = 1;
      it.vis = 1; taken++;
      if (it.slot < 0) {
        // find a free slot (one whose label has fully faded)
        for (let k = 0; k < SLOTS; k++) { const s = (cursor + k) % SLOTS; if (slotItem[s] < 0) { cursor = s + 1; slotItem[s] = cand[best]; it.slot = s; slotAlpha[s] = 0; paint(s, it); break; } }
      }
      if (it.slot >= 0) slotWant[it.slot] = 1;
    }
  }

  function update(dt, W, H, pxScale, kindGain) {
    const f = 1 / Math.tan(cam.fov / 2), asp = W / H;
    live = 0;
    for (let s = 0; s < SLOTS; s++) {
      const id = slotItem[s]; if (id < 0) continue;
      const it = items[id], k = KIND[it.kind];
      slotAlpha[s] += ((slotWant[s] ? 1 : 0) - slotAlpha[s]) * (1 - Math.exp(-dt * (slotWant[s] ? 4 : 7)));
      if (!slotWant[s] && slotAlpha[s] < 0.02) { slotItem[s] = -1; it.slot = -1; continue; }
      const dx = it.x - cam.p[0], dy = it.y - cam.p[1], dz = it.z - cam.p[2];
      const vz = dx * cam.fwd[0] + dy * cam.fwd[1] + dz * cam.fwd[2];
      if (vz <= 0) continue;
      const sx = ((dx * cam.right[0] + dy * cam.right[1] + dz * cam.right[2]) * f / asp / vz * 0.5 + 0.5) * W, sy = (0.5 - (dx * cam.up[0] + dy * cam.up[1] + dz * cam.up[2]) * f / vz * 0.5) * H;
      const o = live * 12, w = slotW[s] * pxScale, h = SH * pxScale;
      // an extended object keeps its label clear of its own light (up to a third of the view away)
      const clear = it.radius > 0 ? Math.min(it.radius / Math.sqrt(dx * dx + dy * dy + dz * dz) * f * H * 0.42, H * 0.33) : 0;
      out[o] = Math.round(sx + (k.centre ? -w / 2 : k.dx * pxScale)); out[o + 1] = Math.round(sy + k.dy * pxScale + clear - h / 2); out[o + 2] = w; out[o + 3] = h;
      out[o + 4] = k.colour[0]; out[o + 5] = k.colour[1]; out[o + 6] = k.colour[2]; out[o + 7] = slotAlpha[s] * kindGain[it.kind] * 0.6;
      out[o + 8] = (s % COLS) / COLS; out[o + 9] = Math.floor(s / COLS) / (SLOTS / COLS); out[o + 10] = slotW[s] / (SW * COLS); out[o + 11] = 1 / (SLOTS / COLS);
      live++;
    }
    if (live) queue.writeBuffer(buf, 0, out, 0, live * 12);
  }
  function draw(pass) { if (!live) return; pass.setPipeline(pipeline); pass.setBindGroup(0, bind); pass.setVertexBuffer(0, buf); pass.draw(4, live); }
  return { add, move, choose, update, draw, items, occluder: (f) => { hidden = f; } };
}
