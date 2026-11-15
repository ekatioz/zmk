# PC helper

Sends data from the computer to the keyboard's status screen. The left half hosts a small GATT
service of its own (`display-module/src/dd_host.c`, UUID `6d1e4c0a-7a52-4b8e-9b36-3c5f0d8a21e4`)
with one write characteristic. `dd-helper` (Rust, one binary) writes messages to it over the
Bluetooth connection the keyboard already has to the computer. Writes need the paired (encrypted)
connection, so nothing else can write to it.

The helper sends

- the **time** (UTC plus the local offset), which fixes the clock widgets after each restart of
  the keyboard, and again whenever the keyboard reconnects,
- **CPU load, RAM, CPU temperature and volume/mute** of this computer every 5 s (the volume at
  once when it changes) for the `stat` widgets,
- the **weather** (current temperature, condition, today's high/low from
  [Open-Meteo](https://open-meteo.com), no account needed) every 15 minutes for the `weather`
  widget.

The left half passes everything on to the right half. Values the keyboard has not heard of for 2
minutes (weather: 6 hours) show as `--`.

Sources: `/proc/stat`, `/proc/meminfo`, the `k10temp`/`coretemp` hwmon sensor, `wpctl` (PipeWire;
`pactl` as fallback) and Open-Meteo. The weather needs a location, which is sent to Open-Meteo
with every request - so it is only used if you give it: `--lat 52.52 --lon 13.405`. For the
service put the arguments into `~/.config/dd-helper.env`:

```
DD_HELPER_ARGS="--lat 52.52 --lon 13.405"
```

## Install (Linux)

Needs Rust (`cargo`), BlueZ and a keyboard paired with this computer. The new firmware has to be
flashed on the **left** half first (build button of the designer or `./build-lily58.sh -p`).

```sh
./install.sh        # builds, installs ~/.local/bin/dd-helper and a systemd user service
journalctl --user -u dd-helper -f
```

Or by hand: `cargo build --release`, then `target/release/dd-helper --once` to try it.

```
dd-helper --help            # all options, e.g. --dry-run to see the values without a keyboard
```

The keyboard is found by its Bluetooth name (`--name`, default `Aurora Lily58`) or by `--address`.
Everything is sent at once and whenever the keyboard reconnects. If the keyboard is not connected,
the helper waits until it is. `--list` shows what BlueZ knows, `--dry-run` prints the messages
without sending them.

The helper talks to BlueZ over D-Bus and writes into the connection that exists anyway. It never
connects or disconnects: a library that connects and disconnects (e.g. bleak) drops the keyboard's
connection to the computer on exit, and typing stops for a few seconds.

## Troubleshooting

- *"the keyboard has no display service"*: the left half does not run the new firmware, or BlueZ
  still has the old service list cached. Then `bluetoothctl remove <address>` and pair the keyboard
  again.
- Write errors with "not permitted" / "authentication": the keyboard is connected but not paired
  with this computer.

## Protocol

One write = one message: a byte id followed by up to 31 bytes. Ids are in
`display-module/src/dd_host.h`:

| id | message | data |
| -- | ------- | ---- |
| 1 | time | `uint32` UTC seconds, `int16` offset in minutes, little endian |
| 2 | stats | cpu %, ram %, volume % (`255` = unknown), CPU temperature in C (`int8`, `-128` = unknown), muted |
| 3 | weather | temperature in C (`int8`, `-128` = unknown), condition (0 clear, 1 partly cloudy, 2 cloudy, 3 fog, 4 rain, 5 snow, 6 thunderstorm), high, low |
