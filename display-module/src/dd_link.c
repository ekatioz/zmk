/*
 * SPDX-License-Identifier: MIT
 */

#include <string.h>

#include <zephyr/kernel.h>
#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/gatt.h>
#include <zephyr/bluetooth/uuid.h>
#include <zephyr/logging/log.h>
#include <zephyr/sys/util.h>

#include <zmk/display.h>

#include "dd_link.h"

LOG_MODULE_DECLARE(zmk, CONFIG_ZMK_LOG_LEVEL);

#define DD_LINK_SVC_UUID BT_UUID_128_ENCODE(0x1f7c7199, 0xfc2c, 0x4f27, 0x8b80, 0x26960bdff9ff)
#define DD_LINK_CHR_UUID BT_UUID_128_ENCODE(0xe56a8bed, 0x4958, 0x45ca, 0x8593, 0x88af2217c972)

static const struct bt_uuid_128 svc_uuid __maybe_unused = BT_UUID_INIT_128(DD_LINK_SVC_UUID);
static const struct bt_uuid_128 chr_uuid = BT_UUID_INIT_128(DD_LINK_CHR_UUID);

/* Latest message per id. On the central: what is to be (re)sent. On the peripheral: what has
 * arrived. */
struct entry {
    uint8_t len;
    bool valid;
    bool dirty; /* central: not sent yet; peripheral: not delivered to the handler yet */
    uint8_t data[DD_LINK_MAX_PAYLOAD];
};

static struct entry cache[DD_LINK_IDS];
static struct k_spinlock cache_lock;

static void cache_store(uint8_t id, const uint8_t *data, uint8_t len) {
    K_SPINLOCK(&cache_lock) {
        cache[id].len = len;
        cache[id].valid = true;
        cache[id].dirty = true;
        memcpy(cache[id].data, data, len);
    }
}

#if IS_ENABLED(CONFIG_ZMK_SPLIT_BLE) && IS_ENABLED(CONFIG_ZMK_SPLIT_ROLE_CENTRAL)

/* --- Central -------------------------------------------------------------- */

#define RETRY_MS 500
/* ZMK discovers and subscribes to its own split service right after connecting. Doing our own
 * discovery in parallel can make that fail (the halves stay connected, but keys no longer arrive),
 * so we stay away from the connection until ZMK has had plenty of time to finish. */
#define SETTLE_MS 6000

static int64_t connected_at;
static bool announced; /* connect callback called for this connection */
static void (*connect_cb)(void);

static void link_work_cb(struct k_work *work);
static K_WORK_DELAYABLE_DEFINE(link_work, link_work_cb);

static struct bt_conn *peer; /* the connection to the peripheral half (we hold a reference) */
static uint16_t peer_handle; /* value handle of the peripheral's characteristic, 0 = unknown */
static bool discovering;
static struct bt_gatt_discover_params discover_params;

static void find_peer_cb(struct bt_conn *conn, void *data) {
    struct bt_conn_info info;

    if (peer == NULL && bt_conn_get_info(conn, &info) == 0 &&
        info.state == BT_CONN_STATE_CONNECTED && info.role == BT_CONN_ROLE_CENTRAL) {
        peer = bt_conn_ref(conn);
    }
}

static uint8_t discover_cb(struct bt_conn *conn, const struct bt_gatt_attr *attr,
                           struct bt_gatt_discover_params *params) {
    discovering = false;
    if (attr != NULL && conn == peer) {
        const struct bt_gatt_chrc *chrc = attr->user_data;
        peer_handle = chrc->value_handle;
        LOG_DBG("display link: peripheral characteristic at handle %d", peer_handle);
        k_work_reschedule(&link_work, K_NO_WAIT);
    } else {
        /* not found (yet), e.g. an older firmware on the other half */
        k_work_reschedule(&link_work, K_MSEC(2 * RETRY_MS));
    }
    return BT_GATT_ITER_STOP;
}

