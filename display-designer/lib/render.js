// Reference renderer for the status screen. The firmware (display-module/src/dd_render.c)
// implements exactly the same drawing code in C; test/run.mjs checks both produce identical
// pixels. Keep the two in sync.
//
// The screen is 68x160 (portrait, as seen on the keyboard), 1 byte per pixel, 1 = "ink".

import { FONT8 } from "./font8.js";
import { ICONS } from "./icons.js";
import {
  SIN720,
  rdiv,
  isqrt,
  datetimeFrom,
  moonPhase,
  sunTimes,
  SUN_OK,
  WEEKDAYS,
  wordClock,
} from "./timecalc.js";

export const W = 68;
export const H = 160;
export const WPM_HIST = 24;

export const TRANSPORT = { NONE: 0, USB: 1, BLE: 2 };

// Widget kinds in the order of the C enum (dd_render.h).
export const KINDS = [
  "none",
  "battery",
  "connection",
  "profile",
  "layer",
  "wpm",
  "text",
  "image",
  "anim",
  "clock",
  "date",
  "analog",
  "wordclock",
  "binary",
  "moon",
  "sun",
  "stat",
  "weather",
];

// Values the PC helper sends: the metric a "stat" widget shows (its `metric`, in C `source`).
export const STAT_METRICS = ["cpu", "ram", "temp", "volume"];
const STAT_LABELS = ["CPU", "RAM", "TEMP", "VOL"];
export const UNKNOWN_TEMP = -128; // temperatures: this value means "not known"
// Weather condition codes in the order the PC helper sends them.
export const WEATHER_ICONS = [
  "weather_clear",
  "weather_partly",
  "weather_cloud",
  "weather_fog",
  "weather_rain",
  "weather_snow",
  "weather_storm",
];

// Where the sun times are computed for unless the design says otherwise (Berlin).
export const DEFAULT_LOCATION = { lat: 52.52, lon: 13.405 };
export const ALIGNS = ["center", "left", "right"];

export function defaultState() {
  return {
    battery: 100,
    charging: false,
    peerBattery: 80, // <0: unknown
    transport: TRANSPORT.BLE,
    profile: 0, // 0-based
    profileConnected: true,
    profileBonded: true,
    linkConnected: true, // peripheral: link to central
    rssiLink: -55, // dBm, 0 = unknown. peripheral: to the central; central: to the other half
    rssiHost: -65, // dBm, 0 = unknown. central: to the host (PC)
    utc: 1750507653, // seconds since 1970, 2025-06-21 12:07:33 UTC
    utcOffset: 120, // local time minus UTC in minutes
    cpu: 23, // percent, <0 = unknown
    ram: 61,
    temp: 54, // CPU temperature in degrees C, -128 = unknown
    vol: 40, // percent, <0 = unknown
    mute: false,
    wTemp: 14, // weather: degrees C, -128 = unknown
    wCond: 1, // 0..6 (WEATHER_ICONS), <0 = unknown
    wHi: 17,
    wLo: 8,
    layerIndex: 0,
    layerLabel: "BASE",
    wpm: new Array(WPM_HIST).fill(0),
  };
}

// ---------------------------------------------------------------------------
// Geometry

export function bandHeights(side) {
  const top = side.top.count ? side.top.height : 0;
  const bottom = side.bottom.count ? side.bottom.height : 0;
  return { top, bottom, center: H - top - bottom };
}

function bandSlots(prefix, count, y, h) {
  const out = [];
  if (!count || h <= 0) return out;
  if (count === 1) {
    out.push({ id: `${prefix}1`, x: 0, y, w: W, h });
  } else if (count === 2) {
    out.push({ id: `${prefix}1`, x: 0, y, w: W / 2, h });
    out.push({ id: `${prefix}2`, x: W / 2, y, w: W / 2, h });
  } else {
    const h1 = h >> 1;
    out.push({ id: `${prefix}1`, x: 0, y, w: W / 2, h: h1 });
    out.push({ id: `${prefix}2`, x: W / 2, y, w: W / 2, h: h1 });
    out.push({ id: `${prefix}3`, x: 0, y: y + h1, w: W / 2, h: h - h1 });
    out.push({ id: `${prefix}4`, x: W / 2, y: y + h1, w: W / 2, h: h - h1 });
  }
  return out;
}

