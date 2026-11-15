//! The messages the keyboard understands (display-module/src/dd_host.h).

use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{Local, Offset};

pub const MSG_TIME: u8 = 1;
pub const MSG_STATS: u8 = 2;
pub const MSG_WEATHER: u8 = 3;
pub const MAX_PAYLOAD: usize = 31;

pub const UNKNOWN_TEMP: i8 = -128;
pub const UNKNOWN_PERCENT: u8 = 255;

/// MSG_TIME: utc (u32 LE), utc offset in minutes (i16 LE).
pub fn time_message() -> Vec<u8> {
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

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Stats {
    pub cpu: Option<u8>,
    pub ram: Option<u8>,
    /// volume in percent and whether it is muted
    pub volume: Option<(u8, bool)>,
    pub temp: Option<i8>,
}

/// MSG_STATS: cpu %, ram %, volume %, cpu temperature in C, muted.
pub fn stats_message(s: &Stats) -> Vec<u8> {
    let pct = |v: Option<u8>| v.map_or(UNKNOWN_PERCENT, |v| v.min(100));
    let (vol, mute) = s.volume.unwrap_or((UNKNOWN_PERCENT, false));
    vec![
        MSG_STATS,
        pct(s.cpu),
        pct(s.ram),
        if vol == UNKNOWN_PERCENT {
            vol
        } else {
            vol.min(100)
        },
        s.temp.unwrap_or(UNKNOWN_TEMP) as u8,
        mute as u8,
    ]
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Weather {
    pub temp: i8,
    /// 0 clear, 1 partly cloudy, 2 cloudy, 3 fog, 4 rain, 5 snow, 6 thunderstorm
    pub cond: u8,
    pub high: i8,
    pub low: i8,
}

/// MSG_WEATHER: temperature in C, condition, high, low.
pub fn weather_message(w: &Weather) -> Vec<u8> {
    vec![MSG_WEATHER, w.temp as u8, w.cond, w.high as u8, w.low as u8]
}

/// Celsius to the i8 the keyboard understands (rounded, clamped, never the "unknown" value).
pub fn to_i8(celsius: f64) -> i8 {
    celsius.round().clamp(-127.0, 127.0) as i8
}

/// WMO weather interpretation code (Open-Meteo) to the keyboard's condition code.
pub fn condition_from_wmo(code: i64) -> u8 {
    match code {
        0 | 1 => 0,
        2 => 1,
        3 => 2,
        45 | 48 => 3,
        51..=67 | 80..=82 => 4,
        71..=77 | 85 | 86 => 5,
        95..=99 => 6,
        _ => 2,
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
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as u32;
        assert!(now.abs_diff(utc) <= 1);
        let offset = i16::from_le_bytes(m[5..7].try_into().unwrap());
        assert_eq!(
            offset as i32 * 60,
            Local::now().offset().fix().local_minus_utc()
        );
    }

    #[test]
    fn stats_layout() {
        let m = stats_message(&Stats {
            cpu: Some(23),
            ram: Some(61),
            volume: Some((40, true)),
            temp: Some(-5),
        });
        assert_eq!(m, vec![2, 23, 61, 40, (-5i8) as u8, 1]);
        let unknown = stats_message(&Stats {
            cpu: None,
            ram: None,
            volume: None,
            temp: None,
        });
        assert_eq!(unknown, vec![2, 255, 255, 255, 0x80, 0]);
        let over = stats_message(&Stats {
            cpu: Some(200),
            ram: Some(100),
            volume: Some((150, false)),
            temp: None,
        });
        assert_eq!(&over[1..4], &[100, 100, 100]);
    }

    #[test]
    fn weather_layout() {
        let m = weather_message(&Weather {
            temp: -12,
            cond: 5,
            high: -3,
            low: -20,
        });
        assert_eq!(m, vec![3, (-12i8) as u8, 5, (-3i8) as u8, (-20i8) as u8]);
        assert_eq!(to_i8(-128.0), -127);
        assert_eq!(to_i8(14.5), 15);
        assert_eq!(to_i8(-0.4), 0);
    }

    #[test]
    fn wmo_codes() {
        assert_eq!(condition_from_wmo(0), 0);
        assert_eq!(condition_from_wmo(2), 1);
        assert_eq!(condition_from_wmo(3), 2);
        assert_eq!(condition_from_wmo(45), 3);
        assert_eq!(condition_from_wmo(63), 4);
        assert_eq!(condition_from_wmo(81), 4);
        assert_eq!(condition_from_wmo(73), 5);
        assert_eq!(condition_from_wmo(96), 6);
        assert_eq!(condition_from_wmo(1234), 2);
    }
}
