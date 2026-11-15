import {
  W,
  H,
  WPM_HIST,
  TRANSPORT,
  computeSlots,
  bandHeights,
  renderSide,
  animTiming,
  defaultState,
  widgetAvailable,
  timeMode,
  DEFAULT_LOCATION,
  KINDS,
} from "./lib/render.js";
import { genAll } from "./lib/codegen.js";
import { defaultDesign, makeAnim } from "./lib/defaults.js";
import { GENERATORS, FPS_PRESETS, generate, fbToBitmap } from "./lib/anim.js";
import { FB } from "./lib/render.js";

const SIDES = [
  { id: "central", title: "Links – Central (mit Tastatur-Logik)" },
  { id: "peripheral", title: "Rechts – Peripheral" },
];
const TYPE_LABELS = {
  none: "Leer",
  battery: "Batterie",
  connection: "Verbindung",
  profile: "BT-Profil (aktiv)",
  layer: "Layer",
  wpm: "WPM",
  text: "Text",
  image: "Bild",
  anim: "Animation",
  clock: "Uhrzeit (digital)",
  date: "Datum / Kalenderwoche",
  analog: "Analoge Uhr",
  wordclock: "Wortuhr",
  binary: "Binäruhr",
  moon: "Mondphase",
  sun: "Sonnenauf-/untergang",
  stat: "PC-Werte (CPU, RAM, …)",
  weather: "Wetter (PC)",
};
const MAX_FRAMES = 32;
const SCALE = 4;

// --------------------------------------------------------------------------- state

let design = defaultDesign();
let sel = { side: "central", slot: "C" };
let dirty = false;
const sim = {
  ...defaultState(),
  wpmAuto: true,
  peerUnknown: false,
  wpmNow: 0,
  timeRunning: true,
};
const ticks = { central: 0, peripheral: 0 };
const timers = {};
// Source images of image/anim slots, kept in memory so threshold/dither can be re-applied.
const sources = new Map();

const $ = (sel_, root = document) => root.querySelector(sel_);

function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "value") e.value = v;
    else if (v === true) e.setAttribute(k, "");
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) e.append(c);
  return e;
}

function setStatus(text, cls = "") {
  const s = $("#status");
  s.textContent = text;
  s.className = cls;
}

function markDirty() {
  dirty = true;
  setStatus("Nicht gespeichert", "dirty");
}

// --------------------------------------------------------------------------- design helpers

function sideCfg(id) {
  return design.sides[id];
}

function slotsOf(sideId) {
  return computeSlots(sideCfg(sideId));
}

function slotCfg(sideId, slotId) {
  const side = sideCfg(sideId);
  if (!side.slots[slotId]) side.slots[slotId] = { type: "none" };
  return side.slots[slotId];
}

function flashBytes(sideId) {
  let total = 0;
  for (const slot of slotsOf(sideId)) {
    const c = sideCfg(sideId).slots[slot.id];
    if (!c) continue;
    const size = (b) => ((b.w + 7) >> 3) * b.h;
    if (c.type === "image" && c.bitmap) total += size(c.bitmap);
    if (c.type === "anim" && c.frames)
      for (const f of c.frames) total += size(f);
  }
  return total;
}

// Generated animations are sized for their slot; keep them in sync with the slot size.
function normalize() {
  for (const { id } of SIDES) {
    const side = sideCfg(id);
    for (const slot of computeSlots(side)) {
      const c = side.slots[slot.id];
      if (c && c.type === "anim" && c.generator && c.frames?.length) {
        if (c.frames[0].w !== slot.w || c.frames[0].h !== slot.h) {
          c.frames = generate(c.generator, slot.w, slot.h, c.frames.length);
        }
      }
    }
    // drop widgets that are not available on this half
    for (const [sid, c] of Object.entries(side.slots)) {
      if (!widgetAvailable(c.type, id, c)) side.slots[sid] = { type: "none" };
    }
  }
}

// --------------------------------------------------------------------------- previews

const canvases = {};

function buildPreviews() {
  const host = $("#previews");
  host.replaceChildren();
  for (const { id, title } of SIDES) {
    const canvas = el("canvas", { width: W, height: H });
    const overlay = el("div", { style: "position:absolute;inset:0" });
    const meta = el("div", { class: "meta" });
    canvases[id] = { canvas, overlay, meta, ctx: canvas.getContext("2d") };
    host.append(
      el(
        "div",
        { class: "half" },
        el("h2", {}, title),
        el(
          "div",
          { class: "bezel" },
          el("div", { class: "screen" }, canvas, overlay),
        ),
        meta,
      ),
    );
  }
}

function buildOverlays() {
  for (const { id } of SIDES) {
    const { overlay } = canvases[id];
    overlay.replaceChildren();
    for (const s of slotsOf(id)) {
      const d = el(
        "div",
        {
          class: "slot" + (sel.side === id && sel.slot === s.id ? " sel" : ""),
          style: `left:${(s.x / W) * 100}%;top:${(s.y / H) * 100}%;width:${(s.w / W) * 100}%;height:${(s.h / H) * 100}%`,
          onclick: () => {
            sel = { side: id, slot: s.id };
            buildOverlays();
            buildPanel();
          },
        },
        el("span", { class: "tag" }, s.id),
      );
      overlay.append(d);
    }
  }
}

function currentState() {
  return { ...sim, peerBattery: sim.peerUnknown ? -1 : sim.peerBattery };
}