export function computeSlots(side) {
  const hs = bandHeights(side);
  return [
    ...bandSlots("T", side.top.count, 0, hs.top),
    { id: "C", x: 0, y: hs.top, w: W, h: hs.center },
    ...bandSlots("B", side.bottom.count, hs.top + hs.center, hs.bottom),
  ];
}

// ---------------------------------------------------------------------------
// Framebuffer primitives (all clipped to fb.clip)

export class FB {
  constructor(w = W, h = H) {
    this.w = w;
    this.h = h;
    this.px = new Uint8Array(w * h);
    this.clip = [0, 0, w, h];
  }
  set(x, y, v) {
    const c = this.clip;
    if (x < c[0] || y < c[1] || x >= c[2] || y >= c[3]) return;
    this.px[y * this.w + x] = v;
  }
  rect(x, y, w, h, v) {
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) this.set(x + i, y + j, v);
  }
  hline(x0, x1, y, v) {
    for (let x = x0; x <= x1; x++) this.set(x, y, v);
  }
  line(x0, y0, x1, y1, v) {
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.set(x0, y0, v);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
  }
  circle(cx, cy, r, v, filled, dashed) {
    const plot = (x, y) => {
      if (dashed && ((x + y) & 3) >= 2) return;
      this.set(x, y, v);
    };
    let x = r;
    let y = 0;
    let err = 1 - r;
    while (x >= y) {
      if (filled) {
        this.hline(cx - x, cx + x, cy + y, v);
        this.hline(cx - x, cx + x, cy - y, v);
        this.hline(cx - y, cx + y, cy + x, v);
        this.hline(cx - y, cx + y, cy - x, v);
      } else {
        plot(cx + x, cy + y);
        plot(cx - x, cy + y);
        plot(cx + x, cy - y);
        plot(cx - x, cy - y);
        plot(cx + y, cy + x);
        plot(cx - y, cy + x);
        plot(cx + y, cy - x);
        plot(cx - y, cy - x);
      }
      y++;
      if (err < 0) {
        err += 2 * y + 1;
      } else {
        x--;
        err += 2 * (y - x) + 1;
      }
    }
  }
}

function glyphRows(ch) {
  let c = ch.charCodeAt(0);
  if (c < 32 || c > 127) c = 63; // '?'
  return FONT8[c - 32];
}

export function drawText(fb, x, y, str, s, v) {
  for (let i = 0; i < str.length; i++) {
    const rows = glyphRows(str[i]);
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        if (rows[r] & (0x80 >> c))
          fb.rect(x + i * 8 * s + c * s, y + r * s, s, s, v);
      }
    }
  }
}

// bmp: {w, h, bits[]} with rows padded to whole bytes, MSB first.
function drawBitmap(fb, bmp, x, y, s, fg, bg, opaque) {
  const stride = (bmp.w + 7) >> 3;
  for (let j = 0; j < bmp.h; j++) {
    for (let i = 0; i < bmp.w; i++) {
      const on = (bmp.bits[j * stride + (i >> 3)] >> (7 - (i & 7))) & 1;
      if (on) fb.rect(x + i * s, y + j * s, s, s, fg);
      else if (opaque) fb.rect(x + i * s, y + j * s, s, s, bg);
    }
  }
}

// ---------------------------------------------------------------------------
// Widget content: a widget builds a vertical stack of "parts" for a given scale.

function textPart(str, s, maxW) {
  if (s === 1 && str.length * 8 > maxW) {
    const n = maxW >> 3;
    if (n <= 0) str = "";
    else if (n === 1) str = str.slice(0, 1);
    else str = str.slice(0, n - 1) + ".";
  }
  return {
    w: str.length * 8 * s,
    h: 8 * s,
    draw: (ctx, x, y) => drawText(ctx.fb, x, y, str, s, ctx.fg),
  };
}

