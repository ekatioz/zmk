# Display Designer

Web tool to design the nice!view screens of both keyboard halves (68×160 px, 1 bit) and turn the
design into firmware. The screen is built from slots, like a watch face: a large centre slot and
1, 2 or 4 slots above and below it. Every slot gets a widget.

```sh
display-designer/serve.py          # opens http://127.0.0.1:8765
```

Click a slot, pick a widget, tweak it, press **In Repo speichern** (Ctrl+S). That writes
`layout.json` (the design) and the generated C sources in `display-module/src/generated/`.

**Speichern & bauen** saves and then runs `../build-lily58.sh -p` (both halves, pristine). The
build log streams into the page and the `.uf2` paths are shown at the end. Only one build runs at a
time; the server accepts nothing but that fixed command. For anything else (one half, incremental)
run the script by hand:

```sh
./build-lily58.sh -p
```

## Widgets

| Widget     | Halves | Shows                                                                                                   |
| ---------- | ------ | ------------------------------------------------------------------------------------------------------- |
| Batterie   | both   | battery of this half; on the left half also of the other half (fetched over the split link)             |
| Verbindung | both   | USB / Bluetooth state (left), link to the left half (right); optionally signal bars / dBm (see below)   |
| BT-Profil  | both   | the active Bluetooth profile 1–5 (filled = connected, dashed = bonded but disconnected, ring = pairing) |
| Layer      | both   | active layer name and/or number                                                                         |
| WPM        | left   | typing speed as number and/or graph                                                                     |
| Text, Bild | both   | static text, an imported picture (converted to 1 bit)                                                   |
| Animation  | both   | a flip-book: built-in generators or your own pictures / GIF                                             |
| Uhrzeit    | both   | digital: hours over minutes, HH:MM or HH:MM:SS                                                          |
| Datum      | both   | DD.MM., weekday, year, ISO calendar week or all stacked                                                 |
| Analog     | both   | analog clock, optionally with a second hand                                                             |
| Wortuhr    | both   | the time in German words ("FUENF VOR HALB DREI")                                                        |
| Binäruhr   | both   | BCD dots for hours, minutes and optionally seconds                                                      |
| Mondphase  | both   | moon disc with the lit part, optionally the illumination in %                                           |
| Sonne      | both   | sunrise and sunset of today for the location set in the designer                                        |

Widgets that need keyboard state the right half does not have (WPM, battery of the other half) are not offered there. Layer and profile are sent to the right half over the link below.
Animations are plain frame sequences; the keyboard only plays them back (2 to 0.5 frames/s) and
pauses them while idle (`CONFIG_DISPLAY_DESIGNER_ANIM_ONLY_WHEN_ACTIVE`).

### Time

The keyboard has no real-time clock. `dd_time.c` keeps the time as a base value plus the uptime since
it was set. It starts at the time of the last `./build-lily58.sh` (good enough while developing, wrong
after every restart) and is set by a message: the left half sends its time to the right half
(`DD_LINK_MSG_TIME`) every time the halves connect. A helper program on the PC will set the real time
later (`dd_time_set()`). The time zone is a plain offset in minutes, so daylight saving time needs a
new sync.

Date, week, moon phase and sun times are calculated on the keyboard (`dd_timecalc.c`, twin of
`lib/timecalc.js`): the moon from the date (accurate to about a day), the sun with the sunrise
equation (accurate to a minute or two) for the location in the designer. Designs with seconds
(HH:MM:SS, second hand, binary seconds) redraw every second while the keyboard is in use, all others
once a minute.

### Signal strength

The connection widget can show 4 signal bars, or bars plus dBm. On the left half it can describe the
link to the host (`Host`) or to the other half (`Andere Hälfte`); on the right half it is the link to
the left half. The value is the RSSI of the last packet on the link, read through the HCI Read RSSI
command (`CONFIG_BT_CTLR_CONN_RSSI`, selected by the module) every 2 s while the keyboard is in use. Bars: >= -60 dBm 4, >= -70 dBm 3, >= -80 dBm 2, weaker 1, unknown 0 (a
disconnected link shows empty bars). With USB output there is no radio link to the host, so the USB
symbol is shown instead. The polling only runs if a design uses it.

### Link between the halves

`display-module/src/dd_link.c` is a small message channel from the left (central) to the right
(peripheral) half, independent of the ZMK split transport. The right half hosts a GATT service with
one write-only characteristic (encrypted link required), the left half discovers it after
connecting and writes messages to it. A message is a one byte id plus up to 19 bytes. The left half
keeps the latest message of every id and sends all of them again whenever the link comes back.

Sending something new: `dd_link_send(ID, data, len)` on the left half, and handle the id in
`link_message_cb()` in `dd_screen.c` on the right half. Ids are defined in `dd_link.h`; so far only
`DD_LINK_MSG_LAYER` and `DD_LINK_MSG_OUTPUT` (active profile) are used. Both halves need this firmware for the link to work.

## How it fits together

```
display-designer/            this tool (tooling only, nothing is compiled from here)
  layout.json                the design
  lib/render.js              reference renderer (used by the preview)
  lib/codegen.js             design -> C
  generate.mjs               layout.json -> display-module/src/generated/ without the browser
  test/run.mjs               compiles dd_render.c natively and checks it draws the same pixels
display-module/              ZMK/Zephyr module with the firmware side
  src/dd_render.c            C twin of render.js (no LVGL)
  src/dd_screen.c            LVGL + ZMK glue: collects state, renders, rotates into the canvas
  src/generated/             generated assets (font, icons) and the two layouts
```

`build-lily58.sh` adds the module (`-DZMK_EXTRA_MODULES`) and builds with
`CONFIG_DISPLAY_DESIGNER=y CONFIG_NICE_VIEW_WIDGET_STATUS=n`, which replaces the stock nice!view
screen. `./build-lily58.sh -p --stock` builds the stock screen with `art.c` instead. Switching
between the two needs a pristine build (`-p`).

## Development

- `node display-designer/test/run.mjs` – JS and C renderers must stay pixel-identical. Run it after
  touching `lib/render.js` or `display-module/src/dd_render.c`; both have to change together.
- Text uses the 8×8 Unscii font (public domain, extracted from LVGL by `gen-font.mjs`), ASCII only.
  Everything is drawn with own primitives instead of LVGL fonts so that the preview is exact.
- Adding a widget: `lib/render.js` (`partsFor`), `display-module/src/dd_render.c` (`build_parts`),
  the `KINDS`/`dd_kind` lists, the panel in `app.js`, and a case in `test/run.mjs`.

## Not done yet

- Phase 3: clock and PC volume, which need a helper program on the PC.
- Not tested on hardware yet: only the firmware build and the renderer comparison have run.
