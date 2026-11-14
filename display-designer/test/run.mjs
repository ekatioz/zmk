#!/usr/bin/env node
// Verifies that the firmware renderer (display-module/src/dd_render.c, compiled natively with
// gcc) draws exactly the same pixels as the JavaScript renderer used by the designer preview.
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  renderSide,
  toAscii,
  defaultState,
  WPM_HIST,
  TRANSPORT,
} from "../lib/render.js";
import { genAssets, genLayout } from "../lib/codegen.js";
import { defaultDesign, makeAnim } from "../lib/defaults.js";
import { generate } from "../lib/anim.js";
import { fbToBitmap } from "../lib/anim.js";
import { FB, drawText } from "../lib/render.js";

const here = dirname(fileURLToPath(import.meta.url));
const modSrc = join(here, "../../display-module/src");

function logo() {
  const fb = new FB(40, 20);
  fb.rect(0, 0, 40, 20, 1);
  drawText(fb, 4, 6, "HI", 1, 0);
  fb.circle(30, 10, 6, 0, false, false);
  return fbToBitmap(fb);
}

const side = (top, bottom, slots) => ({ top, bottom, slots });

const designs = {
  central_default: { side: "central", cfg: defaultDesign().sides.central },
  periph_default: { side: "peripheral", cfg: defaultDesign().sides.peripheral },
  central_all: {
    side: "central",
    cfg: side(
      { count: 4, height: 46 },
      { count: 4, height: 46 },
      {
        T1: { type: "battery", source: "self", style: 1 },
        T2: { type: "battery", source: "peer", style: 2 },
        T3: { type: "connection", style: 0 },
        T4: { type: "profile", scale: 1 },
        C: { type: "wpm", style: 2 },
        B1: { type: "layer", style: 1 },
        B2: { type: "text", text: "HELLO WORLD", align: "left" },
        B3: { type: "wpm", style: 0, invert: true },
        B4: { type: "image", bitmap: logo(), invert: true },
      },
    ),
  },
  central_signal: {
    side: "central",
    cfg: side(
      { count: 2, height: 46 },
      { count: 4, height: 30 },
      {
        T1: { type: "connection", style: 2 },
        T2: { type: "connection", style: 3, source: "peer" },
        C: { type: "connection", style: 3, scale: 2 },
        B1: { type: "connection", style: 0, source: "peer" },
        B2: { type: "connection", style: 1, source: "peer" },
        B3: { type: "connection", style: 2, invert: true, align: "left" },
        B4: { type: "connection", style: 1 },
      },
    ),
  },
  periph_signal: {
    side: "peripheral",
    cfg: side(
      { count: 2, height: 46 },
      { count: 0, height: 0 },
      {
        T1: { type: "connection", style: 2 },
        T2: { type: "connection", style: 3 },
        C: { type: "connection", style: 3, scale: 1, align: "right" },
      },
    ),
  },
  central_big: {
    side: "central",
    cfg: side(
      { count: 1, height: 30 },
      { count: 1, height: 30 },
      {
        T1: { type: "layer", style: 0 },
        C: { type: "profile", scale: 4 },
        B1: {
          type: "battery",
          source: "peer",
          style: 0,
          scale: 2,
          align: "right",
        },
      },
    ),
  },
  central_graph: {
    side: "central",
    cfg: side(
      { count: 2, height: 46 },
      { count: 0, height: 0 },
      {
        T1: { type: "wpm", style: 1 },
        T2: { type: "wpm", style: 2 },
        C: { type: "layer", style: 2, scale: 3, invert: true },
      },
    ),
  },
  central_tiny: {
    side: "central",
    cfg: side(
      { count: 4, height: 12 },
      { count: 2, height: 10 },
      {
        T1: { type: "battery", source: "self", style: 0 },
        T2: { type: "connection", style: 1 },
        T3: { type: "profile" },
        T4: { type: "wpm", style: 1 },
        C: { type: "text", text: "ABCDEFGHIJKLMNOPQRSTUVWXYZ", scale: 2 },
        B1: { type: "layer", style: 2 },
        B2: { type: "connection", style: 0 },
      },
    ),
  },
  periph_all: {
    side: "peripheral",
    cfg: side(
      { count: 2, height: 40 },
      { count: 4, height: 50 },
      {
        T1: { type: "battery", source: "self", style: 0, scale: 2 },
        T2: { type: "connection", style: 0 },
        C: {
          type: "anim",
          frames: generate("equalizer", 50, 40, 4),
          period: 500,
        },
        B1: { type: "layer", style: 2, scale: 2, align: "right" },
        B2: { type: "image", bitmap: logo(), align: "left" },
        B3: {
          type: "anim",
          frames: generate("spinner", 30, 20, 3),
          period: 250,
        },
        B4: { type: "connection", style: 1, invert: true },
      },
    ),
  },
};

function mkWpm(f) {
  return Array.from({ length: WPM_HIST }, (_, i) => f(i));
}