function iconPart(name, s) {
  const ic = ICONS[name];
  return {
    w: ic.w * s,
    h: ic.h * s,
    draw: (ctx, x, y) => drawBitmap(ctx.fb, ic, x, y, s, ctx.fg, ctx.bg, false),
  };
}

function slashPart(inner) {
  // draws the inner part and strikes it through
  return {
    w: inner.w,
    h: inner.h,
    draw: (ctx, x, y) => {
      inner.draw(ctx, x, y);
      ctx.fb.line(x, y + inner.h - 1, x + inner.w - 1, y, ctx.fg);
      ctx.fb.line(x, y + inner.h, x + inner.w - 1, y + 1, ctx.bg);
    },
  };
}

function batteryIconPart(level, s, unknown) {
  const w = 22 * s;
  const h = 9 * s;
  return {
    w,
    h,
    draw: (ctx, x, y) => {
      const { fb, fg, bg } = ctx;
      fb.rect(x, y, 20 * s, 9 * s, fg);
      fb.rect(x + s, y + s, 18 * s, 7 * s, bg);
      fb.rect(x + 20 * s, y + 3 * s, 2 * s, 3 * s, fg);
      if (!unknown) {
        const inner = 16 * s;
        const fw = Math.floor((inner * level + 50) / 100);
        fb.rect(x + 2 * s, y + 2 * s, fw, 5 * s, fg);
      }
    },
  };
}

// Signal strength: 4 bars, `n` of them filled (0..4).
export function rssiBars(rssi) {
  if (!rssi) return 0;
  if (rssi >= -60) return 4;
  if (rssi >= -70) return 3;
  if (rssi >= -80) return 2;
  return 1;
}

function barsPart(n, s) {
  return {
    w: 11 * s,
    h: 8 * s,
    draw: (ctx, x, y) => {
      for (let i = 0; i < 4; i++) {
        const bh = (2 + 2 * i) * s;
        if (i < n)
          ctx.fb.rect(x + 3 * s * i, y + 8 * s - bh, 2 * s, bh, ctx.fg);
        else ctx.fb.rect(x + 3 * s * i, y + 7 * s, 2 * s, s, ctx.fg);
      }
    },
  };
}

// A horizontal gauge over the whole slot width, `level` percent filled.
function gaugePart(level, unknown, s, w) {
  const h = 3 * s + 3;
  return {
    w,
    h,
    draw: (ctx, x, y) => {
      const { fb, fg, bg } = ctx;
      fb.rect(x, y, w, h, fg);
      fb.rect(x + 1, y + 1, w - 2, h - 2, bg);
      if (!unknown) {
        const fw = Math.floor(((w - 4) * level + 50) / 100);
        fb.rect(x + 2, y + 2, fw, h - 4, fg);
      }
    },
  };
}

function rowPart(a, b, gap) {
  return {
    w: a.w + gap + b.w,
    h: Math.max(a.h, b.h),
    draw: (ctx, x, y) => {
      a.draw(ctx, x, y + ((Math.max(a.h, b.h) - a.h) >> 1));
      b.draw(ctx, x + a.w + gap, y + ((Math.max(a.h, b.h) - b.h) >> 1));
    },
  };
}

function profilePart(state, s) {
  const r = 6 * s;
  const d = 2 * r + 1;
  return {
    w: d,
    h: d,
    draw: (ctx, x, y) => {
      const { fb, fg, bg } = ctx;
      const cx = x + r;
      const cy = y + r;
      const digit = String((state.profile | 0) + 1);
      let digitColor = fg;
      if (state.profileConnected) {
        fb.circle(cx, cy, r, fg, true, false);
        digitColor = bg;
      } else {
        fb.circle(cx, cy, r, fg, false, state.profileBonded);
      }
      drawText(fb, cx - 4 * s, cy - 4 * s, digit, s, digitColor);
    },
  };
}

