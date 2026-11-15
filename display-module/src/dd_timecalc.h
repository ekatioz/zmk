/*
 * Calendar, moon and sun maths for the clock widgets. C twin of
 * display-designer/lib/timecalc.js - keep them in sync.
 *
 * SPDX-License-Identifier: MIT
 */

#pragma once

#include <stdbool.h>
#include <stdint.h>

struct dd_datetime {
    int year, month, day;
    int hour, minute, second;
    int weekday; /* 1 = Monday .. 7 = Sunday */
    int yday;    /* 1 .. 366 */
    int week;    /* ISO week */
};

enum dd_sun_status {
    DD_SUN_OK,
    DD_SUN_POLAR_DAY,
    DD_SUN_POLAR_NIGHT,
};

/* a / b rounded half away from zero, for b > 0 */
int dd_rdiv(int a, int b);
int dd_isqrt(int n);

/* utc: seconds since 1970, offset_min: local time minus UTC in minutes */
void dd_datetime_from(uint32_t utc, int offset_min, struct dd_datetime *dt);

/* Moon phase in 1/1024 of a synodic month: 0 new moon, 256 first quarter, 512 full moon. */
int dd_moon_phase(uint32_t utc);

/* Sunrise and sunset of the local day in minutes after local midnight. */
int dd_sun_times(uint32_t utc, int offset_min, int32_t lat_e4, int32_t lon_e4, int *rise_min,
                 int *set_min);

extern const char *const dd_weekdays[7];

/* German time in words; fills `lines` (at most 5) and returns how many there are. */
int dd_word_clock(int hour, int minute, bool with_prefix, const char *lines[5]);
