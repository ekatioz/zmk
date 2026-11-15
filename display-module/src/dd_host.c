/*
 * SPDX-License-Identifier: MIT
 */

#include <string.h>

#include <zephyr/kernel.h>
#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/gatt.h>
#include <zephyr/bluetooth/uuid.h>
#include <zephyr/sys/util.h>

#include <zmk/display.h>

#include "dd_host.h"

#if IS_ENABLED(CONFIG_ZMK_BLE) && (!IS_ENABLED(CONFIG_ZMK_SPLIT) || IS_ENABLED(CONFIG_ZMK_SPLIT_ROLE_CENTRAL))

#define DD_HOST_SVC_UUID BT_UUID_128_ENCODE(0x6d1e4c0a, 0x7a52, 0x4b8e, 0x9b36, 0x3c5f0d8a21e4)
#define DD_HOST_CHR_UUID BT_UUID_128_ENCODE(0x6d1e4c0b, 0x7a52, 0x4b8e, 0x9b36, 0x3c5f0d8a21e4)

static const struct bt_uuid_128 svc_uuid = BT_UUID_INIT_128(DD_HOST_SVC_UUID);
static const struct bt_uuid_128 chr_uuid = BT_UUID_INIT_128(DD_HOST_CHR_UUID);

struct entry {
    uint8_t len;
    bool dirty; /* not delivered to the handler yet */
    uint8_t data[DD_HOST_MAX_PAYLOAD];
};

static struct entry cache[DD_HOST_IDS];
static struct k_spinlock cache_lock;
static dd_host_handler_t handler;

static void deliver_work_cb(struct k_work *work) {
    for (int id = 0; id < DD_HOST_IDS; id++) {
        uint8_t data[DD_HOST_MAX_PAYLOAD];
        uint8_t len = 0;
        dd_host_handler_t h = handler;
        bool deliver = false;

        K_SPINLOCK(&cache_lock) {
            if (h != NULL && cache[id].dirty) {
                len = cache[id].len;
                memcpy(data, cache[id].data, len);
                cache[id].dirty = false;
                deliver = true;
            }
        }
        if (deliver) {
            h(id, data, len);
        }
    }
}

static K_WORK_DEFINE(deliver_work, deliver_work_cb);

static ssize_t write_cb(struct bt_conn *conn, const struct bt_gatt_attr *attr, const void *buf,
                        uint16_t len, uint16_t offset, uint8_t flags) {
    const uint8_t *msg = buf;

    if (offset != 0) {
        return BT_GATT_ERR(BT_ATT_ERR_INVALID_OFFSET);
    }
    if (len < 1 || len > 1 + DD_HOST_MAX_PAYLOAD || msg[0] >= DD_HOST_IDS) {
        return BT_GATT_ERR(BT_ATT_ERR_INVALID_ATTRIBUTE_LEN);
    }
    K_SPINLOCK(&cache_lock) {
        cache[msg[0]].len = len - 1;
        cache[msg[0]].dirty = true;
        memcpy(cache[msg[0]].data, &msg[1], len - 1);
    }
    k_work_submit_to_queue(zmk_display_work_q(), &deliver_work);
    return len;
}

BT_GATT_SERVICE_DEFINE(dd_host_svc, BT_GATT_PRIMARY_SERVICE(&svc_uuid),
                       BT_GATT_CHARACTERISTIC(&chr_uuid.uuid,
                                              BT_GATT_CHRC_WRITE | BT_GATT_CHRC_WRITE_WITHOUT_RESP,
                                              BT_GATT_PERM_WRITE_ENCRYPT, NULL, write_cb, NULL));

void dd_host_set_handler(dd_host_handler_t h) {
    handler = h;
    k_work_submit_to_queue(zmk_display_work_q(), &deliver_work);
}

#else

void dd_host_set_handler(dd_host_handler_t h) {}

#endif
