// Calendar, moon and sun maths for the clock widgets. display-module/src/dd_timecalc.c does the
// same calculations in C; test/run.mjs checks the widgets built on top of both pixel by pixel.
// Everything except the sun times is plain integer arithmetic so that both sides agree exactly.

// sin(2*pi*i/720) * 1000. The firmware gets this table generated from here (cos is sin + 180).
export const SIN720 = Array.from({ length: 720 }, (_, i) =>
  Math.round(1000 * Math.sin((2 * Math.PI * i) / 720)),
);

// a / b rounded half away from zero, for b > 0.
export function rdiv(a, b) {
  return a >= 0
    ? Math.floor((2 * a + b) / (2 * b))
    : -Math.floor((-2 * a + b) / (2 * b));
}

export function isqrt(n) {
  let r = 0;
  while ((r + 1) * (r + 1) <= n) r++;
  return r;
}

function daysFromCivil(y, m, d) {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function weeksInYear(y) {
  const p = (yy) =>
    (yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400)) % 7;
  return 52 + (p(y) === 4 || p(y - 1) === 3 ? 1 : 0);
}

// utc: seconds since 1970-01-01 00:00 UTC, offsetMin: local time minus UTC in minutes.
export function datetimeFrom(utc, offsetMin) {
  const t = utc + offsetMin * 60;
  const days = Math.floor(t / 86400);
  const secs = t - days * 86400;
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe -
      Math.floor(doe / 1460) +
      Math.floor(doe / 36524) -
      Math.floor(doe / 146096)) /
      365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
  const weekday = ((((days + 3) % 7) + 7) % 7) + 1; // 1 = Monday .. 7 = Sunday
  const yday = days - daysFromCivil(year, 1, 1) + 1;
  let week = Math.floor((yday - weekday + 10) / 7);
  if (week < 1) week = weeksInYear(year - 1);
  else if (week > weeksInYear(year)) week = 1;
  return {
    year,
    month,
    day,
    hour: Math.floor(secs / 3600),
    minute: Math.floor((secs % 3600) / 60),
    second: secs % 60,
    weekday,
    yday,
    week,
  };
}

// Moon phase in 1/1024 of a synodic month: 0 new moon, 256 first quarter, 512 full moon.
export function moonPhase(utc) {
  const MONTH = 2551443; // seconds, a bit more than 29.53 days
  const age = (((utc - 947182440) % MONTH) + MONTH) % MONTH; // new moon of 2000-01-06
  return Math.floor((age * 1024) / MONTH);
}

export const SUN_OK = 0;
export const SUN_POLAR_DAY = 1;
export const SUN_POLAR_NIGHT = 2;

const RAD = Math.PI / 180;
const wrap360 = (x) => x - 360 * Math.floor(x / 360);

// Sunrise and sunset of the local day as minutes after local midnight (sunrise equation,
// accurate to a minute or two).
export function sunTimes(utc, offsetMin, latE4, lonE4) {
  const lat = latE4 / 1e4;
  const lon = lonE4 / 1e4;
  const dt = datetimeFrom(utc, offsetMin);
  const n = daysFromCivil(dt.year, dt.month, dt.day) - 10957; // days since J2000 noon
  const jStar = n - lon / 360;
  const m = wrap360(357.5291 + 0.98560028 * jStar);
  const c =
    1.9148 * Math.sin(m * RAD) +
    0.02 * Math.sin(2 * m * RAD) +
    0.0003 * Math.sin(3 * m * RAD);
  const lam = wrap360(m + c + 180 + 102.9372);
  const jTransit =
    2451545 +
    jStar +
    0.0053 * Math.sin(m * RAD) -
    0.0069 * Math.sin(2 * lam * RAD);
  const sinDec = Math.sin(lam * RAD) * Math.sin(23.4397 * RAD);
  const cosDec = Math.sqrt(1 - sinDec * sinDec);
  const cosW =
    (Math.sin(-0.833 * RAD) - Math.sin(lat * RAD) * sinDec) /
    (Math.cos(lat * RAD) * cosDec);
  if (cosW > 1) return { status: SUN_POLAR_NIGHT, rise: 0, set: 0 };
  if (cosW < -1) return { status: SUN_POLAR_DAY, rise: 0, set: 0 };
  const w = Math.acos(cosW) / RAD;
  const toMinutes = (j) => {
    const sec = (j - 2440587.5) * 86400 + offsetMin * 60;
    const day = sec - 86400 * Math.floor(sec / 86400);
    return Math.floor(day / 60 + 0.5) % 1440;
  };
  return {
    status: SUN_OK,
    rise: toMinutes(jTransit - w / 360),
    set: toMinutes(jTransit + w / 360),
  };
}

export const WEEKDAYS = ["MO", "DI", "MI", "DO", "FR", "SA", "SO"];

const HOURS = [
  "ZWOELF",
  "EINS",
  "ZWEI",
  "DREI",
  "VIER",
  "FUENF",
  "SECHS",
  "SIEBEN",
  "ACHT",
  "NEUN",
  "ZEHN",
  "ELF",
];

// German time in words, one string per line, e.g. ["FUENF", "VOR", "HALB", "DREI"].
export function wordClock(hour, minute, withPrefix) {
  const five = Math.floor(minute / 5);
  const h = HOURS[hour % 12];
  const next = HOURS[(hour + 1) % 12];
  const lines = withPrefix ? ["ES IST"] : [];
  switch (five) {
    case 0:
      lines.push(hour % 12 === 1 ? "EIN" : h, "UHR");
      break;
    case 1:
      lines.push("FUENF", "NACH", h);
      break;
    case 2:
      lines.push("ZEHN", "NACH", h);
      break;
    case 3:
      lines.push("VIERTEL", "NACH", h);
      break;
    case 4:
      lines.push("ZWANZIG", "NACH", h);
      break;
    case 5:
      lines.push("FUENF", "VOR", "HALB", next);
      break;
    case 6:
      lines.push("HALB", next);
      break;
    case 7:
      lines.push("FUENF", "NACH", "HALB", next);
      break;
    case 8:
      lines.push("ZWANZIG", "VOR", next);
      break;
    case 9:
      lines.push("VIERTEL", "VOR", next);
      break;
    case 10:
      lines.push("ZEHN", "VOR", next);
      break;
    default:
      lines.push("FUENF", "VOR", next);
  }
  return lines;
}
