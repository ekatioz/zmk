//! Sends data from this computer to the keyboard's status screen.
//!
//! The left half of the keyboard hosts a small GATT service (display-module/src/dd_host.c). This
//! program writes messages to its characteristic through BlueZ, over the Bluetooth connection the
//! keyboard already has to this computer. It never connects or disconnects, so typing is not
//! interrupted. It sends the time, CPU/RAM/temperature/volume and the weather.

mod proto;
mod sources;

use std::collections::HashMap;
use std::process::ExitCode;
use std::thread::sleep;
use std::time::{Duration, Instant};

use zbus::blocking::{Connection, fdo::ObjectManagerProxy};
use zbus::fdo::ManagedObjects;
use zbus::zvariant::{OwnedValue, Value};

use proto::{MAX_PAYLOAD, Stats, Weather, stats_message, time_message, weather_message};

// must match display-module/src/dd_host.c
const HOST_CHR_UUID: &str = "6d1e4c0b-7a52-4b8e-9b36-3c5f0d8a21e4";

const DEFAULT_NAME: &str = "Aurora Lily58";

const USAGE: &str = "\
dd-helper - sends data from this computer to the keyboard's status screen

USAGE: dd-helper [OPTIONS]

  --once                 send everything once and exit (exit code 1 if that did not work)
  --dry-run              read the values and print the messages, do not talk to the keyboard
  --list                 list the Bluetooth devices BlueZ knows and exit
  --address ADDR         Bluetooth address of the keyboard (default: search by name)
  --name NAME            name to search for (default: Aurora Lily58)
  --lat DEG --lon DEG    location for the weather (without it no weather is sent)
  --interval SECS        seconds between two time messages (default: 600)
  --stats-interval SECS  seconds between two CPU/RAM/temperature messages (default: 5);
                         volume changes are sent at once
  --weather-interval SECS  seconds between two weather updates (default: 900)
  --retry SECS           seconds between searches while the keyboard is missing (default: 10)
  -v, --verbose          print what is sent
  -h, --help             this text";

struct Args {
    once: bool,
    dry_run: bool,
    list: bool,
    verbose: bool,
    address: Option<String>,
    name: String,
    lat: Option<f64>,
    lon: Option<f64>,
    interval: u64,
    stats_interval: u64,
    weather_interval: u64,
    retry: u64,
}

fn parse_args() -> Result<Args, String> {
    let mut a = Args {
        once: false,
        dry_run: false,
        list: false,
        verbose: false,
        address: None,
        name: DEFAULT_NAME.to_string(),
        lat: None,
        lon: None,
        interval: 600,
        stats_interval: 5,
        weather_interval: 900,
        retry: 10,
    };
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        let mut value = |what: &str| it.next().ok_or_else(|| format!("{what} needs a value"));
        let secs = |v: String, what: &str| -> Result<u64, String> {
            v.parse::<u64>()
                .ok()
                .filter(|n| *n > 0)
                .ok_or(format!("bad {what}"))
        };
        match arg.as_str() {
            "--once" => a.once = true,
            "--dry-run" => a.dry_run = true,
            "--list" => a.list = true,
            "-v" | "--verbose" => a.verbose = true,
            "--address" => a.address = Some(value("--address")?),
            "--name" => a.name = value("--name")?,
            "--lat" => a.lat = Some(value("--lat")?.parse().map_err(|_| "bad --lat")?),
            "--lon" => a.lon = Some(value("--lon")?.parse().map_err(|_| "bad --lon")?),
            "--interval" => a.interval = secs(value("--interval")?, "--interval")?,
            "--stats-interval" => {
                a.stats_interval = secs(value("--stats-interval")?, "--stats-interval")?
            }
            "--weather-interval" => {
                a.weather_interval = secs(value("--weather-interval")?, "--weather-interval")?
            }
            "--retry" => a.retry = secs(value("--retry")?, "--retry")?,
            "-h" | "--help" => {
                println!("{USAGE}");
                std::process::exit(0);
            }
            other => return Err(format!("unknown option {other}\n\n{USAGE}")),
        }
    }
    if a.lat.is_some() != a.lon.is_some() {
        return Err("--lat and --lon go together".into());
    }
    if let (Some(lat), Some(lon)) = (a.lat, a.lon) {
        if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lon) {
            return Err("--lat/--lon out of range".into());
        }
    }
    Ok(a)
}

struct Device {
    path: String,
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
        let Some(dev) = ifaces
            .iter()
            .find(|(i, _)| i.as_str() == "org.bluez.Device1")
        else {
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
            (p.as_str().starts_with(&format!("{path}/"))
                && uuid.eq_ignore_ascii_case(HOST_CHR_UUID))
            .then(|| p.as_str().to_string())
        });
        list.push(Device {
            address: prop::<&str>(props, "Address").unwrap_or("?").to_string(),
            name: name.to_string(),
            connected: prop::<bool>(props, "Connected").unwrap_or(false),
            path,
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

/// The keyboard as BlueZ knows it right now: where to write and what to ask about the connection.
struct Target {
    dev: String,
    chr: String,
}

fn discover(conn: &Connection, args: &Args) -> Result<Target, String> {
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
            format!(
                "keyboard not found in BlueZ (name '{}'); is it paired? see --list",
                args.name
            )
        })?;
    if !dev.connected {
        return Err("keyboard is not connected to this computer, waiting ...".into());
    }
    let Some(chr) = &dev.chr else {
        return Err(NO_SERVICE.replace("<address>", &dev.address));
    };
    Ok(Target {
        dev: dev.path.clone(),
        chr: chr.clone(),
    })
}

