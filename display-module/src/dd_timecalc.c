/*
 * SPDX-License-Identifier: MIT
 *
 * C twin of display-designer/lib/timecalc.js - see dd_timecalc.h.
 */

#include "dd_timecalc.h"

#include <math.h>

const char *const dd_weekdays[7] = {"MO", "DI", "MI", "DO", "FR", "SA", "SO"};

int dd_rdiv(int a, int b) { return a >= 0 ? (2 * a + b) / (2 * b) : -((-2 * a + b) / (2 * b)); }

int dd_isqrt(int n) {
    int r = 0;
    while ((r + 1) * (r + 1) <= n) {
        r++;
    }
    return r;
}

static int floor_div(int a, int b) {
    int q = a / b;
    return (a % b != 0 && ((a < 0) != (b < 0))) ? q - 1 : q;
}

static int days_from_civil(int y, int m, int d) {
    y -= m <= 2 ? 1 : 0;
    int era = floor_div(y, 400);
    int yoe = y - era * 400;
    int doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
    int doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + doe - 719468;
}

static int weeks_in_year(int y) {
#define P(yy) (((yy) + (yy) / 4 - (yy) / 100 + (yy) / 400) % 7)
    return 52 + ((P(y) == 4 || P(y - 1) == 3) ? 1 : 0);
#undef P
}

void dd_datetime_from(uint32_t utc, int offset_min, struct dd_datetime *dt) {
    int64_t t = (int64_t)utc + (int64_t)offset_min * 60;
    int days = (int)(t / 86400);
    int secs = (int)(t - (int64_t)days * 86400);
    if (secs < 0) {
        secs += 86400;
        days--;
    }
    int z = days + 719468;
    int era = floor_div(z, 146097);
    int doe = z - era * 146097;
    int yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    int doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    int mp = (5 * doy + 2) / 153;
    dt->day = doy - (153 * mp + 2) / 5 + 1;
    dt->month = mp < 10 ? mp + 3 : mp - 9;
    dt->year = yoe + era * 400 + (dt->month <= 2 ? 1 : 0);
    dt->weekday = (((days + 3) % 7) + 7) % 7 + 1;
    dt->yday = days - days_from_civil(dt->year, 1, 1) + 1;
    int week = (dt->yday - dt->weekday + 10) / 7;
    if (week < 1) {
        week = weeks_in_year(dt->year - 1);
    } else if (week > weeks_in_year(dt->year)) {
        week = 1;
    }
    dt->week = week;
    dt->hour = secs / 3600;
    dt->minute = (secs % 3600) / 60;
    dt->second = secs % 60;
}

int dd_moon_phase(uint32_t utc) {
    const int64_t month = 2551443;
    int64_t age = (((int64_t)utc - 947182440) % month + month) % month;
    return (int)(age * 1024 / month);
}

static double wrap360(double x) { return x - 360.0 * floor(x / 360.0); }

int dd_sun_times(uint32_t utc, int offset_min, int32_t lat_e4, int32_t lon_e4, int *rise_min,
                 int *set_min) {
    const double rad = 3.14159265358979323846 / 180.0;
    double lat = lat_e4 / 1e4;
    double lon = lon_e4 / 1e4;
    struct dd_datetime dt;
    dd_datetime_from(utc, offset_min, &dt);
    int n = days_from_civil(dt.year, dt.month, dt.day) - 10957;
    double j_star = n - lon / 360.0;
    double m = wrap360(357.5291 + 0.98560028 * j_star);
    double c = 1.9148 * sin(m * rad) + 0.02 * sin(2 * m * rad) + 0.0003 * sin(3 * m * rad);
    double lam = wrap360(m + c + 180 + 102.9372);
    double j_transit = 2451545.0 + j_star + 0.0053 * sin(m * rad) - 0.0069 * sin(2 * lam * rad);
    double sin_dec = sin(lam * rad) * sin(23.4397 * rad);
    double cos_dec = sqrt(1 - sin_dec * sin_dec);
    double cos_w = (sin(-0.833 * rad) - sin(lat * rad) * sin_dec) / (cos(lat * rad) * cos_dec);
    *rise_min = 0;
    *set_min = 0;
    if (cos_w > 1) {
        return DD_SUN_POLAR_NIGHT;
    }
    if (cos_w < -1) {
        return DD_SUN_POLAR_DAY;
    }
    double w = acos(cos_w) / rad;
    double j[2] = {j_transit - w / 360.0, j_transit + w / 360.0};
    int out[2];
    for (int i = 0; i < 2; i++) {
        double sec = (j[i] - 2440587.5) * 86400.0 + offset_min * 60.0;
        double day = sec - 86400.0 * floor(sec / 86400.0);
        out[i] = (int)floor(day / 60.0 + 0.5) % 1440;
    }
    *rise_min = out[0];
    *set_min = out[1];
    return DD_SUN_OK;
}

static const char *const hours[12] = {"ZWOELF", "EINS",   "ZWEI", "DREI", "VIER", "FUENF",
                                      "SECHS",  "SIEBEN", "ACHT", "NEUN", "ZEHN", "ELF"};

int dd_word_clock(int hour, int minute, bool with_prefix, const char *lines[5]) {
    int n = 0;
    int five = minute / 5;
    const char *h = hours[hour % 12];
    const char *next = hours[(hour + 1) % 12];

    if (with_prefix) {
        lines[n++] = "ES IST";
    }
    switch (five) {
    case 0:
        lines[n++] = hour % 12 == 1 ? "EIN" : h;
        lines[n++] = "UHR";
        break;
    case 1:
        lines[n++] = "FUENF";
        lines[n++] = "NACH";
        lines[n++] = h;
        break;
    case 2:
        lines[n++] = "ZEHN";
        lines[n++] = "NACH";
        lines[n++] = h;
        break;
    case 3:
        lines[n++] = "VIERTEL";
        lines[n++] = "NACH";
        lines[n++] = h;
        break;
    case 4:
        lines[n++] = "ZWANZIG";
        lines[n++] = "NACH";
        lines[n++] = h;
        break;
    case 5:
        lines[n++] = "FUENF";
        lines[n++] = "VOR";
        lines[n++] = "HALB";
        lines[n++] = next;
        break;
    case 6:
        lines[n++] = "HALB";
        lines[n++] = next;
        break;
    case 7:
        lines[n++] = "FUENF";
        lines[n++] = "NACH";
        lines[n++] = "HALB";
        lines[n++] = next;
        break;
    case 8:
        lines[n++] = "ZWANZIG";
        lines[n++] = "VOR";
        lines[n++] = next;
        break;
    case 9:
        lines[n++] = "VIERTEL";
        lines[n++] = "VOR";
        lines[n++] = next;
        break;
    case 10:
        lines[n++] = "ZEHN";
        lines[n++] = "VOR";
        lines[n++] = next;
        break;
    default:
        lines[n++] = "FUENF";
        lines[n++] = "VOR";
        lines[n++] = next;
        break;
    }
    return n;
}
