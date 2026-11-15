/*
 * Generic message channel from the central half to the peripheral half of a split keyboard.
 *
 * It is a small GATT service of its own (the ZMK split transport is left untouched): the
 * peripheral hosts one write-only characteristic, the central discovers it and writes messages
 * to it. A message is a one byte id plus up to DD_LINK_MAX_PAYLOAD bytes of data.
 *
 * The central keeps the latest message of every id and sends all of them again whenever the
 * link comes back, so the peripheral always ends up with the current values.
 *
 * SPDX-License-Identifier: MIT
 */

#pragma once

#include <stdint.h>

#define DD_LINK_IDS 16
#define DD_LINK_MAX_PAYLOAD 19 /* default ATT MTU of 23 bytes minus opcode, handle and id */

/* Message ids. */
#define DD_LINK_MSG_LAYER 1  /* data[0] = layer index, data[1..] = layer name (not terminated) */
#define DD_LINK_MSG_OUTPUT 2 /* data: transport, profile (0-based), connected, bonded */
#define DD_LINK_MSG_TIME 3   /* data: utc (uint32, little endian), utc offset in minutes (int16) */

typedef void (*dd_link_handler_t)(uint8_t id, const uint8_t *data, uint8_t len);

/* Central: stores the message and sends it to the peripheral as soon as the link allows.
 * Peripheral: does nothing. Returns 0, or a negative errno for a bad id or length. */
int dd_link_send(uint8_t id, const void *data, uint8_t len);

/* Peripheral: handler for incoming messages. It runs on the display work queue. Messages that
 * arrived earlier are delivered when the handler is set. Central: does nothing. */
void dd_link_set_handler(dd_link_handler_t handler);

/* Central: called every time the link to the peripheral is usable again, right before the stored
 * messages are sent. Messages that depend on the moment they are sent (the time) are refreshed
 * here. Runs on the system work queue. Peripheral: does nothing. */
void dd_link_set_connect_cb(void (*cb)(void));