static void link_work_cb(struct k_work *work) {
    if (peer == NULL) {
        bt_conn_foreach(BT_CONN_TYPE_LE, find_peer_cb, NULL);
        if (peer == NULL) {
            return; /* the connected callback wakes us up */
        }
    }
    int64_t settled_in = connected_at + SETTLE_MS - k_uptime_get();
    if (settled_in > 0) {
        k_work_reschedule(&link_work, K_MSEC(settled_in));
        return;
    }
    if (bt_conn_get_security(peer) < BT_SECURITY_L2) {
        k_work_reschedule(&link_work, K_MSEC(RETRY_MS));
        return;
    }
    if (peer_handle == 0) {
        if (!discovering) {
            discover_params = (struct bt_gatt_discover_params){
                .uuid = &chr_uuid.uuid,
                .func = discover_cb,
                .start_handle = BT_ATT_FIRST_ATTRIBUTE_HANDLE,
                .end_handle = BT_ATT_LAST_ATTRIBUTE_HANDLE,
                .type = BT_GATT_DISCOVER_CHARACTERISTIC,
            };
            /* fails while ZMK is still discovering its own service on this connection */
            if (bt_gatt_discover(peer, &discover_params) == 0) {
                discovering = true;
                return;
            }
        }
        k_work_reschedule(&link_work, K_MSEC(RETRY_MS));
        return;
    }

    if (!announced) {
        announced = true;
        if (connect_cb != NULL) {
            connect_cb();
        }
    }

    for (int id = 0; id < DD_LINK_IDS; id++) {
        uint8_t msg[1 + DD_LINK_MAX_PAYLOAD];
        size_t len = 0;

        K_SPINLOCK(&cache_lock) {
            if (cache[id].valid && cache[id].dirty) {
                msg[0] = id;
                memcpy(&msg[1], cache[id].data, cache[id].len);
                len = 1 + cache[id].len;
            }
        }
        if (len == 0) {
            continue;
        }
        int err = bt_gatt_write_without_response(peer, peer_handle, msg, len, false);
        if (err != 0) {
            LOG_DBG("display link: write failed (%d), retrying", err);
            k_work_reschedule(&link_work, K_MSEC(RETRY_MS));
            return;
        }
        K_SPINLOCK(&cache_lock) {
            /* only clear the flag if nobody changed the value in the meantime */
            if (cache[id].len == len - 1 && memcmp(cache[id].data, &msg[1], len - 1) == 0) {
                cache[id].dirty = false;
            }
        }
    }
}

static void conn_connected(struct bt_conn *conn, uint8_t err) {
    struct bt_conn_info info;

    if (err == 0 && bt_conn_get_info(conn, &info) == 0 && info.role == BT_CONN_ROLE_CENTRAL) {
        connected_at = k_uptime_get();
        k_work_reschedule(&link_work, K_MSEC(SETTLE_MS));
    }
}

static void conn_disconnected(struct bt_conn *conn, uint8_t reason) {
    if (conn == peer) {
        bt_conn_unref(peer);
        peer = NULL;
        peer_handle = 0;
        discovering = false;
        announced = false;
        /* everything has to be sent again after the next connect */
        K_SPINLOCK(&cache_lock) {
            for (int id = 0; id < DD_LINK_IDS; id++) {
                cache[id].dirty = cache[id].valid;
            }
        }
    }
}

BT_CONN_CB_DEFINE(dd_link_conn_cb) = {
    .connected = conn_connected,
    .disconnected = conn_disconnected,
};

int dd_link_send(uint8_t id, const void *data, uint8_t len) {
    if (id >= DD_LINK_IDS || len > DD_LINK_MAX_PAYLOAD) {
        return -EINVAL;
    }
    cache_store(id, data, len);
    k_work_reschedule(&link_work, K_NO_WAIT);
    return 0;
}

void dd_link_set_handler(dd_link_handler_t handler) {}

void dd_link_set_connect_cb(void (*cb)(void)) { connect_cb = cb; }

#elif IS_ENABLED(CONFIG_ZMK_SPLIT_BLE)

/* --- Peripheral ----------------------------------------------------------- */

static dd_link_handler_t handler;

static void deliver_work_cb(struct k_work *work) {
    for (int id = 0; id < DD_LINK_IDS; id++) {
        uint8_t data[DD_LINK_MAX_PAYLOAD];
        uint8_t len = 0;
        dd_link_handler_t h = handler;
        bool deliver = false;

        K_SPINLOCK(&cache_lock) {
            if (h != NULL && cache[id].valid && cache[id].dirty) {
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
    if (len < 1 || len > 1 + DD_LINK_MAX_PAYLOAD || msg[0] >= DD_LINK_IDS) {
        return BT_GATT_ERR(BT_ATT_ERR_INVALID_ATTRIBUTE_LEN);
    }
    cache_store(msg[0], &msg[1], len - 1);
    k_work_submit_to_queue(zmk_display_work_q(), &deliver_work);
    return len;
}

BT_GATT_SERVICE_DEFINE(dd_link_svc, BT_GATT_PRIMARY_SERVICE(&svc_uuid),
                       BT_GATT_CHARACTERISTIC(&chr_uuid.uuid, BT_GATT_CHRC_WRITE_WITHOUT_RESP,
                                              BT_GATT_PERM_WRITE_ENCRYPT, NULL, write_cb, NULL));

int dd_link_send(uint8_t id, const void *data, uint8_t len) { return 0; }

void dd_link_set_connect_cb(void (*cb)(void)) {}

void dd_link_set_handler(dd_link_handler_t h) {
    handler = h;
    k_work_submit_to_queue(zmk_display_work_q(), &deliver_work);
}

#else

/* --- No split ------------------------------------------------------------- */

int dd_link_send(uint8_t id, const void *data, uint8_t len) { return 0; }

void dd_link_set_handler(dd_link_handler_t handler) {}

void dd_link_set_connect_cb(void (*cb)(void)) {}

#endif