function drawPreviews() {
  const stCentral = currentState();
  // The right half shows its own battery, which the simulator holds as "Batterie rechts".
  const stPeripheral = {
    ...stCentral,
    battery: stCentral.peerBattery < 0 ? 0 : stCentral.peerBattery,
  };
  const ink = design.invert ? [0xdf, 0xe3, 0xd8] : [0x17, 0x19, 0x1c];
  const paper = design.invert ? [0x17, 0x19, 0x1c] : [0xdf, 0xe3, 0xd8];
  for (const { id } of SIDES) {
    const fb = renderSide(
      id,
      sideCfg(id),
      id === "peripheral" ? stPeripheral : stCentral,
      ticks[id],
      design.location,
    );
    const img = new ImageData(W, H);
    for (let i = 0; i < W * H; i++) {
      const c = fb.px[i] ? ink : paper;
      img.data[i * 4] = c[0];
      img.data[i * 4 + 1] = c[1];
      img.data[i * 4 + 2] = c[2];
      img.data[i * 4 + 3] = 255;
    }
    canvases[id].ctx.putImageData(img, 0, 0);
    const timing = animTiming(sideCfg(id));
    const bytes = flashBytes(id);
    canvases[id].meta.textContent =
      (timing.tickMs
        ? `Animation: ${(1000 / timing.tickMs).toFixed(1)} Bilder/s · `
        : "") + (bytes ? `Bilddaten: ${(bytes / 1024).toFixed(1)} KB` : "");
    canvases[id].meta.classList.toggle("warn", bytes > 48 * 1024);
  }
}

function restartTimers() {
  clearInterval(timers.clock);
  if (sim.timeRunning && SIDES.some(({ id }) => timeMode(sideCfg(id)) > 0)) {
    timers.clock = setInterval(() => {
      sim.utc++;
      drawPreviews();
    }, 1000);
  }
  for (const { id } of SIDES) {
    clearInterval(timers[id]);
    const { tickMs } = animTiming(sideCfg(id));
    if (tickMs) {
      timers[id] = setInterval(() => {
        ticks[id]++;
        drawPreviews();
      }, tickMs);
    }
  }
}

function refresh({ structural = false } = {}) {
  normalize();
  if (structural) {
    buildOverlays();
  }
  restartTimers();
  drawPreviews();
  markDirty();
}

// --------------------------------------------------------------------------- panel widgets

function styleRow(cfg, set, options) {
  return row(
    "Darstellung",
    selectEl(options, cfg.style | 0, (v) => set({ style: Number(v) })),
  );
}

function row(label, control, valueText) {
  return el(
    "div",
    { class: "row" },
    el("label", {}, label),
    valueText ? el("div", { class: "inline" }, control, valueText) : control,
  );
}

function selectEl(options, value, onchange) {
  const s = el("select", { onchange: (e) => onchange(e.target.value) });
  for (const [v, label] of options) {
    s.append(
      el(
        "option",
        { value: String(v), selected: String(v) === String(value) },
        label,
      ),
    );
  }
  return s;
}

function rangeEl(min, max, value, oninput, step = 1) {
  const val = el("span", { class: "val" }, String(value));
  const input = el("input", {
    type: "range",
    min,
    max,
    step,
    value,
    oninput: (e) => {
      val.textContent = e.target.value;
      oninput(Number(e.target.value));
    },
  });
  return { input, val };
}

function checkEl(id, checked, onchange, label) {
  return el(
    "span",
    { class: "inline" },
    el("input", {
      type: "checkbox",
      id,
      checked,
      onchange: (e) => onchange(e.target.checked),
    }),
    el("label", { for: id }, label),
  );
}

// --------------------------------------------------------------------------- panel

function buildPanel() {
  const panel = $("#panel");
  panel.replaceChildren(
    layoutSection(),
    slotSection(),
    simSection(),
    locationSection(),
  );
}

function layoutSection() {
  const side = sideCfg(sel.side);
  const hs = bandHeights(side);
  const sec = el(
    "section",
    {},
    el("h3", {}, `Aufteilung – ${sel.side === "central" ? "links" : "rechts"}`),
  );
  const counts = [
    [0, "keine"],
    [1, "1 Slot"],
    [2, "2 Slots"],
    [4, "4 Slots"],
  ];
  for (const [key, label] of [
    ["top", "Oben"],
    ["bottom", "Unten"],
  ]) {
    const band = side[key];
    const heightCtl = rangeEl(12, 100, band.height || 46, (v) => {
      band.height = v;
      if (hs.center < 20) return;
      refresh({ structural: true });
      centerInfo.textContent = `Mitte: ${bandHeights(side).center} px hoch`;
    });
    heightCtl.input.disabled = !band.count;
    sec.append(
      row(
        label,
        selectEl(counts, band.count, (v) => {
          band.count = Number(v);
          if (band.count && !band.height) band.height = 46;
          refresh({ structural: true });
          buildPanel();
        }),
      ),
      row(`${label}-Höhe`, heightCtl.input, heightCtl.val),
    );
  }
  const centerInfo = el(
    "p",
    { class: "hint" },
    `Mitte: ${bandHeights(side).center} px hoch`,
  );
  sec.append(centerInfo);
  return sec;
}

