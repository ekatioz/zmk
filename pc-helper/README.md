# PC helper

Sends data from the computer to the keyboard's status screen. The left half hosts a small GATT
service of its own (`display-module/src/dd_host.c`, UUID `6d1e4c0a-7a52-4b8e-9b36-3c5f0d8a21e4`)
with one write characteristic. `dd-helper` (Rust, one binary) writes messages to it over the
Bluetooth connection the keyboard already has to the computer. Writes need the paired (encrypted)
connection, so nothing else can write to it.

At the moment the helper sends the **time** (UTC plus the local offset), which fixes the clock
widgets after each restart of the keyboard. The left half passes it on to the right half.

## Install (Linux)

Needs Rust (`cargo`), BlueZ and a keyboard paired with this computer. The new firmware has to be
flashed on the **left** half first (build button of the designer or `./build-lily58.sh -p`).

```sh
./install.sh        # builds, installs ~/.local/bin/dd-helper and a systemd user service
journalctl --user -u dd-helper -f
```

Or by hand: `cargo build --release`, then `target/release/dd-helper --once` to try it.

```
dd-helper [--once] [--list] [--address ADDR] [--name NAME] [--interval SECS] [--retry SECS]
```

The keyboard is found by its Bluetooth name (`--name`, default `Aurora Lily58`) or by `--address`.
The time is sent at once and then every 10 minutes. If the keyboard is not connected, the helper
waits until it is. `--list` shows what BlueZ knows.

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
`display-module/src/dd_host.h`; `1` is the time: `uint32` UTC seconds, `int16` offset in minutes,
both little endian.
