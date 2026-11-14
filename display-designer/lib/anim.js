// Procedural animation generators. Each one returns an array of 1-bit frames (w x h) that the
// firmware plays back as a plain flip-book - there is no animation code on the keyboard.

import { FB, drawText } from "./render.js";

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
          // Every star is a plus (3 px): single pixels are barely visible on the panel.
          fb.set(x, y, 1);
          fb.set(x - 1, y, 1);
          fb.set(x + 1, y, 1);
          fb.set(x, y - 1, 1);
          fb.set(x, y + 1, 1);
          if (k % 4 === 0) {
            // a few bigger ones
            fb.set(x - 2, y, 1);
            fb.set(x + 2, y, 1);
            fb.set(x, y - 2, 1);
            fb.set(x, y + 2, 1);
          }
        }
      }),
  },
  matrix: {
    label: "Matrix (Zeichenregen)",
    frames: 24,
    fps: 4,
    make: (w, h, n) =>
      frames(n, w, h, (fb, i) => {
        // Columns of 8x8 characters fall one cell per frame; n cells are one full loop.
        const CH = "0123456789ABCDEFGHKMNRSXZ@#$%&*+=<>?/\\|";
        const cols = Math.max(1, Math.floor(w / 8));
        const x0 = (w - cols * 8) >> 1;
        const rows = Math.ceil(h / 8);
        const P = Math.max(n, 2);
        for (let c = 0; c < cols; c++) {
          const rand = rng(777 + c * 31);
          const speed = 1 + Math.floor(rand() * 2); // 1 or 2 cells per frame
          const trail = 4 + Math.floor(rand() * 5);
          const off = Math.floor(rand() * P);
          const head = (off + speed * i) % P;
          for (let r = 0; r < rows; r++) {
            const age = (((head - r) % P) + P) % P; // 0 = head
            if (age >= trail) continue;
            const flick = (r * 7 + c * 13 + i) % 5 === 0;
            const g = rng(c * 1009 + r * 131 + (flick ? i : 0) + 5);
            const ch = CH[Math.floor(g() * CH.length)];
            const x = x0 + c * 8;
            const y = r * 8;
            if (age === 0) {
              fb.rect(x, y, 8, 8, 1);
              drawText(fb, x, y, ch, 1, 0);
            } else if (age < trail - 2) {
              drawText(fb, x, y, ch, 1, 1);
            } else {
              // fading tail: draw only every other pixel
              const t = new FB(8, 8);
              drawText(t, 0, 0, ch, 1, 1);
              for (let yy = 0; yy < 8; yy++)
                for (let xx = 0; xx < 8; xx++)
                  if (t.px[yy * 8 + xx] && (xx + yy) % 2 === 0)
                    fb.set(x + xx, y + yy, 1);
            }
          }
        }
      }),
  },
  dna: {
    label: "DNA-Helix",
    frames: 16,
    fps: 4,
    make: (w, h, n) =>
      frames(n, w, h, (fb, i, t) => {
        const A = Math.max(3, Math.floor(w / 2) - 5);
        const cx = w >> 1;
        let p1 = null;
        let p2 = null;
        for (let y = 0; y < h; y++) {
          const ph = TAU * (y / 32 - t);
          const a = cx + r(A * Math.sin(ph));
          const b = cx - r(A * Math.sin(ph));
          if (p1) {
            fb.line(p1[0], y - 1, a, y, 1);
            fb.line(p2[0], y - 1, b, y, 1);
          }
          p1 = [a];
          p2 = [b];
          if (y % 6 === 0) {
            for (let x = Math.min(a, b); x <= Math.max(a, b); x += 2)
              fb.set(x, y, 1);
            // the strand in front is drawn thicker
            fb.set(Math.cos(ph) > 0 ? a : b, y, 1);
            fb.rect((Math.cos(ph) > 0 ? a : b) - 1, y - 1, 3, 3, 1);
          }
        }
      }),
  },
  warp: {
    label: "Warp (Sternenflug)",
    frames: 12,
    fps: 4,
    make: (w, h, n) =>
      frames(n, w, h, (fb, i, t) => {
        const rand = rng(4242);
        const cx = w / 2;
        const cy = h / 2;
        const R = Math.hypot(cx, cy);
        const count = Math.max(8, Math.floor((w * h) / 200));
        for (let k = 0; k < count; k++) {
          const ang = rand() * TAU;
          const u = (rand() + t) % 1;
          const rr = u * u * R;
          const x = r(cx + Math.cos(ang) * rr);
          const y = r(cy + Math.sin(ang) * rr);
          const tail = r(u * 5);
          if (tail > 0)
            fb.line(
              x,
              y,
              r(cx + Math.cos(ang) * (rr - tail)),
              r(cy + Math.sin(ang) * (rr - tail)),
              1,
            );
          if (u > 0.5) fb.rect(x, y, 2, 2, 1);
          else fb.set(x, y, 1);
        }
      }),
  },
  snow: {
    label: "Schnee",
    frames: 16,
    fps: 4,
    make: (w, h, n) =>
      frames(n, w, h, (fb, i, t) => {
        const rand = rng(31337);
        const count = Math.max(8, Math.floor((w * h) / 120));
        for (let k = 0; k < count; k++) {
          const x0 = rand() * w;
          const y0 = rand() * h;
          const fall = 1 + Math.floor(rand() * 3); // loops per cycle
          const swayPh = rand() * TAU;
          const big = rand() < 0.35;
          const y = (Math.floor(y0) + Math.floor((fall * h * i) / n)) % h;
          const x = r(x0 + 2 * Math.sin(swayPh + TAU * t * fall));
          fb.set(x, y, 1);
          if (big) {
            fb.set(x - 1, y, 1);
            fb.set(x + 1, y, 1);
            fb.set(x, y - 1, 1);
            fb.set(x, y + 1, 1);
          }
        }
      }),
  },
  orbit: {
    label: "Atom (Elektronen)",
    frames: 12,
    fps: 4,
    make: (w, h, n) =>
      frames(n, w, h, (fb, i, t) => {
        const cx = w >> 1;
        const cy = h >> 1;
        const R = Math.floor(Math.min(w, h) / 2) - 3;
        const a = R;
        const b = Math.max(3, r(R / 3));
        for (let k = 0; k < 3; k++) {
          const tilt = (k * Math.PI) / 3;
          const ct = Math.cos(tilt);
          const st = Math.sin(tilt);
          const pt = (ang) => [
            cx + r(a * Math.cos(ang) * ct - b * Math.sin(ang) * st),
            cy + r(a * Math.cos(ang) * st + b * Math.sin(ang) * ct),
          ];
          let prev = pt(0);
          for (let s = 1; s <= 48; s++) {
            const q = pt((s / 48) * TAU);
            if (s % 2) fb.line(prev[0], prev[1], q[0], q[1], 1);
            prev = q;
          }
          const e = pt((t + k / 3) * TAU);
          fb.circle(e[0], e[1], 2, 1, true, false);
        }
        fb.circle(cx, cy, 3, 1, true, false);
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