function slotSection() {
  const sideId = sel.side;
  const slot =
    slotsOf(sideId).find((s) => s.id === sel.slot) ?? slotsOf(sideId)[0];
  sel.slot = slot.id;
  const cfg = slotCfg(sideId, slot.id);
  const sec = el(
    "section",
    {},
    el("h3", {}, `Slot ${slot.id} (${slot.w}×${slot.h})`),
  );

  const types = KINDS.filter((k) => widgetAvailable(k, sideId, cfg)).map(
    (k) => [k, TYPE_LABELS[k]],
  );
  sec.append(
    row(
      "Widget",
      selectEl(types, cfg.type || "none", (v) => changeType(sideId, slot, v)),
    ),
  );

  const set = (patch, structural = false) => {
    Object.assign(cfg, patch);
    refresh({ structural });
  };

  switch (cfg.type) {
    case "battery":
      if (sideId === "central") {
        sec.append(
          row(
            "Quelle",
            selectEl(
              [
                ["self", "Diese Hälfte"],
                ["peer", "Andere Hälfte"],
              ],
              cfg.source || "self",
              (v) => set({ source: v }),
            ),
          ),
        );
      }
      sec.append(
        row(
          "Darstellung",
          selectEl(
            [
              [0, "Symbol + Prozent"],
              [1, "Nur Symbol"],
              [2, "Nur Prozent"],
            ],
            cfg.style | 0,
            (v) => set({ style: Number(v) }),
          ),
        ),
      );
      break;
    case "connection":
      if (sideId === "central") {
        sec.append(
          row(
            "Quelle",
            selectEl(
              [
                ["self", "Host (PC / USB)"],
                ["peer", "Andere Hälfte"],
              ],
              cfg.source || "self",
              (v) => set({ source: v }),
            ),
          ),
        );
      }
      sec.append(
        row(
          "Darstellung",
          selectEl(
            [
              [0, "Nur Symbol"],
              [1, "Symbol + Text"],
              [2, "Signalstärke (Balken)"],
              [3, "Balken + dBm"],
            ],
            cfg.style | 0,
            (v) => set({ style: Number(v) }),
          ),
        ),
      );
      if ((cfg.style | 0) >= 2) {
        sec.append(
          el(
            "p",
            { class: "hint" },
            "Gemessen wird der Empfangspegel (RSSI) des letzten Pakets, alle 2 s, solange du tippst. Bei USB-Ausgabe gibt es keine Funkstrecke zum Host, dort steht das USB-Symbol.",
          ),
        );
      }
      break;
    case "clock":
      sec.append(
        styleRow(cfg, set, [
          [0, "Stunden über Minuten (groß)"],
          [1, "HH:MM"],
          [2, "HH:MM:SS"],
        ]),
      );
      break;
    case "date":
      sec.append(
        styleRow(cfg, set, [
          [0, "TT.MM."],
          [1, "Wochentag TT.MM"],
          [2, "TT.MM.JJ"],
          [3, "Kalenderwoche"],
          [4, "Wochentag, Datum, Kalenderwoche"],
        ]),
      );
      break;
    case "analog":
      sec.append(
        styleRow(cfg, set, [
          [0, "Stunden- und Minutenzeiger"],
          [1, "mit Sekundenzeiger"],
        ]),
      );
      break;
    case "wordclock":
      sec.append(
        styleRow(cfg, set, [
          [0, "ohne „ES IST“"],
          [1, "mit „ES IST“"],
        ]),
      );
      break;
    case "binary":
      sec.append(
        styleRow(cfg, set, [
          [0, "Stunden und Minuten"],
          [1, "mit Sekunden"],
        ]),
      );
      break;
    case "moon":
      sec.append(
        styleRow(cfg, set, [
          [0, "nur Mond"],
          [1, "Mond + Beleuchtung in %"],
        ]),
      );
      break;
    case "sun":
      sec.append(
        styleRow(cfg, set, [
          [0, "Aufgang und Untergang"],
          [1, "nur Aufgang"],
          [2, "nur Untergang"],
        ]),
        el(
          "p",
          { class: "hint" },
          "Berechnet aus Datum und Standort (siehe „Standort“ unten). Braucht rund 50 px Breite, also einen ganzen Slot.",
        ),
      );
      break;
    case "stat":
      sec.append(
        row(
          "Wert",
          selectEl(
            [
              ["cpu", "CPU-Last"],
              ["ram", "Arbeitsspeicher"],
              ["temp", "CPU-Temperatur"],
              ["volume", "Lautstärke"],
            ],
            cfg.metric || "cpu",
            (v) => set({ metric: v }),
          ),
        ),
        styleRow(cfg, set, [
          [0, "Wert + Name"],
          [1, "Nur Wert"],
          [2, "Wert + Balken"],
          [3, "Name + Wert + Balken"],
        ]),
        el(
          "p",
          { class: "hint" },
          "Die Werte kommen vom PC-Helper (pc-helper/). Ohne Daten steht „--“ da. Der Balken nutzt die ganze Slot-Breite.",
        ),
      );
      break;
    case "weather":
      sec.append(
        styleRow(cfg, set, [
          [0, "Symbol + Temperatur"],
          [1, "Nur Temperatur"],
          [2, "Symbol + Temperatur + Hoch/Tief"],
        ]),
        el(
          "p",
          { class: "hint" },
          "Das Wetter holt der PC-Helper (Open-Meteo, Standort siehe „Standort“ unten).",
        ),
      );
      break;
    case "layer":
      sec.append(
        row(
          "Darstellung",
          selectEl(
            [
              [0, "Name"],
              [1, "Nummer"],
              [2, "Nummer + Name"],
            ],
            cfg.style | 0,
            (v) => set({ style: Number(v) }),
          ),
        ),
      );
      break;
    case "wpm":
      sec.append(
        row(
          "Darstellung",
          selectEl(
            [
              [0, "Zahl"],
              [1, "Verlauf"],
              [2, "Verlauf + Zahl"],
            ],
            cfg.style | 0,
            (v) => set({ style: Number(v) }),
          ),
        ),
      );
      break;
    case "text":
      sec.append(
        row(
          "Text",
          el("input", {
            type: "text",
            value: cfg.text || "",
            maxlength: 24,
            oninput: (e) =>
              set({ text: e.target.value.replace(/[^\x20-\x7e]/g, "?") }),
          }),
        ),
      );
      sec.append(
        el(
          "p",
          { class: "hint" },
          "Nur ASCII. Bei Platzmangel wird die Schrift verkleinert, danach gekürzt.",
        ),
      );
      break;
    case "image":
      sec.append(imageControls(sideId, slot, cfg));
      break;
    case "anim":
      sec.append(animControls(sideId, slot, cfg));
      break;
  }

  if (
    [
      "battery",
      "connection",
      "profile",
      "layer",
      "wpm",
      "text",
      "clock",
      "date",
      "wordclock",
      "sun",
      "stat",
      "weather",
    ].includes(cfg.type)
  ) {
    sec.append(
      row(
        "Größe",
        selectEl(
          [
            [0, "automatisch"],
            [1, "1×"],
            [2, "2×"],
            [3, "3×"],
            [4, "4×"],
          ],
          cfg.scale | 0,
          (v) => set({ scale: Number(v) }),
        ),
      ),
    );
  }
  if (cfg.type && cfg.type !== "none") {
    sec.append(
      row(
        "Ausrichtung",
        selectEl(
          [
            ["center", "Mitte"],
            ["left", "Links"],
            ["right", "Rechts"],
          ],
          cfg.align || "center",
          (v) => set({ align: v }),
        ),
      ),
    );
    sec.append(
      row(
        "Invertiert",
        checkEl(
          "slot-inv",
          !!cfg.invert,
          (v) => set({ invert: v }),
          "weiß auf schwarz",
        ),
      ),
    );
  }
  return sec;
}

