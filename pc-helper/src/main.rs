//! Sends data from this computer to the keyboard's status screen.
//!
//! The left half of the keyboard hosts a small GATT service (display-module/src/dd_host.c). This
//! program writes messages to its characteristic through BlueZ, over the Bluetooth connection the
//! keyboard already has to this computer. It never connects or disconnects, so typing is not
//! interrupted. Currently it sends the time.

use std::collections::HashMap;
use std::process::ExitCode;
use std::thread::sleep;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use chrono::{Local, Offset};
use zbus::blocking::{fdo::ObjectManagerProxy, Connection};
use zbus::fdo::ManagedObjects;
use zbus::zvariant::{OwnedValue, Value};

// must match display-module/src/dd_host.c / dd_host.h
const HOST_CHR_UUID: &str = "6d1e4c0b-7a52-4b8e-9b36-3c5f0d8a21e4";
const MSG_TIME: u8 = 1;
const MAX_PAYLOAD: usize = 31;

const DEFAULT_NAME: &str = "Aurora Lily58";

const USAGE: &str = "\
dd-helper - sends data from this computer to the keyboard's status screen

USAGE: dd-helper [OPTIONS]

  --once            send once and exit (exit code 1 if that did not work)
  --list            list the Bluetooth devices BlueZ knows and exit
  --address ADDR    Bluetooth address of the keyboard (default: search by name)
  --name NAME       name to search for (default: Aurora Lily58)
  --interval SECS   seconds between two sends (default: 600)
  --retry SECS      seconds to wait while the keyboard is missing (default: 10)
  -h, --help        this text";

struct Args {
    once: bool,
    list: bool,
    address: Option<String>,
    name: String,
    interval: u64,
    retry: u64,
}

fn parse_args() -> Result<Args, String> {
    let mut a = Args {
        once: false,
        list: false,
        address: None,
        name: DEFAULT_NAME.to_string(),
        interval: 600,
        retry: 10,
    };
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        let mut value = |what: &str| it.next().ok_or_else(|| format!("{what} needs a value"));
        match arg.as_str() {
            "--once" => a.once = true,
            "--list" => a.list = true,
            "--address" => a.address = Some(value("--address")?),
            "--name" => a.name = value("--name")?,
            "--interval" => {
                a.interval = value("--interval")?.parse().map_err(|_| "bad --interval")?
            }
            "--retry" => a.retry = value("--retry")?.parse().map_err(|_| "bad --retry")?,
            "-h" | "--help" => {
                println!("{USAGE}");
                std::process::exit(0);
            }
            other => return Err(format!("unknown option {other}\n\n{USAGE}")),
        }
    }
    if a.interval == 0 || a.retry == 0 {
        return Err("--interval and --retry must be at least 1".into());
    }
    Ok(a)
}

/// MSG_TIME: id, utc (u32 LE), utc offset in minutes (i16 LE).
fn time_message() -> Vec<u8> {
    let utc = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as u32;
    let offset_min = (Local::now().offset().fix().local_minus_utc() / 60) as i16;
    let mut msg = vec![MSG_TIME];
    msg.extend_from_slice(&utc.to_le_bytes());
    msg.extend_from_slice(&offset_min.to_le_bytes());
    msg
}

struct Device {
    address: String,
    name: String,
    connected: bool,
    /// D-Bus path of the display characteristic, if the keyboard has it
    chr: Option<String>,
}

fn prop<'a, T>(props: &'a HashMap<String, OwnedValue>, key: &str) -> Option<T>
where
    T: TryFrom<&'a Value<'a>>,
{
    props.get(key).and_then(|v| T::try_from(&**v).ok())
}

fn devices(objects: &ManagedObjects) -> Vec<Device> {
    let mut list = Vec::new();
    for (path, ifaces) in objects {
        let Some(dev) = ifaces.iter().find(|(i, _)| i.as_str() == "org.bluez.Device1") else {
            continue;
        };
        let props = dev.1;
        let path = path.as_str().to_string();
        let name = prop::<&str>(props, "Alias")
            .or_else(|| prop::<&str>(props, "Name"))
            .unwrap_or("?");
        let chr = objects.iter().find_map(|(p, ifaces)| {
            let c = ifaces
                .iter()
                .find(|(i, _)| i.as_str() == "org.bluez.GattCharacteristic1")?;
            let uuid = prop::<&str>(c.1, "UUID")?;
            (p.as_str().starts_with(&format!("{path}/")) && uuid.eq_ignore_ascii_case(HOST_CHR_UUID))
                .then(|| p.as_str().to_string())
        });
        list.push(Device {
            address: prop::<&str>(props, "Address").unwrap_or("?").to_string(),
            name: name.to_string(),
            connected: prop::<bool>(props, "Connected").unwrap_or(false),
            chr,
        });
    }
    list.sort_by(|a, b| a.name.cmp(&b.name));
    list
}

