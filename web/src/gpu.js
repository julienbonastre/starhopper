// WebGPU device and small helpers shared by every pass
export const $ = (id) => document.getElementById(id);
export const fail = (m) => { throw new Error(m, { cause: 1 }); }; // cause marks a message shown as it is

export async function initGpu(canvas) {
  if (!navigator.gpu) fail('Starhopper needs WebGPU. Try a current Chrome or Edge.');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) fail('No WebGPU adapter found.');
  const hasTS = adapter.features.has('timestamp-query');
  const device = await adapter.requestDevice({ requiredFeatures: hasTS ? ['timestamp-query'] : [] });
  device.addEventListener('uncapturederror', (e) => console.error('GPU: ' + e.error.message));
  // ?offscreen renders into a texture instead of the canvas: for headless test rigs that cannot present WebGPU
  const offscreen = new URLSearchParams(location.search).has('offscreen');
  const ctx = offscreen ? null : canvas.getContext('webgpu'), format = offscreen ? 'rgba8unorm' : navigator.gpu.getPreferredCanvasFormat();
  if (ctx) ctx.configure({ device, format, alphaMode: 'opaque' });
  return { adapter, device, ctx, format, hasTS, offscreen, queue: device.queue };
}

export const HDR = 'rgba16float';

// One uniform block shared by all passes. JS writes it through f32/i32 views of the same buffer.
export const GLOBALS = /*wgsl*/`
struct Globals {
  right: vec3f, focal: f32,      // camera basis (world axes) and 1/tan(fov/2)
  up: vec3f, aspect: f32,
  fwd: vec3f, exposure: f32,
  viewport: vec2f, time: f32, pxScale: f32,   // pxScale: device pixels per CSS pixel
  camQ: vec3i, pad0: i32,        // camera on the star grid: integer part
  camF: vec3f, step: f32,        // ... fractional part, and parsecs per grid unit
  far: vec3f, lineAlpha: f32,    // offset used instead of camQ when the camera is outside the grid cube
}
@group(0) @binding(0) var<uniform> G: Globals;
// camera-relative parsecs -> clip space (z is unused: nothing here needs a depth buffer)
fn project(rel: vec3f) -> vec4f {
  let v = vec3f(dot(rel, G.right), dot(rel, G.up), dot(rel, G.fwd));
  if (v.z <= 0.0) { return vec4f(0.0, 0.0, 2.0, 1.0); }
  return vec4f(v.x * G.focal / G.aspect / v.z, v.y * G.focal / v.z, 0.5, 1.0);
}
`;
export const GLOBALS_SIZE = 112;