function changeType(sideId, slot, type) {
  const side = sideCfg(sideId);
  const prev = side.slots[slot.id];
  const keep = prev ? { align: prev.align, invert: prev.invert } : {};
  sources.delete(`${sideId}/${slot.id}`);
  if (type === "anim")
    side.slots[slot.id] = { ...makeAnim("pulse", slot.w, slot.h), ...keep };
  else if (type === "battery")
    side.slots[slot.id] = { type, source: "self", style: 0, ...keep };
  else if (type === "text")
    side.slots[slot.id] = { type, text: "TEXT", ...keep };
  else if (type === "stat")
    side.slots[slot.id] = { type, metric: "cpu", style: 0, ...keep };
  else side.slots[slot.id] = { type, ...keep };
  refresh();
  buildPanel();
}

// --------------------------------------------------------------------------- images & animations

function thumbs(frames) {
  const wrap = el("div", { class: "thumbs" });
  for (const f of frames.slice(0, 12)) {
    const c = el("canvas", { width: f.w, height: f.h });
    const ctx = c.getContext("2d");
    const img = new ImageData(f.w, f.h);
    const stride = (f.w + 7) >> 3;
    for (let y = 0; y < f.h; y++) {
      for (let x = 0; x < f.w; x++) {
        const on = (f.bits[y * stride + (x >> 3)] >> (7 - (x & 7))) & 1;
        const o = (y * f.w + x) * 4;
        img.data[o] = img.data[o + 1] = img.data[o + 2] = on ? 0x17 : 0xdf;
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    wrap.append(c);
  }
  if (frames.length > 12)
    wrap.append(el("span", { class: "hint" }, `+${frames.length - 12}`));
  return wrap;
}

function toBitmap(source, w, h, opts) {
  // source: ImageBitmap | HTMLCanvasElement. Fit inside w x h keeping the aspect ratio.
  const sw = source.width;
  const sh = source.height;
  const k = opts.fit === "stretch" ? null : Math.min(w / sw, h / sh);
  const tw = k === null ? w : Math.max(1, Math.round(sw * k));
  const th = k === null ? h : Math.max(1, Math.round(sh * k));
  const c = document.createElement("canvas");
  c.width = tw;
  c.height = th;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, tw, th);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, tw, th);
  const data = ctx.getImageData(0, 0, tw, th).data;
  const lum = new Float32Array(tw * th);
  for (let i = 0; i < tw * th; i++) {
    lum[i] =
      0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }
  const fb = new FB(tw, th);
  if (opts.dither) {
    for (let y = 0; y < th; y++) {
      for (let x = 0; x < tw; x++) {
        const i = y * tw + x;
        const old = lum[i];
        const nw = old < opts.threshold ? 0 : 255;
        const err = old - nw;
        if (x + 1 < tw) lum[i + 1] += (err * 7) / 16;
        if (y + 1 < th) {
          if (x > 0) lum[i + tw - 1] += (err * 3) / 16;
          lum[i + tw] += (err * 5) / 16;
          if (x + 1 < tw) lum[i + tw + 1] += err / 16;
        }
        lum[i] = nw;
      }
    }
  }
  for (let i = 0; i < tw * th; i++) {
    let dark = lum[i] < (opts.dither ? 128 : opts.threshold);
    if (opts.invert) dark = !dark;
    fb.px[i] = dark ? 1 : 0;
  }
  return fbToBitmap(fb);
}