function wpmGraph(ctx, slot, state, withNumber) {
  const { fb, fg } = ctx;
  const { x, y, w, h } = slot;
  fb.rect(x, y, w, 1, fg);
  fb.rect(x, y + h - 1, w, 1, fg);
  fb.rect(x, y, 1, h, fg);
  fb.rect(x + w - 1, y, 1, h, fg);
  if (w < 8 || h < 8) return;
  const n = WPM_HIST;
  let max = 40;
  for (let i = 0; i < n; i++) if (state.wpm[i] > max) max = state.wpm[i];
  const gw = w - 4;
  const gh = h - 4;
  let px = 0;
  let py = 0;
  for (let i = 0; i < n; i++) {
    const gx = x + 2 + Math.floor((i * (gw - 1)) / (n - 1));
    const gy = y + 2 + gh - 1 - Math.floor((state.wpm[i] * (gh - 1)) / max);
    if (i > 0) fb.line(px, py, gx, gy, fg);
    px = gx;
    py = gy;
  }
  if (withNumber) {
    const t = String(state.wpm[n - 1]);
    const tw = t.length * 8;
    ctx.fb.rect(x + w - tw - 3, y + 1, tw + 2, 9, ctx.bg);
    drawText(fb, x + w - tw - 2, y + 2, t, 1, fg);
  }
}

// ---------------------------------------------------------------------------

function pad2(n) {
  return String(n).padStart(2, "0");
}

function layerText(state) {
  return state.layerLabel && state.layerLabel.length
    ? state.layerLabel
    : `L${state.layerIndex}`;
}