fn managed_objects(conn: &Connection) -> zbus::Result<ManagedObjects> {
    Ok(ObjectManagerProxy::builder(conn)
        .destination("org.bluez")?
        .path("/")?
        .build()?
        .get_managed_objects()?)
}

fn write(conn: &Connection, chr: &str, payload: &[u8]) -> zbus::Result<()> {
    assert!(payload.len() <= 1 + MAX_PAYLOAD);
    let mut options: HashMap<&str, Value> = HashMap::new();
    options.insert("type", Value::from("request"));
    conn.call_method(
        Some("org.bluez"),
        chr,
        Some("org.bluez.GattCharacteristic1"),
        "WriteValue",
        &(payload.to_vec(), options),
    )?;
    Ok(())
}

const NO_SERVICE: &str = "the keyboard has no display service: flash the new firmware to the LEFT half. \
If it is flashed and this stays, BlueZ may have cached the old services: run \
`bluetoothctl remove <address>` and pair the keyboard again.";

/// Whether the keyboard is connected right now (None: cannot tell).
fn connected(conn: &Connection, args: &Args) -> Option<bool> {
    let all = devices(&managed_objects(conn).ok()?);
    let found = all.iter().filter(|d| match &args.address {
        Some(a) => d.address.eq_ignore_ascii_case(a),
        None => d.name == args.name,
    });
    Some(found.into_iter().any(|d| d.connected))
}

enum Outcome {
    Sent,
    Waiting(String),
}

fn try_send(conn: &Connection, args: &Args) -> Result<Outcome, String> {
    let objects = managed_objects(conn).map_err(|e| format!("cannot talk to BlueZ: {e}"))?;
    let all = devices(&objects);
    // with several Bluetooth adapters a device can be listed more than once: take the live one
    let dev = all
        .iter()
        .filter(|d| match &args.address {
            Some(a) => d.address.eq_ignore_ascii_case(a),
            None => d.name == args.name,
        })
        .max_by_key(|d| (d.connected, d.chr.is_some()))
        .ok_or_else(|| {
            format!("keyboard not found in BlueZ (name '{}'); is it paired? see --list", args.name)
        })?;
    if !dev.connected {
        return Ok(Outcome::Waiting(
            "keyboard is not connected to this computer, waiting ...".into(),
        ));
    }
    let Some(chr) = &dev.chr else {
        return Err(NO_SERVICE.replace("<address>", &dev.address));
    };
    write(conn, chr, &time_message()).map_err(|e| format!("write failed: {e}"))?;
    Ok(Outcome::Sent)
}

fn main() -> ExitCode {
    let args = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::from(2);
        }
    };
    let conn = match Connection::system() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("cannot connect to the system D-Bus: {e}");
            return ExitCode::FAILURE;
        }
    };

    if args.list {
        match managed_objects(&conn) {
            Ok(objects) => {
                for d in devices(&objects) {
                    println!(
                        "{}  {}{}{}",
                        d.address,
                        d.name,
                        if d.connected { "  (connected)" } else { "" },
                        if d.chr.is_some() { "  (has the display service)" } else { "" },
                    );
                }
                return ExitCode::SUCCESS;
            }
            Err(e) => {
                eprintln!("cannot talk to BlueZ: {e}");
                return ExitCode::FAILURE;
            }
        }
    }

    // Poll every few seconds: the time is sent as soon as the keyboard (re)connects and then
    // every --interval seconds. A keyboard that restarted has lost the time.
    const POLL_SECS: u64 = 3;
    let mut last_problem = String::new();
    let mut next_send = Instant::now();
    loop {
        if Instant::now() >= next_send {
            match try_send(&conn, &args) {
                Ok(Outcome::Sent) => {
                    last_problem.clear();
                    if args.once {
                        println!("time sent");
                        return ExitCode::SUCCESS;
                    }
                    next_send = Instant::now() + Duration::from_secs(args.interval);
                }
                Ok(Outcome::Waiting(why)) | Err(why) => {
                    if args.once {
                        eprintln!("{why}");
                        return ExitCode::FAILURE;
                    }
                    if why != last_problem {
                        eprintln!("{why}"); // say it once, not every retry
                        last_problem = why;
                    }
                    next_send = Instant::now() + Duration::from_secs(args.retry.min(POLL_SECS));
                }
            }
        } else if connected(&conn, &args) == Some(false) {
            // gone: send as soon as it is back, which the retry above notices
            next_send = Instant::now();
        }
        sleep(Duration::from_secs(POLL_SECS));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn time_message_layout() {
        let m = time_message();
        assert_eq!(m.len(), 7);
        assert_eq!(m[0], MSG_TIME);
        let utc = u32::from_le_bytes(m[1..5].try_into().unwrap());
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as u32;
        assert!(now.abs_diff(utc) <= 1);
        let offset = i16::from_le_bytes(m[5..7].try_into().unwrap());
        assert_eq!(offset as i32 * 60, Local::now().offset().fix().local_minus_utc());
    }
}
