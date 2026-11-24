// Smooth value noise + fBm. Used by map generation (terrain, rivers).

import { mulberry32 } from './rng.js';

function makeGrid(w, h, rng) {
  const g = new Float32Array(w * h);
  for (let i = 0; i < g.length; i++) g[i] = rng();
  return g;
}

function smooth(t) {
  return t * t * (3 - 2 * t);
}

function sampleGrid(w, h, x, y, g) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = smooth(x - x0), fy = smooth(y - y0);
  const gx1 = Math.min(x0 + 1, w - 1), gy1 = Math.min(y0 + 1, h - 1);
  const nx0 = ((x0 % w) + w) % w, ny0 = ((y0 % h) + h) % h;
  const v00 = g[ny0 * w + nx0], v10 = g[ny0 * w + gx1];
  const v01 = g[gy1 * w + nx0], v11 = g[gy1 * w + gx1];
  return (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
}

// Fractal Brownian motion, output normalized to [0,1].
export function fbm(w, h, octaves, rng) {
  let out = new Float32Array(w * h);
  let amp = 1, total = 0, freq = 1;
  for (let o = 0; o < octaves; o++) {
    const gw = Math.floor(w * freq) + 2, gh = Math.floor(h * freq) + 2;
    const grid = makeGrid(gw, gh, rng);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        out[y * w + x] += sampleGrid(gw, gh, (x / w) * (gw - 1), (y / h) * (gh - 1), grid) * amp;
      }
    }
    total += amp; amp *= 0.5; freq *= 2;
  }
  const scale = 1 / total;
  for (let i = 0; i < out.length; i++) out[i] *= scale;
  return out;
}