// Returns a function s -> parts[] for stack-based widgets.
function partsFor(cfg, slot, state) {
  switch (cfg.type) {
    case "battery": {
      const peer = cfg.source === "peer";
      const level = peer ? state.peerBattery : state.battery;
      const unknown = level < 0;
      const style = cfg.style | 0; // 0 icon+percent, 1 icon, 2 percent
      return (s) => {
        const parts = [];
        if (style !== 2) {
          let icon = batteryIconPart(unknown ? 0 : level, s, unknown);
          if (!peer && state.charging)
            icon = rowPart(iconPart("bolt", s), icon, s);
          parts.push(icon);
        }
        if (style !== 1) {
          parts.push(textPart(unknown ? "--" : `${level}%`, s, slot.w));
        }
        return parts;
      };
    }
    case "connection": {
      const style = cfg.style | 0; // 0 icon, 1 icon+label, 2 bars, 3 bars+dBm
      const peer = cfg.source === "peer" && cfg.side !== "peripheral";
      return (s) => {
        let icon;
        let label;
        let rssi = 0;
        let radio = true;
        if (cfg.side === "peripheral") {
          icon = iconPart("bluetooth", s);
          if (!state.linkConnected) icon = slashPart(icon);
          label = state.linkConnected ? "LINK" : "OFF";
          rssi = state.linkConnected ? state.rssiLink : 0;
        } else if (peer) {
          icon = iconPart("bluetooth", s);
          rssi = state.rssiLink;
          if (!rssi) icon = slashPart(icon);
          label = rssi ? "LINK" : "OFF";
        } else if (state.transport === TRANSPORT.USB) {
          icon = iconPart("usb", s);
          label = "USB";
          radio = false;
        } else {
          icon = iconPart("bluetooth", s);
          if (state.profileConnected) {
            label = "BT";
            rssi = state.rssiHost;
          } else if (state.profileBonded) {
            icon = slashPart(icon);
            label = "OFF";
          } else label = "PAIR";
        }
        if (style >= 2 && radio) {
          const parts = [barsPart(rssiBars(rssi), s)];
          if (style === 3)
            parts.push(
              textPart(rssi ? String(rssi) : "--", Math.max(1, s >> 1), slot.w),
            );
          return parts;
        }
        const parts = [icon];
        if (style === 1) parts.push(textPart(label, s, slot.w));
        return parts;
      };
    }
    case "clock": {
      const style = cfg.style | 0; // 0 HH over MM, 1 HH:MM, 2 HH:MM:SS
      const dt = datetimeFrom(state.utc, state.utcOffset);
      const hh = pad2(dt.hour);
      const mm = pad2(dt.minute);
      return (s) => {
        if (style === 0)
          return [textPart(hh, s, slot.w), textPart(mm, s, slot.w)];
        const str =
          style === 1 ? `${hh}:${mm}` : `${hh}:${mm}:${pad2(dt.second)}`;
        return [textPart(str, s, slot.w)];
      };
    }
    case "date": {
      // 0 DD.MM.  1 MO DD.MM  2 DD.MM.YY  3 KW 25  4 weekday, date and week stacked
      const style = cfg.style | 0;
      const dt = datetimeFrom(state.utc, state.utcOffset);
      const wd = WEEKDAYS[dt.weekday - 1];
      const dm = `${pad2(dt.day)}.${pad2(dt.month)}.`;
      const kw = `KW ${pad2(dt.week)}`;
      return (s) => {
        switch (style) {
          case 1:
            return [textPart(`${wd} ${dm.slice(0, 5)}`, s, slot.w)];
          case 2:
            return [textPart(`${dm}${pad2(dt.year % 100)}`, s, slot.w)];
          case 3:
            return [textPart(kw, s, slot.w)];
          case 4:
            return [
              textPart(wd, s, slot.w),
              textPart(dm, s, slot.w),
              textPart(kw, s, slot.w),
            ];
          default:
            return [textPart(dm, s, slot.w)];
        }
      };
    }
    case "wordclock": {
      const dt = datetimeFrom(state.utc, state.utcOffset);
      const lines = wordClock(dt.hour, dt.minute, (cfg.style | 0) === 1);
      return (s) => lines.map((l) => textPart(l, s, slot.w));
    }
    case "sun": {
      const style = cfg.style | 0; // 0 sunrise and sunset, 1 sunrise, 2 sunset
      const loc = cfg.loc ?? DEFAULT_LOCATION;
      const t = sunTimes(
        state.utc,
        state.utcOffset,
        Math.round(loc.lat * 1e4),
        Math.round(loc.lon * 1e4),
      );
      const fmt = (m) =>
        t.status === SUN_OK
          ? `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`
          : "--:--";
      return (s) => {
        const out = [];
        if (style !== 2)
          out.push(
            rowPart(
              iconPart("sunrise", s),
              textPart(fmt(t.rise), s, slot.w),
              s,
            ),
          );
        if (style !== 1)
          out.push(
            rowPart(iconPart("sunset", s), textPart(fmt(t.set), s, slot.w), s),
          );
        return out;
      };
    }
    case "stat": {
      // 0 value + label, 1 value, 2 value + gauge, 3 label + value + gauge
      const style = cfg.style | 0;
      const m = Math.max(0, STAT_METRICS.indexOf(cfg.metric));
      let unknown;
      let text;
      let pct;
      if (m === 2) {
        unknown = state.temp === UNKNOWN_TEMP;
        text = unknown ? "--" : `${state.temp}C`;
        pct = unknown
          ? 0
          : Math.max(
              0,
              Math.min(100, Math.trunc(((state.temp - 20) * 100) / 80)),
            );
      } else {
        const v = m === 0 ? state.cpu : m === 1 ? state.ram : state.vol;
        unknown = v < 0;
        const muted = m === 3 && state.mute && !unknown;
        text = unknown ? "--" : muted ? "MUTE" : `${v}%`;
        pct = unknown || muted ? 0 : v;
      }
      return (s) => {
        const small = Math.max(1, s >> 1);
        const value = textPart(text, s, slot.w);
        const label = textPart(STAT_LABELS[m], small, slot.w);
        const gauge = gaugePart(pct, unknown, s, slot.w);
        if (style === 1) return [value];
        if (style === 2) return [value, gauge];
        if (style === 3) return [label, value, gauge];
        return [value, label];
      };
    }
    case "weather": {
      // 0 icon + temperature, 1 temperature, 2 icon + temperature, high/low
      const style = cfg.style | 0;
      const known = state.wTemp !== UNKNOWN_TEMP;
      const temp = known ? `${state.wTemp}C` : "--";
      const icon =
        state.wCond >= 0 && state.wCond < WEATHER_ICONS.length
          ? WEATHER_ICONS[state.wCond]
          : null;
      const hl =
        state.wHi !== UNKNOWN_TEMP && state.wLo !== UNKNOWN_TEMP
          ? `${state.wHi}/${state.wLo}`
          : "--";
      return (s) => {
        const t = textPart(temp, s, slot.w);
        if (style === 1 || (style === 0 && !icon)) return [t];
        if (style === 0) return [iconPart(icon, s), t];
        const small = Math.max(1, s >> 1);
        return [
          icon ? rowPart(iconPart(icon, s), t, s) : t,
          textPart(hl, small, slot.w),
        ];
      };
    }
    case "profile":
      return (s) => [profilePart(state, s)];
    case "layer": {
      const style = cfg.style | 0; // 0 name, 1 number, 2 number + name
      return (s) => {
        if (style === 1) return [textPart(String(state.layerIndex), s, slot.w)];
        if (style === 2)
          return [
            textPart(String(state.layerIndex), s, slot.w),
            textPart(layerText(state), Math.max(1, s >> 1), slot.w),
          ];
        return [textPart(layerText(state), s, slot.w)];
      };
    }
    case "wpm": {
      return (s) => [
        textPart(String(state.wpm[WPM_HIST - 1]), s, slot.w),
        textPart("WPM", Math.max(1, s >> 1), slot.w),
      ];
    }
    case "text":
      return (s) => [textPart(cfg.text || "", s, slot.w)];
    default:
      return null;
  }
}

