//! Where the values come from: /proc, /sys, PipeWire (or PulseAudio) and Open-Meteo.

use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use crate::proto::{Weather, condition_from_wmo, to_i8};

/// CPU load between two calls.
pub struct Cpu {
    prev: Option<(u64, u64)>, // busy, total
}

impl Cpu {
    pub fn new() -> Self {
        Cpu {
            prev: read_cpu_times(),
        }
    }

    /// Percent of busy time since the last call (None the first time if /proc is unreadable).
    pub fn percent(&mut self) -> Option<u8> {
        let now = read_cpu_times()?;
        let prev = self.prev.replace(now)?;
        let total = now.1.saturating_sub(prev.1);
        if total == 0 {
            return None;
        }
        let busy = now.0.saturating_sub(prev.0);
        Some(((busy * 100 + total / 2) / total).min(100) as u8)
    }
}

fn read_cpu_times() -> Option<(u64, u64)> {
    let stat = fs::read_to_string("/proc/stat").ok()?;
    let line = stat.lines().next()?;
    let v: Vec<u64> = line
        .split_whitespace()
        .skip(1)
        .filter_map(|x| x.parse().ok())
        .collect();
    if v.len() < 5 {
        return None;
    }
    let idle = v[3] + v[4]; // idle + iowait
    let total: u64 = v.iter().take(8).sum(); // guest time is already part of user
    Some((total.saturating_sub(idle), total))
}

pub fn ram_percent() -> Option<u8> {
    let info = fs::read_to_string("/proc/meminfo").ok()?;
    let field = |name: &str| -> Option<u64> {
        info.lines()
            .find(|l| l.starts_with(name))?
            .split_whitespace()
            .nth(1)?
            .parse()
            .ok()
    };
    let total = field("MemTotal:")?;
    let avail = field("MemAvailable:")?;
    if total == 0 {
        return None;
    }
    Some(((total.saturating_sub(avail)) * 100 / total).min(100) as u8)
}

/// The CPU temperature sensor, found once.
pub struct Temp {
    path: Option<PathBuf>,
}

impl Temp {
    pub fn new() -> Self {
        Temp {
            path: find_cpu_temp(),
        }
    }

    pub fn celsius(&self) -> Option<i8> {
        let milli: f64 = fs::read_to_string(self.path.as_ref()?)
            .ok()?
            .trim()
            .parse()
            .ok()?;
        Some(to_i8(milli / 1000.0))
    }
}

fn find_cpu_temp() -> Option<PathBuf> {
    // chip names of the CPU sensors, best first
    const CHIPS: [&str; 3] = ["k10temp", "coretemp", "zenpower"];
    let mut found: Vec<(usize, PathBuf)> = Vec::new();
    for entry in fs::read_dir("/sys/class/hwmon").ok()?.flatten() {
        let dir = entry.path();
        let name = fs::read_to_string(dir.join("name")).unwrap_or_default();
        if let Some(rank) = CHIPS.iter().position(|c| *c == name.trim()) {
            // k10temp: temp1 is Tctl, coretemp: temp1 is the package
            found.push((rank, dir.join("temp1_input")));
        }
    }
    found.sort();
    if let Some((_, p)) = found.into_iter().find(|(_, p)| p.exists()) {
        return Some(p);
    }
    for entry in fs::read_dir("/sys/class/thermal").ok()?.flatten() {
        let dir = entry.path();
        let kind = fs::read_to_string(dir.join("type")).unwrap_or_default();
        if kind.trim() == "x86_pkg_temp" && dir.join("temp").exists() {
            return Some(dir.join("temp"));
        }
    }
    None
}

/// Volume of the default output (percent) and whether it is muted.
pub fn volume() -> Option<(u8, bool)> {
    // PipeWire: "Volume: 0.40" or "Volume: 0.40 [MUTED]"
    if let Some(out) = run("wpctl", &["get-volume", "@DEFAULT_AUDIO_SINK@"]) {
        let rest = out.trim().strip_prefix("Volume:")?.trim().to_string();
        let value: f64 = rest.split_whitespace().next()?.parse().ok()?;
        return Some((
            (value * 100.0).round().clamp(0.0, 100.0) as u8,
            rest.contains("[MUTED]"),
        ));
    }
    // PulseAudio: "Volume: front-left: 26214 /  40% / -23.94 dB, ..."
    let vol = run("pactl", &["get-sink-volume", "@DEFAULT_SINK@"])?;
    let pct: u8 = vol
        .split('%')
        .next()?
        .rsplit(|c: char| !c.is_ascii_digit())
        .next()?
        .parse()
        .ok()?;
    let mute =
        run("pactl", &["get-sink-mute", "@DEFAULT_SINK@"]).is_some_and(|m| m.contains("yes"));
    Some((pct.min(100), mute))
}

fn run(program: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(program).args(args).output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Current weather and today's high/low from Open-Meteo (no account needed).
pub fn weather(lat: f64, lon: f64) -> Result<Weather, String> {
    let url = format!(
        "https://api.open-meteo.com/v1/forecast?latitude={lat:.4}&longitude={lon:.4}\
         &current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min\
         &forecast_days=1&timezone=auto"
    );
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(8)))
        .build()
        .into();
    let json: serde_json::Value = agent
        .get(&url)
        .call()
        .map_err(|e| format!("weather request failed: {e}"))?
        .body_mut()
        .read_json()
        .map_err(|e| format!("weather answer unreadable: {e}"))?;
    parse_weather(&json).ok_or_else(|| "weather answer has an unexpected shape".to_string())
}

fn parse_weather(json: &serde_json::Value) -> Option<Weather> {
    let cur = json.get("current")?;
    let daily = json.get("daily")?;
    Some(Weather {
        temp: to_i8(cur.get("temperature_2m")?.as_f64()?),
        cond: condition_from_wmo(cur.get("weather_code")?.as_i64()?),
        high: to_i8(daily.get("temperature_2m_max")?.get(0)?.as_f64()?),
        low: to_i8(daily.get("temperature_2m_min")?.get(0)?.as_f64()?),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weather_json() {
        let json: serde_json::Value = serde_json::from_str(
            r#"{"current":{"temperature_2m":14.4,"weather_code":61},
                "daily":{"temperature_2m_max":[17.6],"temperature_2m_min":[-2.5]}}"#,
        )
        .unwrap();
        assert_eq!(
            parse_weather(&json),
            Some(Weather {
                temp: 14,
                cond: 4,
                high: 18,
                low: -3
            })
        );
        assert_eq!(parse_weather(&serde_json::json!({})), None);
    }
}
