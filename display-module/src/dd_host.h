/*
 * Messages from a helper program on the PC to the left (central) half.
 *
 * The left half is the keyboard the PC is paired with, so it hosts one more GATT service of its
 * own (next to the one of dd_link.h): a single write characteristic. The helper connects to the
 * already paired keyboard and writes messages to it. A message is a one byte id plus up to
 * DD_HOST_MAX_PAYLOAD bytes of data. Writes need an encrypted (paired) connection.
 *
 * SPDX-License-Identifier: MIT
 */

#pragma once

#include <stdint.h>

#define DD_HOST_IDS 16
#define DD_HOST_MAX_PAYLOAD 31

/* Message ids. */
#define DD_HOST_MSG_TIME 1 /* data: utc (uint32, little endian), utc offset in minutes (int16) */

typedef void (*dd_host_handler_t)(uint8_t id, const uint8_t *data, uint8_t len);

/* Handler for incoming messages. It runs on the display work queue. Only the latest message of
 * every id is delivered; messages that arrived earlier are delivered when the handler is set.
 * Does nothing on the right half. */
void dd_host_set_handler(dd_host_handler_t handler);