function chooseScale(parts, slot, requested) {
  const start = requested > 0 ? requested : 4;
  for (let s = start; s >= 1; s--) {
    const ps = parts(s);
    let tw = 0;
    let th = 0;
    for (const p of ps) {
      tw = Math.max(tw, p.w);
      th += p.h;
    }
    th += (ps.length - 1) * 2 * s;
    if (tw <= slot.w && th <= slot.h) return s;
  }
  return 1;
}

function handEnd(cx, cy, len, idx) {
  return [
    cx + rdiv(len * SIN720[idx], 1000),
    cy - rdiv(len * SIN720[(idx + 180) % 720], 1000),
  ];
}

function drawAnalog(ctx, slot, state, withSeconds) {
  const { fb, fg } = ctx;
  const dt = datetimeFrom(state.utc, state.utcOffset);
  const cx = slot.x + (slot.w >> 1);
  const cy = slot.y + (slot.h >> 1);
  const R = (Math.min(slot.w, slot.h) >> 1) - 1;
  if (R < 6) return;
  fb.circle(cx, cy, R, fg, false, false);
  for (let i = 0; i < 12; i++) {
    const len = i % 3 === 0 ? 4 : 2;
    const a = handEnd(cx, cy, R - len, i * 60);
    const b = handEnd(cx, cy, R - 1, i * 60);
    fb.line(a[0], a[1], b[0], b[1], fg);
  }
  const hourEnd = handEnd(
    cx,
    cy,
    Math.floor((R * 5) / 10),
    (dt.hour % 12) * 60 + dt.minute,
  );
  fb.line(cx, cy, hourEnd[0], hourEnd[1], fg);
  fb.line(cx + 1, cy, hourEnd[0] + 1, hourEnd[1], fg);
  const minEnd = handEnd(
    cx,
    cy,
    Math.floor((R * 8) / 10),
    Math.floor((dt.minute * 60 + dt.second) / 5),
  );
  fb.line(cx, cy, minEnd[0], minEnd[1], fg);
  if (withSeconds) {
    const secEnd = handEnd(cx, cy, Math.floor((R * 9) / 10), dt.second * 12);
    fb.line(cx, cy, secEnd[0], secEnd[1], fg);
  }
  fb.circle(cx, cy, 2, fg, true, false);
}