async function decodeFiles(files) {
  const out = [];
  for (const file of files) {
    if (file.type === "image/gif" && typeof ImageDecoder !== "undefined") {
      try {
        const dec = new ImageDecoder({
          data: file.stream(),
          type: "image/gif",
        });
        await dec.tracks.ready;
        const n = dec.tracks.selectedTrack.frameCount;
        for (let i = 0; i < n && out.length < MAX_FRAMES; i++) {
          const { image } = await dec.decode({ frameIndex: i });
          out.push(await createImageBitmap(image));
          image.close();
        }
        continue;
      } catch (_) {
        /* fall through to the single-image path */
      }
    }
    out.push(await createImageBitmap(file));
  }
  return out.slice(0, MAX_FRAMES);
}

function convertSettings(key) {
  const src = sources.get(key);
  return src.opts;
}

function reconvert(sideId, slot, cfg) {
  const key = `${sideId}/${slot.id}`;
  const src = sources.get(key);
  if (!src) return;
  const bmps = src.images.map((im) => toBitmap(im, slot.w, slot.h, src.opts));
  if (cfg.type === "image") cfg.bitmap = bmps[0];
  else cfg.frames = bmps;
}

function conversionControls(sideId, slot, cfg) {
  const key = `${sideId}/${slot.id}`;
  const src = sources.get(key);
  if (!src)
    return el(
      "p",
      { class: "hint" },
      "Schwellwert/Dithering lassen sich nach einem Import hier einstellen.",
    );
  const apply = () => {
    reconvert(sideId, slot, cfg);
    refresh();
    thumbHost.replaceChildren(
      thumbs(cfg.type === "image" ? [cfg.bitmap] : cfg.frames),
    );
  };
  const th = rangeEl(0, 255, src.opts.threshold, (v) => {
    src.opts.threshold = v;
    apply();
  });
  const wrap = el(
    "div",
    {},
    row("Schwellwert", th.input, th.val),
    row(
      "Dithering",
      checkEl(
        "dither",
        src.opts.dither,
        (v) => {
          src.opts.dither = v;
          apply();
        },
        "Floyd–Steinberg",
      ),
    ),
    row(
      "Bild invertieren",
      checkEl(
        "imginv",
        src.opts.invert,
        (v) => {
          src.opts.invert = v;
          apply();
        },
        "hell ↔ dunkel",
      ),
    ),
    row(
      "Anpassen",
      selectEl(
        [
          ["contain", "einpassen"],
          ["stretch", "strecken"],
        ],
        src.opts.fit,
        (v) => {
          src.opts.fit = v;
          apply();
        },
      ),
    ),
  );
  const thumbHost = el("div");
  return el("div", {}, wrap, thumbHost);
}

function imageControls(sideId, slot, cfg) {
  const key = `${sideId}/${slot.id}`;
  const input = el("input", {
    type: "file",
    accept: "image/*",
    onchange: async (e) => {
      const files = [...e.target.files];
      if (!files.length) return;
      try {
        const images = await decodeFiles([files[0]]);
        sources.set(key, {
          images: images.slice(0, 1),
          opts: { threshold: 128, dither: true, invert: false, fit: "contain" },
        });
        reconvert(sideId, slot, cfg);
        refresh();
        buildPanel();
      } catch (err) {
        setStatus("Bild konnte nicht gelesen werden: " + err.message, "err");
      }
    },
  });
  return el(
    "div",
    {},
    row("Datei", input),
    el(
      "p",
      { class: "hint" },
      cfg.bitmap
        ? `Aktuell: ${cfg.bitmap.w}×${cfg.bitmap.h} px (Slot ${slot.w}×${slot.h})`
        : `Noch kein Bild (Slot ${slot.w}×${slot.h}).`,
    ),
    conversionControls(sideId, slot, cfg),
    cfg.bitmap ? thumbs([cfg.bitmap]) : null,
  );
}

