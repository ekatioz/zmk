/*
 * Wall-clock time of the keyboard. There is no real-time clock, so the time is a base value plus
 * the time that passed since it was set. It starts at the time the firmware was built (good
 * enough for development) and is corrected whenever something sets it, e.g. a helper program on
 * the PC or - on the right half - the left half.
 *
 * SPDX-License-Identifier: MIT
 */

#pragma once

#include <stdint.h>

/* utc: seconds since 1970, offset_min: local time minus UTC in minutes */
void dd_time_set(uint32_t utc, int16_t offset_min);

uint32_t dd_time_utc(void);
int16_t dd_time_offset_min(void);

/* Milliseconds until the next full period_s seconds of UTC time (e.g. 60: next full minute). */
uint32_t dd_time_ms_until_next(uint32_t period_s);