function drawBinary(ctx, slot, state, withSeconds) {
  const { fb, fg } = ctx;
  const dt = datetimeFrom(state.utc, state.utcOffset);
  const digits = [
    Math.floor(dt.hour / 10),
    dt.hour % 10,
    Math.floor(dt.minute / 10),
    dt.minute % 10,
  ];
  const bits = [2, 4, 3, 4];
  if (withSeconds) {
    digits.push(Math.floor(dt.second / 10), dt.second % 10);
    bits.push(3, 4);
  }
  const n = digits.length;
  const cs = Math.min(Math.floor(slot.w / n), Math.floor(slot.h / 4));
  if (cs < 3) return;
  const x0 = slot.x + ((slot.w - cs * n) >> 1);
  const y0 = slot.y + ((slot.h - cs * 4) >> 1);
  const r = Math.max(1, ((cs - 1) >> 1) - 1);
  for (let col = 0; col < n; col++) {
    for (let row = 0; row < 4; row++) {
      const bit = 3 - row;
      if (bit >= bits[col]) continue;
      fb.circle(
        x0 + col * cs + (cs >> 1),
        y0 + row * cs + (cs >> 1),
        r,
        fg,
        ((digits[col] >> bit) & 1) === 1,
        false,
      );
    }
  }
}

function drawMoon(ctx, slot, state, showPercent) {
  const { fb, fg } = ctx;
  const reserve = showPercent ? 10 : 0;
  const R = (Math.min(slot.w, slot.h - reserve) >> 1) - 1;
  if (R < 3) return;
  const cx = slot.x + (slot.w >> 1);
  const cy = slot.y + ((slot.h - reserve) >> 1);
  const p = moonPhase(state.utc);
  const k = SIN720[(Math.floor((p * 720) / 1024) + 180) % 720]; // cos of the phase angle
  const waxing = p < 512;
  for (let dy = -R; dy <= R; dy++) {
    const hw = isqrt(R * R - dy * dy);
    const xt = rdiv(hw * k, 1000);
    const lo = waxing ? xt : -hw;
    const hi = waxing ? hw : -xt;
    for (let x = lo; x <= hi; x++) fb.set(cx + x, cy + dy, fg);
  }
  fb.circle(cx, cy, R, fg, false, false);
  if (showPercent) {
    const t = `${Math.floor((1000 - k) / 20)}%`;
    drawText(
      fb,
      slot.x + ((slot.w - t.length * 8) >> 1),
      slot.y + slot.h - 9,
      t,
      1,
      fg,
    );
  }
}

function drawStack(ctx, slot, parts, scale, align) {
  const s = chooseScale(parts, slot, scale);
  const ps = parts(s);
  const gap = 2 * s;
  let th = 0;
  for (const p of ps) th += p.h;
  th += (ps.length - 1) * gap;
  let y = slot.y + ((slot.h - th) >> 1);
  for (const p of ps) {
    let x;
    if (align === 1) x = slot.x;
    else if (align === 2) x = slot.x + slot.w - p.w;
    else x = slot.x + ((slot.w - p.w) >> 1);
    p.draw(ctx, x, y);
    y += p.h + gap;
  }
}

function centeredBitmap(ctx, slot, bmp, align) {
  let x;
  if (align === 1) x = slot.x;
  else if (align === 2) x = slot.x + slot.w - bmp.w;
  else x = slot.x + ((slot.w - bmp.w) >> 1);
  const y = slot.y + ((slot.h - bmp.h) >> 1);
  drawBitmap(ctx.fb, bmp, x, y, 1, ctx.fg, ctx.bg, true);
}