function animControls(sideId, slot, cfg) {
  const key = `${sideId}/${slot.id}`;
  const wrap = el("div");
  const gens = Object.entries(GENERATORS).map(([k, g]) => [k, g.label]);
  gens.push(["import", "Eigene Bilder importieren…"]);

  const regenerate = (name, n) => {
    cfg.generator = name;
    cfg.frames = generate(name, slot.w, slot.h, n);
    sources.delete(key);
    refresh();
    buildPanel();
  };

  wrap.append(
    row(
      "Art",
      selectEl(gens, cfg.generator || "import", (v) => {
        if (v === "import") {
          cfg.generator = undefined;
          buildPanel();
        } else {
          regenerate(v, GENERATORS[v].frames);
        }
      }),
    ),
  );

  if (cfg.generator) {
    const n = rangeEl(2, 24, cfg.frames.length, (v) => {
      cfg.frames = generate(cfg.generator, slot.w, slot.h, v);
      refresh();
      refreshThumbs();
    });
    wrap.append(row("Einzelbilder", n.input, n.val));
  } else {
    wrap.append(
      row(
        "Bilder",
        el("input", {
          type: "file",
          accept: "image/*",
          multiple: true,
          onchange: async (e) => {
            const files = [...e.target.files].sort((a, b) =>
              a.name.localeCompare(b.name, undefined, { numeric: true }),
            );
            if (!files.length) return;
            try {
              const images = await decodeFiles(files);
              sources.set(key, {
                images,
                opts: {
                  threshold: 128,
                  dither: true,
                  invert: false,
                  fit: "contain",
                },
              });
              reconvert(sideId, slot, cfg);
              refresh();
              buildPanel();
            } catch (err) {
              setStatus(
                "Bilder konnten nicht gelesen werden: " + err.message,
                "err",
              );
            }
          },
        }),
      ),
    );
    wrap.append(
      el(
        "p",
        { class: "hint" },
        `Mehrere PNG/JPG (nach Dateiname sortiert) oder ein GIF (nur in Browsern mit ImageDecoder). Maximal ${MAX_FRAMES} Bilder, Slot ${slot.w}×${slot.h}.`,
      ),
    );
    wrap.append(conversionControls(sideId, slot, cfg));
  }

  const fps = FPS_PRESETS.map((p) => [p.period, `${p.fps} Bilder/s`]);
  wrap.append(
    row(
      "Tempo",
      selectEl(fps, cfg.period || 1000, (v) => {
        cfg.period = Number(v);
        ticks[sideId] = 0;
        refresh();
      }),
    ),
  );
  wrap.append(
    el(
      "p",
      { class: "hint" },
      "Schnellere Animationen kosten Akku. Sie laufen nur, solange du tippst (Kconfig DISPLAY_DESIGNER_ANIM_ONLY_WHEN_ACTIVE).",
    ),
  );

  const thumbHost = el("div");
  const refreshThumbs = () =>
    thumbHost.replaceChildren(cfg.frames?.length ? thumbs(cfg.frames) : "");
  refreshThumbs();
  wrap.append(thumbHost);
  return wrap;
}

// --------------------------------------------------------------------------- simulator

function locationSection() {
  const loc = design.location;
  const upd = (patch) => {
    design.location = { ...design.location, ...patch };
    drawPreviews();
    markDirty();
  };
  const num = (value, min, max, key) =>
    el("input", {
      type: "number",
      min,
      max,
      step: 0.01,
      value,
      onchange: (e) => {
        const v = Number(e.target.value);
        if (Number.isFinite(v)) upd({ [key]: Math.max(min, Math.min(max, v)) });
      },
    });
  return el(
    "section",
    {},
    el("h3", {}, "Standort (Sonnenzeiten)"),
    row("Breite (°N)", num(loc.lat, -66, 66, "lat")),
    row("Länge (°O)", num(loc.lon, -180, 180, "lon")),
    el(
      "p",
      { class: "hint" },
      "Gilt für beide Hälften und liegt nur in layout.json und in der Firmware. Außerhalb von ±66° gibt es Polartage und -nächte; dort steht „--:--“.",
    ),
  );
}

