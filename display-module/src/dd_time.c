/*
 * SPDX-License-Identifier: MIT
 */

#include <zephyr/kernel.h>

#include "dd_time.h"

#ifndef DD_BUILD_EPOCH
#define DD_BUILD_EPOCH 1735689600u /* 2025-01-01 00:00 UTC */
#endif
#ifndef DD_BUILD_UTC_OFFSET_MIN
#define DD_BUILD_UTC_OFFSET_MIN 60
#endif

static uint32_t base_utc = DD_BUILD_EPOCH;
static int64_t base_uptime_ms; /* uptime at which the clock showed base_utc */
static int16_t utc_offset_min = DD_BUILD_UTC_OFFSET_MIN;
static struct k_spinlock lock;

void dd_time_set(uint32_t utc, int16_t offset_min) {
    K_SPINLOCK(&lock) {
        base_utc = utc;
        base_uptime_ms = k_uptime_get();
        utc_offset_min = offset_min;
    }
}

uint32_t dd_time_utc(void) {
    uint32_t utc;

    K_SPINLOCK(&lock) { utc = base_utc + (uint32_t)((k_uptime_get() - base_uptime_ms) / 1000); }
    return utc;
}

int16_t dd_time_offset_min(void) {
    int16_t offset;

    K_SPINLOCK(&lock) { offset = utc_offset_min; }
    return offset;
}

uint32_t dd_time_ms_until_next(uint32_t period_s) {
    int64_t now_ms;
    int64_t period_ms = (int64_t)period_s * 1000;

    K_SPINLOCK(&lock) { now_ms = (int64_t)base_utc * 1000 + (k_uptime_get() - base_uptime_ms); }
    return (uint32_t)(period_ms - (now_ms % period_ms));
}