export function drawSlot(fb, slot, cfg, state, tick) {
  const inv = cfg.invert ? 1 : 0;
  const ctx = { fb, fg: inv ? 0 : 1, bg: inv ? 1 : 0 };
  fb.clip = [slot.x, slot.y, slot.x + slot.w, slot.y + slot.h];
  fb.rect(slot.x, slot.y, slot.w, slot.h, ctx.bg);
  const align = ALIGNS.indexOf(cfg.align || "center");
  const scale = cfg.scale | 0;
  switch (cfg.type) {
    case "wpm":
      if ((cfg.style | 0) === 0) {
        drawStack(ctx, slot, partsFor(cfg, slot, state), scale, align);
      } else {
        wpmGraph(ctx, slot, state, (cfg.style | 0) === 2);
      }
      break;
    case "image":
      if (cfg.bitmap) centeredBitmap(ctx, slot, cfg.bitmap, align);
      break;
    case "analog":
      drawAnalog(ctx, slot, state, (cfg.style | 0) === 1);
      break;
    case "binary":
      drawBinary(ctx, slot, state, (cfg.style | 0) === 1);
      break;
    case "moon":
      drawMoon(ctx, slot, state, (cfg.style | 0) === 1);
      break;
    case "anim":
      if (cfg.frames && cfg.frames.length) {
        const div = Math.max(1, cfg.div | 0);
        centeredBitmap(
          ctx,
          slot,
          cfg.frames[Math.floor(tick / div) % cfg.frames.length],
          align,
        );
      }
      break;
    case "none":
    case undefined:
      break;
    default: {
      const parts = partsFor({ ...cfg }, slot, state);
      if (parts) drawStack(ctx, slot, parts, scale, align);
    }
  }
  fb.clip = [0, 0, fb.w, fb.h];
}

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

// Animation timing of one half: all animations are driven by a single timer whose period is the
// gcd of the frame periods, so every frame period is a whole number of ticks.
export function animTiming(side) {
  const periods = [];
  for (const slot of computeSlots(side)) {
    const c = side.slots[slot.id];
    if (c && c.type === "anim" && c.frames && c.frames.length)
      periods.push(c.period || 1000);
  }
  if (!periods.length) return { tickMs: 0 };
  return { tickMs: periods.reduce(gcd) };
}

// Renders one half. `sideName` ("central"|"peripheral") is passed on to widgets that behave
// differently on the two halves.
export function renderSide(sideName, side, state, tick, location) {
  const fb = new FB();
  const { tickMs } = animTiming(side);
  for (const slot of computeSlots(side)) {
    const cfg = side.slots[slot.id] ?? { type: "none" };
    const div = tickMs
      ? Math.max(1, Math.round((cfg.period || 1000) / tickMs))
      : 1;
    drawSlot(
      fb,
      slot,
      { ...cfg, side: sideName, div, loc: location },
      state,
      tick,
    );
  }
  return fb;
}

export function toAscii(fb) {
  const rows = [];
  for (let y = 0; y < fb.h; y++) {
    let r = "";
    for (let x = 0; x < fb.w; x++) r += fb.px[y * fb.w + x] ? "#" : ".";
    rows.push(r);
  }
  return rows.join("\n");
}

// Widgets that only make sense on one half.
export const WIDGET_AVAILABILITY = {
  none: ["central", "peripheral"],
  battery: ["central", "peripheral"],
  connection: ["central", "peripheral"],
  profile: ["central", "peripheral"],
  layer: ["central", "peripheral"],
  wpm: ["central"],
  text: ["central", "peripheral"],
  image: ["central", "peripheral"],
  anim: ["central", "peripheral"],
  clock: ["central", "peripheral"],
  date: ["central", "peripheral"],
  analog: ["central", "peripheral"],
  wordclock: ["central", "peripheral"],
  binary: ["central", "peripheral"],
  moon: ["central", "peripheral"],
  sun: ["central", "peripheral"],
  stat: ["central", "peripheral"],
  weather: ["central", "peripheral"],
};

// How often a design needs the screen redrawn because of the time: 0 never, 1 every minute,
// 2 every second.
export function timeMode(side) {
  let mode = 0;
  for (const slot of computeSlots(side)) {
    const c = side.slots[slot.id];
    if (!c) continue;
    const style = c.style | 0;
    if (
      (c.type === "clock" && style === 2) ||
      ((c.type === "analog" || c.type === "binary") && style === 1)
    )
      return 2;
    if (
      [
        "clock",
        "date",
        "analog",
        "wordclock",
        "binary",
        "moon",
        "sun",
      ].includes(c.type)
    )
      mode = 1;
  }
  return mode;
}

export function widgetAvailable(type, side, cfg) {
  if (!WIDGET_AVAILABILITY[type]?.includes(side)) return false;
  if (
    (type === "battery" || type === "connection") &&
    side === "peripheral" &&
    cfg?.source === "peer"
  )
    return false;
  return true;
}