function simSection() {
  const sec = el(
    "section",
    {},
    el("h3", {}, "Vorschau-Werte (nur Simulation)"),
  );
  const upd = (patch) => {
    Object.assign(sim, patch);
    drawPreviews();
  };
  const bat = rangeEl(0, 100, sim.battery, (v) => upd({ battery: v }));
  const peer = rangeEl(0, 100, sim.peerBattery, (v) => upd({ peerBattery: v }));
  // dBm sliders: 0 would mean "unknown", so the slider covers -100..-30
  const rssiHost = rangeEl(-100, -30, sim.rssiHost || -65, (v) =>
    upd({ rssiHost: v }),
  );
  const rssiLink = rangeEl(-100, -30, sim.rssiLink || -55, (v) =>
    upd({ rssiLink: v }),
  );
  const cpu = rangeEl(0, 100, sim.cpu, (v) => upd({ cpu: v }));
  const ram = rangeEl(0, 100, sim.ram, (v) => upd({ ram: v }));
  const temp = rangeEl(0, 110, sim.temp, (v) => upd({ temp: v }));
  const vol = rangeEl(0, 100, sim.vol, (v) => upd({ vol: v }));
  const wTemp = rangeEl(-40, 50, sim.wTemp, (v) => upd({ wTemp: v }));
  const wHi = rangeEl(-40, 50, sim.wHi, (v) => upd({ wHi: v }));
  const wLo = rangeEl(-40, 50, sim.wLo, (v) => upd({ wLo: v }));
  sec.append(
    row("Batterie", bat.input, bat.val),
    row(
      "Lädt (USB)",
      checkEl("sim-chg", sim.charging, (v) => upd({ charging: v }), ""),
    ),
    row("Batterie rechts", peer.input, peer.val),
    row(
      "",
      checkEl(
        "sim-peer-unk",
        sim.peerUnknown,
        (v) => upd({ peerUnknown: v }),
        "unbekannt",
      ),
    ),
    row(
      "Ausgabe",
      selectEl(
        [
          [TRANSPORT.BLE, "Bluetooth"],
          [TRANSPORT.USB, "USB"],
        ],
        sim.transport,
        (v) => upd({ transport: Number(v) }),
      ),
    ),
    row(
      "BT-Profil",
      selectEl(
        [0, 1, 2, 3, 4].map((i) => [i, String(i + 1)]),
        sim.profile,
        (v) => upd({ profile: Number(v) }),
      ),
    ),
    row(
      "Profil-Status",
      selectEl(
        [
          ["c", "verbunden"],
          ["b", "gekoppelt, getrennt"],
          ["o", "frei (Pairing)"],
        ],
        sim.profileConnected ? "c" : sim.profileBonded ? "b" : "o",
        (v) => upd({ profileConnected: v === "c", profileBonded: v !== "o" }),
      ),
    ),
    row(
      "Funk zur Zentrale",
      checkEl(
        "sim-link",
        sim.linkConnected,
        (v) => upd({ linkConnected: v }),
        "verbunden (rechte Hälfte)",
      ),
    ),
    row(
      "Signal Host",
      checkEl(
        "sim-host-rssi",
        sim.rssiHost !== 0,
        (v) => upd({ rssiHost: v ? -65 : 0 }),
        "Funkverbindung (sonst unbekannt)",
      ),
    ),
    row("", rssiHost.input, rssiHost.val),
    row(
      "Signal Hälfte",
      checkEl(
        "sim-link-rssi",
        sim.rssiLink !== 0,
        (v) => upd({ rssiLink: v ? -55 : 0 }),
        "Funkverbindung (sonst getrennt)",
      ),
    ),
    row("", rssiLink.input, rssiLink.val),
    row("CPU", cpu.input, cpu.val),
    row("RAM", ram.input, ram.val),
    row("CPU-Temp. (°C)", temp.input, temp.val),
    row("Lautstärke", vol.input, vol.val),
    row(
      "",
      checkEl("sim-mute", sim.mute, (v) => upd({ mute: v }), "stumm"),
    ),
    row(
      "Wetter",
      selectEl(
        [
          [-1, "unbekannt"],
          [0, "klar"],
          [1, "teils bewölkt"],
          [2, "bewölkt"],
          [3, "Nebel"],
          [4, "Regen"],
          [5, "Schnee"],
          [6, "Gewitter"],
        ],
        sim.wCond,
        (v) => upd({ wCond: Number(v) }),
      ),
    ),
    row("Temperatur (°C)", wTemp.input, wTemp.val),
    row("Hoch (°C)", wHi.input, wHi.val),
    row("Tief (°C)", wLo.input, wLo.val),
    row(
      "Datum / Uhrzeit",
      el("input", {
        type: "datetime-local",
        step: 1,
        value: new Date((sim.utc + sim.utcOffset * 60) * 1000)
          .toISOString()
          .slice(0, 19),
        onchange: (e) => {
          const t = Date.parse(`${e.target.value}Z`);
          if (!Number.isNaN(t)) upd({ utc: t / 1000 - sim.utcOffset * 60 });
        },
      }),
    ),
    row(
      "UTC-Versatz (min)",
      el("input", {
        type: "number",
        min: -720,
        max: 840,
        step: 15,
        value: sim.utcOffset,
        onchange: (e) => {
          // keep the shown wall-clock time, change the zone
          const local = sim.utc + sim.utcOffset * 60;
          const off = Math.max(-720, Math.min(840, Number(e.target.value) | 0));
          upd({ utcOffset: off, utc: local - off * 60 });
          buildPanel();
        },
      }),
    ),
    row(
      "",
      el(
        "div",
        { class: "inline" },
        checkEl(
          "sim-clock-run",
          sim.timeRunning,
          (v) => {
            sim.timeRunning = v;
            restartTimers();
          },
          "Zeit läuft",
        ),
        el(
          "button",
          {
            onclick: () => {
              upd({
                utc: Math.floor(Date.now() / 1000),
                utcOffset: -new Date().getTimezoneOffset(),
              });
              buildPanel();
            },
          },
          "Jetzt",
        ),
      ),
    ),
    row(
      "Layer-Nr.",
      el("input", {
        type: "number",
        min: 0,
        max: 15,
        value: sim.layerIndex,
        oninput: (e) =>
          upd({
            layerIndex: Math.max(0, Math.min(15, Number(e.target.value) | 0)),
          }),
      }),
    ),
    row(
      "Layer-Name",
      el("input", {
        type: "text",
        value: sim.layerLabel,
        maxlength: 24,
        oninput: (e) =>
          upd({ layerLabel: e.target.value.replace(/[^\x20-\x7e]/g, "?") }),
      }),
    ),
    row(
      "WPM",
      (() => {
        const w = rangeEl(0, 200, sim.wpmNow, (v) => {
          sim.wpmNow = v;
          sim.wpm = [...sim.wpm.slice(1), v];
          drawPreviews();
        });
        return el("div", { class: "inline" }, w.input, w.val);
      })(),
    ),
    row(
      "",
      checkEl(
        "sim-wpm-auto",
        sim.wpmAuto,
        (v) => (sim.wpmAuto = v),
        "WPM automatisch schwanken lassen",
      ),
    ),
  );
  return sec;
}

setInterval(() => {
  if (!sim.wpmAuto) return;
  const last = sim.wpm[WPM_HIST - 1];
  const next = Math.max(
    0,
    Math.min(200, Math.round(last + (Math.random() - 0.45) * 40)),
  );
  sim.wpmNow = next;
  sim.wpm = [...sim.wpm.slice(1), next];
  drawPreviews();
}, 1000);

