// Procedural animation generators. Each one returns an array of 1-bit frames (w x h) that the
// firmware plays back as a plain flip-book - there is no animation code on the keyboard.

import { FB } from "./render.js";

export function fbToBitmap(fb) {
  const stride = (fb.w + 7) >> 3;
  const bits = new Array(stride * fb.h).fill(0);
  for (let y = 0; y < fb.h; y++) {
    for (let x = 0; x < fb.w; x++) {
      if (fb.px[y * fb.w + x]) bits[y * stride + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return { w: fb.w, h: fb.h, bits };
}

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TAU = Math.PI * 2;
const r = Math.round;

function frames(n, w, h, draw) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const fb = new FB(w, h);
    draw(fb, i, i / n);
    out.push(fbToBitmap(fb));
  }
  return out;
}

export const GENERATORS = {
  pulse: {
    label: "Pulse (Ringe)",
    frames: 8,
    fps: 4,
    make: (w, h, n) =>
      frames(n, w, h, (fb, i, t) => {
        const maxR = Math.floor(Math.min(w, h) / 2) - 1;
        for (const off of [0, 0.5]) {
          const rr = r(((t + off) % 1) * maxR);
          if (rr > 0) fb.circle(w >> 1, h >> 1, rr, 1, false, false);
        }
        fb.circle(w >> 1, h >> 1, 2, 1, true, false);
      }),
  },
  radar: {
    label: "Radar",
    frames: 12,
    fps: 4,
    make: (w, h, n) =>
      frames(n, w, h, (fb, i, t) => {
        const cx = w >> 1;
        const cy = h >> 1;
        const R = Math.floor(Math.min(w, h) / 2) - 1;
        fb.circle(cx, cy, R, 1, false, false);
        fb.circle(cx, cy, r(R / 2), 1, false, true);
        for (let k = 0; k < 3; k++) {
          const a = (t - k * 0.04) * TAU;
          fb.line(cx, cy, cx + r(Math.cos(a) * R), cy + r(Math.sin(a) * R), 1);
        }
      }),
  },
  spinner: {
    label: "Spinner (Punkte)",
    frames: 8,
    fps: 4,
    make: (w, h, n) =>
      frames(n, w, h, (fb, i, t) => {
        const cx = w >> 1;
        const cy = h >> 1;
        const R = Math.max(3, Math.floor(Math.min(w, h) / 2) - 4);
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * TAU;
          const x = cx + r(Math.cos(a) * R);
          const y = cy + r(Math.sin(a) * R);
          const age = (i - k + 8) % 8;
          fb.circle(x, y, age === 0 ? 3 : age < 3 ? 2 : 1, 1, true, false);
        }
      }),
  },
  wave: {
    label: "Welle",
    frames: 8,
    fps: 4,
    make: (w, h, n) =>
      frames(n, w, h, (fb, i, t) => {
        const A = Math.max(2, Math.floor(h / 3));
        let py = 0;
        for (let x = 0; x < w; x++) {
          const y = r(h / 2 + A * Math.sin(TAU * ((x / w) * 2 - t)));
          if (x) fb.line(x - 1, py, x, y, 1);
          py = y;
        }
      }),
  },
  equalizer: {
    label: "Equalizer",
    frames: 8,
    fps: 4,
    make: (w, h, n) =>
      frames(n, w, h, (fb, i) => {
        const rand = rng(1234 + i * 77);
        const bars = Math.max(3, Math.floor(w / 8));
        const bw = Math.floor(w / bars) - 2;
        for (let b = 0; b < bars; b++) {
          const bh = 2 + Math.floor(rand() * (h - 4));
          fb.rect(1 + b * (bw + 2), h - bh, bw, bh, 1);
        }
      }),
  },
  bounce: {
    label: "Ball",
    frames: 12,
    fps: 4,
    make: (w, h, n) =>
      frames(n, w, h, (fb, i, t) => {
        const rad = Math.max(3, Math.floor(Math.min(w, h) / 8));
        const floor = h - rad - 2;
        const y = r(floor - (1 - Math.abs(2 * t - 1) ** 2) * (h - 2 * rad - 6));
        const x = r(rad + 2 + t * (w - 2 * rad - 4));
        fb.circle(x, y, rad, 1, true, false);
        fb.rect(0, h - 1, w, 1, 1);
      }),
  },
  stars: {
    label: "Sterne",
    frames: 8,
    fps: 2,
    make: (w, h, n) =>
      frames(n, w, h, (fb, i, t) => {
        const rand = rng(99);
        const count = Math.max(6, Math.floor((w * h) / 150));
        for (let k = 0; k < count; k++) {
          const x = Math.floor(rand() * w);
          const y0 = Math.floor(rand() * h);
          const speed = 1 + (k % 3);
          const y = (y0 + i * speed * Math.max(1, Math.floor(h / 24))) % h;
          fb.set(x, y, 1);
          if (k % 5 === 0) {
            fb.set(x - 1, y, 1);
            fb.set(x + 1, y, 1);
            fb.set(x, y - 1, 1);
            fb.set(x, y + 1, 1);
          }
        }
      }),
  },
  ecg: {
    label: "Herzschlag",
    frames: 12,
    fps: 4,
    make: (w, h, n) =>
      frames(n, w, h, (fb, i, t) => {
        const mid = h >> 1;
        const A = Math.max(3, Math.floor(h / 2) - 3);
        const shape = (u) => {
          u = ((u % 1) + 1) % 1;
          if (u < 0.35) return 0;
          if (u < 0.42) return -0.25 * ((u - 0.35) / 0.07);
          if (u < 0.47)
            return -1 * ((u - 0.42) / 0.05) + -0.25 * (1 - (u - 0.42) / 0.05);
          if (u < 0.55) return -1 + 1.6 * ((u - 0.47) / 0.08);
          if (u < 0.62) return 0.6 - 0.6 * ((u - 0.55) / 0.07);
          return 0;
        };
        let py = 0;
        for (let x = 0; x < w; x++) {
          const y = mid + r(shape(x / w - t) * A);
          if (x) fb.line(x - 1, py, x, y, 1);
          py = y;
        }
      }),
  },
};

export const FPS_PRESETS = [
  { fps: 0.5, period: 2000 },
  { fps: 1, period: 1000 },
  { fps: 2, period: 500 },
  { fps: 4, period: 250 },
];

export function generate(name, w, h, n) {
  const g = GENERATORS[name];
  if (!g) throw new Error(`unknown generator ${name}`);
  return g.make(w, h, n ?? g.frames);
}