const states = [
  defaultState(),
  {
    ...defaultState(),
    battery: 7,
    charging: true,
    peerBattery: -1,
    transport: TRANSPORT.USB,
    profile: 3,
    profileConnected: false,
    profileBonded: true,
    linkConnected: false,
    rssiLink: 0,
    rssiHost: 0,
    layerIndex: 4,
    layerLabel: "",
    wpm: mkWpm((i) => (i * 37) % 120),
  },
  {
    ...defaultState(),
    battery: 55,
    peerBattery: 100,
    transport: TRANSPORT.BLE,
    profile: 1,
    profileConnected: false,
    profileBonded: false,
    rssiLink: -75,
    rssiHost: -88,
    layerIndex: 2,
    layerLabel: "SYMBOLS_AND_NUMBERS_LAYER",
    wpm: mkWpm((i) => (i < 12 ? 20 + i * 15 : 200 - i * 4)),
  },
  {
    ...defaultState(),
    battery: 0,
    peerBattery: 3,
    rssiLink: -95,
    rssiHost: -62,
    layerIndex: 10,
    layerLabel: "NAV",
    wpm: mkWpm((i) => (i === WPM_HIST - 1 ? 188 : 0)),
  },
];
const TICKS = [0, 1, 2, 5];

function cString(s) {
  return '"' + s.replace(/[\\"]/g, "\\$&") + '"';
}

function stateC(st) {
  return (
    `{.battery = ${st.battery}, .charging = ${st.charging}, .peer_battery = ${st.peerBattery}, ` +
    `.transport = ${st.transport}, .profile = ${st.profile}, ` +
    `.profile_connected = ${st.profileConnected}, .profile_bonded = ${st.profileBonded}, ` +
    `.link_connected = ${st.linkConnected}, .rssi_link = ${st.rssiLink}, ` +
    `.rssi_host = ${st.rssiHost}, .layer_index = ${st.layerIndex}, ` +
    `.layer_label = ${cString(st.layerLabel)}, .wpm = {${st.wpm.join(", ")}}}`
  );
}

const harness = `
#include <stdio.h>
#include "dd_render.h"
extern const struct dd_layout dd_layout;
static const struct dd_state states[] = {
${states.map((s) => "    " + stateC(s) + ",").join("\n")}
};
static const unsigned ticks[] = {${TICKS.join(", ")}};
int main(void) {
    static uint8_t fb[DD_W * DD_H];
    for (unsigned s = 0; s < sizeof(states) / sizeof(states[0]); s++) {
        for (unsigned t = 0; t < sizeof(ticks) / sizeof(ticks[0]); t++) {
            dd_render(&dd_layout, &states[s], ticks[t], fb);
            printf("== state %u tick %u\\n", s, ticks[t]);
            for (int y = 0; y < DD_H; y++) {
                for (int x = 0; x < DD_W; x++) putchar(fb[y * DD_W + x] ? '#' : '.');
                putchar('\\n');
            }
        }
    }
    return 0;
}
`;

const tmp = join(tmpdir(), `dd-test-${process.pid}`);
mkdirSync(tmp, { recursive: true });
writeFileSync(
  join(tmp, "dd_assets.c"),
  genAssets().replace('"../dd_render.h"', '"dd_render.h"'),
);
writeFileSync(join(tmp, "harness.c"), harness);

let failed = 0;
for (const [name, { side: sideName, cfg }] of Object.entries(designs)) {
  const design = { invert: false, sides: { central: cfg, peripheral: cfg } };
  writeFileSync(
    join(tmp, `layout_${name}.c`),
    genLayout(sideName, design).replace('"../dd_render.h"', '"dd_render.h"'),
  );
  const exe = join(tmp, name);
  execFileSync(
    "gcc",
    [
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-O1",
      "-I",
      modSrc,
      "-o",
      exe,
      join(modSrc, "dd_render.c"),
      join(tmp, "dd_assets.c"),
      join(tmp, `layout_${name}.c`),
      join(tmp, "harness.c"),
    ],
    { stdio: "inherit" },
  );
  const cOut = execFileSync(exe, { maxBuffer: 1 << 28 }).toString();

  let jsOut = "";
  states.forEach((st, si) => {
    for (const t of TICKS) {
      jsOut +=
        `== state ${si} tick ${t}\n` +
        toAscii(renderSide(sideName, cfg, st, t)) +
        "\n";
    }
  });

  if (cOut === jsOut) {
    console.log(`ok    ${name}`);
  } else {
    failed++;
    const a = cOut.split("\n");
    const b = jsOut.split("\n");
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    let hdr = i;
    while (hdr > 0 && !a[hdr].startsWith("==")) hdr--;
    console.log(
      `FAIL  ${name}: first difference at line ${i} (${a[hdr]}, row ${i - hdr - 1})`,
    );
    console.log("  C : " + a[i]);
    console.log("  JS: " + b[i]);
    writeFileSync(join(tmp, `${name}.c.txt`), cOut);
    writeFileSync(join(tmp, `${name}.js.txt`), jsOut);
    console.log(`  dumps: ${tmp}/${name}.{c,js}.txt`);
  }
}
if (!failed) rmSync(tmp, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