// --------------------------------------------------------------------------- load / save

function validateDesign(d) {
  if (d && typeof d === "object" && !d.location) {
    d.location = { ...DEFAULT_LOCATION };
  }
  if (!d || d.version !== 1 || !d.sides?.central || !d.sides?.peripheral) {
    throw new Error("Keine gültige layout.json (version 1)");
  }
  for (const s of ["central", "peripheral"]) {
    const side = d.sides[s];
    if (!side.top || !side.bottom || typeof side.slots !== "object")
      throw new Error(`${s}: Struktur unvollständig`);
  }
  return d;
}

function applyDesign(d, { dirtyAfter = false } = {}) {
  design = validateDesign(d);
  sources.clear();
  $("#inv").checked = !!design.invert;
  sel = { side: "central", slot: "C" };
  normalize();
  buildOverlays();
  buildPanel();
  restartTimers();
  drawPreviews();
  if (dirtyAfter) markDirty();
  else {
    dirty = false;
    setStatus("");
  }
}

async function save() {
  return saveDesign();
}

async function saveDesign() {
  let files;
  try {
    files = genAll(design);
  } catch (e) {
    setStatus("Fehler: " + e.message, "err");
    return false;
  }
  try {
    const res = await fetch("/api/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ design, files }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || res.statusText);
    dirty = false;
    setStatus(
      "Gespeichert – mit „Speichern & bauen“ oder ./build-lily58.sh bauen",
      "ok",
    );
    return true;
  } catch (e) {
    setStatus(
      "Speichern fehlgeschlagen: " + e.message + " (läuft serve.py?)",
      "err",
    );
    return false;
  }
}

// --- firmware build (serve.py runs ./build-lily58.sh, we poll its log) ---
let buildPoll = null;
let buildNext = 0;

function buildUi(running, text) {
  $("#buildbox").hidden = false;
  $("#build-state").textContent = text;
  $("#build-cancel").hidden = !running;
  $("#btn-build").disabled = running;
}

function appendLog(lines) {
  if (!lines.length) return;
  const log = $("#build-log");
  const atEnd = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
  log.textContent += lines.join("\n") + "\n";
  if (atEnd) log.scrollTop = log.scrollHeight;
}

async function pollBuild() {
  try {
    const res = await fetch("/api/build?since=" + buildNext);
    const b = await res.json();
    appendLog(b.lines);
    buildNext = b.next;
    if (b.running) {
      buildUi(true, "läuft …");
      buildPoll = setTimeout(pollBuild, 700);
      return;
    }
    buildPoll = null;
    const box = $("#build-files");
    if (b.exit_code === 0) {
      buildUi(false, "– fertig");
      box.replaceChildren(
        "Firmware: ",
        ...b.files.flatMap((f) => [el("code", {}, f), el("br")]),
      );
      setStatus("Build fertig", "ok");
    } else {
      buildUi(false, "– fehlgeschlagen (Exit " + b.exit_code + ")");
      setStatus("Build fehlgeschlagen", "err");
    }
  } catch (e) {
    buildPoll = setTimeout(pollBuild, 2000);
  }
}

async function startBuild() {
  if (!(await saveDesign())) return;
  try {
    const res = await fetch("/api/build", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || res.statusText);
  } catch (e) {
    setStatus("Build konnte nicht starten: " + e.message, "err");
    return;
  }
  $("#build-log").textContent = "";
  $("#build-files").textContent = "";
  buildNext = 0;
  buildUi(true, "läuft …");
  setStatus("Build läuft …");
  clearTimeout(buildPoll);
  pollBuild();
}

function download() {
  const blob = new Blob([JSON.stringify(design)], { type: "application/json" });
  const a = el("a", {
    href: URL.createObjectURL(blob),
    download: "layout.json",
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

$("#btn-save").addEventListener("click", save);
$("#btn-build").addEventListener("click", startBuild);
$("#build-cancel").addEventListener("click", () =>
  fetch("/api/build/cancel", { method: "POST" }),
);
// pick up a build that is already running (e.g. after a page reload)
fetch("/api/build?since=0")
  .then((r) => r.json())
  .then((b) => {
    if (b.running) {
      appendLog(b.lines);
      buildNext = b.next;
      buildUi(true, "läuft …");
      pollBuild();
    }
  })
  .catch(() => {});
$("#btn-download").addEventListener("click", download);
$("#btn-load").addEventListener("click", () => $("#file-load").click());
$("#file-load").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    applyDesign(JSON.parse(await f.text()), { dirtyAfter: true });
  } catch (err) {
    setStatus("Fehler: " + err.message, "err");
  }
  e.target.value = "";
});
$("#btn-reset").addEventListener("click", () => {
  if (confirm("Aktuelles Design verwerfen und das Standard-Design laden?")) {
    applyDesign(defaultDesign(), { dirtyAfter: true });
  }
});
$("#inv").addEventListener("change", (e) => {
  design.invert = e.target.checked;
  drawPreviews();
  markDirty();
});
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "s") {
    e.preventDefault();
    save();
  }
});
window.addEventListener("beforeunload", (e) => {
  if (dirty) e.preventDefault();
});

// --------------------------------------------------------------------------- start

buildPreviews();
try {
  const res = await fetch("/api/layout");
  if (res.ok) design = validateDesign(await res.json());
} catch (_) {
  /* opened without the server: start from the default design */
}
applyDesign(design);
