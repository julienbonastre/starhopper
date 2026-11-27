// Detail levels: the same universe with less in it. Chosen before anything is built, remembered between visits.
// localStorage.starhopper = "level"; starhopperLoad is set while loading, so a crash drops the next visit a level.
const mob = matchMedia('(pointer:coarse)').matches, mem = navigator.deviceMemory;
export const keep = (k, v) => { try { localStorage[k] = v; } catch {} };
let saved = '', bad;
try { saved = localStorage.starhopper || ''; bad = localStorage.starhopperLoad; } catch {}
let lv = saved !== '' ? +saved : mob ? (mem > 7 ? 1 : 2) : mem <= 4 ? 2 : 0;
if (bad && lv < 2) keep('starhopper', ++lv);
const q = new URLSearchParams(location.search).get('q');
if (q !== null && q !== '') lv = Math.max(0, Math.min(2, +q || 0));
export const LEVEL = lv, MOBILE = mob;
export const NAMES = ['High', 'Medium', 'Low'];
export const quality = [
  { starBudget: 2_600_000, bloomMips: 6, magBias: 0, maxPixels: 3840 * 2160, startScale: 1, volScale: 0.5, volSteps: 44, fillGrid: 32 },
  { starBudget: 1_200_000, bloomMips: 5, magBias: -0.6, maxPixels: 2560 * 1440, startScale: 0.85, volScale: 0.5, volSteps: 28, fillGrid: 24 },
  { starBudget: 500_000, bloomMips: 4, magBias: -1.3, maxPixels: 1280 * 720, startScale: 0.7, volScale: 0.34, volSteps: 16, fillGrid: 16 },
][lv];