/// Cheap check of the connection (one small D-Bus call).
fn is_connected(conn: &Connection, t: &Target) -> bool {
    let reply = conn.call_method(
        Some("org.bluez"),
        t.dev.as_str(),
        Some("org.freedesktop.DBus.Properties"),
        "Get",
        &("org.bluez.Device1", "Connected"),
    );
    reply
        .ok()
        .and_then(|m| m.body().deserialize::<OwnedValue>().ok())
        .and_then(|v| bool::try_from(v).ok())
        .unwrap_or(false)
}

fn describe(msg: &[u8]) -> String {
    let hex: Vec<String> = msg.iter().map(|b| format!("{b:02x}")).collect();
    let what = match msg.first() {
        Some(&proto::MSG_TIME) => "time",
        Some(&proto::MSG_STATS) => "stats",
        Some(&proto::MSG_WEATHER) => "weather",
        _ => "?",
    };
    format!("{what}: {}", hex.join(" "))
}

struct Sampler {
    cpu: sources::Cpu,
    temp: sources::Temp,
    last_cpu: Option<u8>,
}

impl Sampler {
    fn new() -> Self {
        Sampler {
            cpu: sources::Cpu::new(),
            temp: sources::Temp::new(),
            last_cpu: None,
        }
    }

    fn stats(&mut self, volume: Option<(u8, bool)>) -> Stats {
        // a very short window gives no CPU value: keep the last one
        if let Some(c) = self.cpu.percent() {
            self.last_cpu = Some(c);
        }
        Stats {
            cpu: self.last_cpu,
            ram: sources::ram_percent(),
            volume,
            temp: self.temp.celsius(),
        }
    }
}

fn fetch_weather(args: &Args) -> Option<Result<Weather, String>> {
    Some(sources::weather(args.lat?, args.lon?))
}

/// --once and --dry-run: everything once.
fn run_once(conn: Option<&Connection>, args: &Args) -> ExitCode {
    let mut sampler = Sampler::new();
    sleep(Duration::from_secs(1)); // a window to measure the CPU load in
    let mut messages = vec![
        time_message(),
        stats_message(&sampler.stats(sources::volume())),
    ];
    match fetch_weather(args) {
        Some(Ok(w)) => messages.push(weather_message(&w)),
        Some(Err(e)) => eprintln!("{e}"),
        None => {}
    }
    let target = match conn {
        Some(conn) => match discover(conn, args) {
            Ok(t) => Some(t),
            Err(e) => {
                eprintln!("{e}");
                return ExitCode::FAILURE;
            }
        },
        None => None,
    };
    for m in &messages {
        println!("{}", describe(m));
        if let (Some(conn), Some(t)) = (conn, &target) {
            if let Err(e) = write(conn, &t.chr, m) {
                eprintln!("write failed: {e}");
                return ExitCode::FAILURE;
            }
        }
    }
    ExitCode::SUCCESS
}

fn run_daemon(conn: &Connection, args: &Args) -> ! {
    let mut sampler = Sampler::new();
    let mut target: Option<Target> = None;
    let mut last_problem = String::new();
    let mut weather: Option<Weather> = None;
    let mut last_volume: Option<Option<(u8, bool)>> = None;
    let now = Instant::now();
    let (mut next_time, mut next_stats, mut next_weather) = (now, now, now);
    let report = |why: String, last: &mut String| {
        if why != *last {
            eprintln!("{why}"); // say it once, not every retry
            *last = why;
        }
    };

    loop {
        if target.as_ref().is_some_and(|t| !is_connected(conn, t)) {
            report(
                "keyboard disconnected, waiting ...".into(),
                &mut last_problem,
            );
            target = None;
        }
        let mut full = false; // (re)connected: the keyboard has lost everything
        if target.is_none() {
            match discover(conn, args) {
                Ok(t) => {
                    eprintln!("keyboard connected");
                    last_problem.clear();
                    target = Some(t);
                    full = true;
                }
                Err(e) => {
                    report(e, &mut last_problem);
                    sleep(Duration::from_secs(args.retry.min(3)));
                    continue;
                }
            }
        }

        let now = Instant::now();
        let volume = sources::volume();
        let mut out: Vec<Vec<u8>> = Vec::new();
        if full || now >= next_time {
            out.push(time_message());
            next_time = now + Duration::from_secs(args.interval);
        }
        if full || last_volume != Some(volume) || now >= next_stats {
            out.push(stats_message(&sampler.stats(volume)));
            last_volume = Some(volume);
            next_stats = now + Duration::from_secs(args.stats_interval);
        }
        let mut weather_fresh = false;
        if now >= next_weather {
            match fetch_weather(args) {
                Some(Ok(w)) => {
                    weather = Some(w);
                    weather_fresh = true;
                    next_weather = now + Duration::from_secs(args.weather_interval);
                }
                Some(Err(e)) => {
                    eprintln!("{e}");
                    next_weather = now + Duration::from_secs(60);
                }
                None => next_weather = now + Duration::from_secs(3600),
            }
        }
        if let (true, Some(w)) = (full || weather_fresh, &weather) {
            out.push(weather_message(w));
        }

        if let Some(t) = &target {
            for m in &out {
                if args.verbose {
                    println!("{}", describe(m));
                }
                if let Err(e) = write(conn, &t.chr, m) {
                    report(format!("write failed: {e}"), &mut last_problem);
                    target = None; // look the keyboard up again
                    break;
                }
            }
        }
        sleep(Duration::from_secs(1));
    }
}

fn main() -> ExitCode {
    let args = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::from(2);
        }
    };
    if args.dry_run {
        return run_once(None, &args);
    }
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
                        if d.chr.is_some() {
                            "  (has the display service)"
                        } else {
                            ""
                        },
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
    if args.once {
        return run_once(Some(&conn), &args);
    }
    run_daemon(&conn, &args)
}
