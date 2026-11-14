/*
 * LVGL/ZMK glue for the designer-generated status screen: collects the keyboard state, renders
 * it with dd_render() and shows the result on the nice!view (160x68 landscape, mounted rotated).
 *
 * SPDX-License-Identifier: MIT
 */

#include <zephyr/kernel.h>
#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/hci.h>
#include <zephyr/bluetooth/hci_types.h>
#include <zephyr/sys/byteorder.h>

#include <zephyr/logging/log.h>
LOG_MODULE_DECLARE(zmk, CONFIG_ZMK_LOG_LEVEL);

#include <lvgl.h>

#include <zmk/battery.h>
#include <zmk/display.h>
#include <zmk/event_manager.h>
#include <zmk/events/activity_state_changed.h>
#include <zmk/events/battery_state_changed.h>
#include <zmk/usb.h>
#include <zmk/events/usb_conn_state_changed.h>

#if !IS_ENABLED(CONFIG_ZMK_SPLIT) || IS_ENABLED(CONFIG_ZMK_SPLIT_ROLE_CENTRAL)
#define DD_CENTRAL 1
#include <zmk/ble.h>
#include <zmk/endpoints.h>
#include <zmk/events/ble_active_profile_changed.h>
#include <zmk/events/endpoint_changed.h>
#include <zmk/events/layer_state_changed.h>
#include <zmk/events/wpm_state_changed.h>
#include <zmk/keymap.h>
#include <zmk/wpm.h>
#if IS_ENABLED(CONFIG_ZMK_SPLIT_BLE_CENTRAL_BATTERY_LEVEL_FETCHING)
#include <zmk/split/central.h>
#endif
#else
#define DD_CENTRAL 0
#include <zmk/events/split_peripheral_status_changed.h>
#include <zmk/split/bluetooth/peripheral.h>
#endif

#include "dd_render.h"

extern const struct dd_layout dd_layout;

/* The panel is 160x68 in LVGL coordinates; the designer draws a 68x160 portrait image, which is
 * rotated by 270 degrees into the canvas (same orientation as the stock nice!view widgets). */
#define SCREEN_W DD_H
#define SCREEN_H DD_W
#define CANVAS_COLOR_FORMAT LV_COLOR_FORMAT_L8 /* what the stock widgets use as well */
#define CANVAS_BUF_SIZE                                                                            \
    LV_CANVAS_BUF_SIZE(SCREEN_W, SCREEN_H, LV_COLOR_FORMAT_GET_BPP(CANVAS_COLOR_FORMAT),           \
                       LV_DRAW_BUF_STRIDE_ALIGN)

static uint8_t canvas_buf[CANVAS_BUF_SIZE] __aligned(4);
static uint8_t framebuffer[DD_W * DD_H];
static lv_obj_t *canvas;
static struct dd_state state = {
    .peer_battery = -1,
    .layer_label = "",
};
static uint32_t tick;

/* All of the following runs on the display work queue, so no locking is needed. */
static void redraw(void) {
    if (canvas == NULL) {
        return;
    }
    dd_render(&dd_layout, &state, tick, framebuffer);

    lv_draw_buf_t *buf = lv_canvas_get_draw_buf(canvas);
    uint8_t *dst = buf->data;
    const uint32_t stride = buf->header.stride;
    /* The nice!view panel shows L8 0x00 as light and 0xff as dark (hardware-verified), so
     * this is the opposite of what the designer preview draws for the same setting. */
    const uint8_t ink = dd_layout.invert ? 0x00 : 0xff;
    const uint8_t paper = dd_layout.invert ? 0xff : 0x00;

    for (int y = 0; y < DD_H; y++) {
        for (int x = 0; x < DD_W; x++) {
            dst[x * stride + (DD_H - 1 - y)] = framebuffer[y * DD_W + x] ? ink : paper;
        }
    }
    lv_obj_invalidate(canvas);
}

/* --- Battery of this half ------------------------------------------------ */

struct battery_state {
    uint8_t level;
    bool usb_present;
};

static void battery_update_cb(struct battery_state s) {
    state.battery = s.level;
    state.charging = s.usb_present;
    redraw();
}

static struct battery_state battery_get_state(const zmk_event_t *eh) {
    const struct zmk_battery_state_changed *ev = as_zmk_battery_state_changed(eh);

    return (struct battery_state){
        .level = (ev != NULL) ? ev->state_of_charge : zmk_battery_state_of_charge(),
#if IS_ENABLED(CONFIG_USB_DEVICE_STACK)
        .usb_present = zmk_usb_is_powered(),
#endif
    };
}

ZMK_DISPLAY_WIDGET_LISTENER(dd_battery, struct battery_state, battery_update_cb, battery_get_state)
ZMK_SUBSCRIPTION(dd_battery, zmk_battery_state_changed);
#if IS_ENABLED(CONFIG_USB_DEVICE_STACK)
ZMK_SUBSCRIPTION(dd_battery, zmk_usb_conn_state_changed);
#endif

#if DD_CENTRAL

/* --- Output / BLE profile ------------------------------------------------ */

struct output_state {
    uint8_t transport;
    uint8_t profile;
    bool connected;
    bool bonded;
};

static void output_update_cb(struct output_state s) {
    state.transport = s.transport;
    state.profile = s.profile;
    state.profile_connected = s.connected;
    state.profile_bonded = s.bonded;
    redraw();
}

static struct output_state output_get_state(const zmk_event_t *eh) {
    struct zmk_endpoint_instance ep = zmk_endpoint_get_selected();
    uint8_t transport = DD_TRANSPORT_NONE;
    if (ep.transport == ZMK_TRANSPORT_USB) {
        transport = DD_TRANSPORT_USB;
    } else if (ep.transport == ZMK_TRANSPORT_BLE) {
        transport = DD_TRANSPORT_BLE;
    }
    return (struct output_state){
        .transport = transport,
        .profile = zmk_ble_active_profile_index(),
        .connected = zmk_ble_active_profile_is_connected(),
        .bonded = !zmk_ble_active_profile_is_open(),
    };
}

ZMK_DISPLAY_WIDGET_LISTENER(dd_output, struct output_state, output_update_cb, output_get_state)
ZMK_SUBSCRIPTION(dd_output, zmk_endpoint_changed);
#if IS_ENABLED(CONFIG_USB_DEVICE_STACK)
ZMK_SUBSCRIPTION(dd_output, zmk_usb_conn_state_changed);
#endif
#if defined(CONFIG_ZMK_BLE)
ZMK_SUBSCRIPTION(dd_output, zmk_ble_active_profile_changed);
#endif

/* --- Layer --------------------------------------------------------------- */

struct layer_state {
    zmk_keymap_layer_index_t index;
    const char *label;
};

static void layer_update_cb(struct layer_state s) {
    state.layer_index = s.index;
    state.layer_label = s.label ? s.label : "";
    redraw();
}

static struct layer_state layer_get_state(const zmk_event_t *eh) {
    zmk_keymap_layer_index_t index = zmk_keymap_highest_layer_active();
    return (struct layer_state){
        .index = index,
        .label = zmk_keymap_layer_name(zmk_keymap_layer_index_to_id(index)),
    };
}

ZMK_DISPLAY_WIDGET_LISTENER(dd_layer, struct layer_state, layer_update_cb, layer_get_state)
ZMK_SUBSCRIPTION(dd_layer, zmk_layer_state_changed);

/* --- WPM ----------------------------------------------------------------- */

struct wpm_state {
    uint8_t wpm;
};

static void wpm_update_cb(struct wpm_state s) {
    for (int i = 0; i < DD_WPM_HIST - 1; i++) {
        state.wpm[i] = state.wpm[i + 1];
    }
    state.wpm[DD_WPM_HIST - 1] = s.wpm;
    redraw();
}

static struct wpm_state wpm_get_state(const zmk_event_t *eh) {
    return (struct wpm_state){.wpm = zmk_wpm_get_state()};
}

ZMK_DISPLAY_WIDGET_LISTENER(dd_wpm, struct wpm_state, wpm_update_cb, wpm_get_state)
ZMK_SUBSCRIPTION(dd_wpm, zmk_wpm_state_changed);

/* --- Battery of the other half (fetched by the central) ------------------- */

#if IS_ENABLED(CONFIG_ZMK_SPLIT_BLE_CENTRAL_BATTERY_LEVEL_FETCHING)

struct peer_battery_state {
    int16_t level; /* < 0: unknown */
};

static void peer_battery_update_cb(struct peer_battery_state s) {
    state.peer_battery = s.level;
    redraw();
}

static struct peer_battery_state peer_battery_get_state(const zmk_event_t *eh) {
    const struct zmk_peripheral_battery_state_changed *ev =
        as_zmk_peripheral_battery_state_changed(eh);
    if (ev != NULL) {
        if (ev->source == 0) {
            return (struct peer_battery_state){.level = ev->state_of_charge};
        }
        return (struct peer_battery_state){.level = state.peer_battery};
    }
    uint8_t level = 0;
    if (zmk_split_central_get_peripheral_battery_level(0, &level) == 0) {
        return (struct peer_battery_state){.level = level};
    }
    return (struct peer_battery_state){.level = -1};
}

ZMK_DISPLAY_WIDGET_LISTENER(dd_peer_battery, struct peer_battery_state, peer_battery_update_cb,
                            peer_battery_get_state)
ZMK_SUBSCRIPTION(dd_peer_battery, zmk_peripheral_battery_state_changed);

#endif /* CONFIG_ZMK_SPLIT_BLE_CENTRAL_BATTERY_LEVEL_FETCHING */

#else /* peripheral */

/* --- Link to the central -------------------------------------------------- */

struct link_state {
    bool connected;
};

static void link_update_cb(struct link_state s) {
    state.link_connected = s.connected;
    redraw();
}

static struct link_state link_get_state(const zmk_event_t *eh) {
    return (struct link_state){.connected = zmk_split_bt_peripheral_is_connected()};
}

ZMK_DISPLAY_WIDGET_LISTENER(dd_link, struct link_state, link_update_cb, link_get_state)
ZMK_SUBSCRIPTION(dd_link, zmk_split_peripheral_status_changed);

#endif /* DD_CENTRAL */

/* --- Signal strength ------------------------------------------------------ */

#define RSSI_POLL_MS 2000

static void rssi_work_cb(struct k_work *work);
static K_WORK_DELAYABLE_DEFINE(rssi_work, rssi_work_cb);

struct rssi_scan {
    int8_t link;
    int8_t host;
};

/* RSSI of the last packet received on the connection in dBm, 0 if unknown. */
static int8_t conn_rssi(struct bt_conn *conn) {
    uint16_t handle;
    if (bt_hci_get_conn_handle(conn, &handle) != 0) {
        return 0;
    }
    struct net_buf *buf =
        bt_hci_cmd_create(BT_HCI_OP_READ_RSSI, sizeof(struct bt_hci_cp_read_rssi));
    if (buf == NULL) {
        return 0;
    }
    struct bt_hci_cp_read_rssi *cp = net_buf_add(buf, sizeof(*cp));
    cp->handle = sys_cpu_to_le16(handle);

    struct net_buf *rsp = NULL;
    if (bt_hci_cmd_send_sync(BT_HCI_OP_READ_RSSI, buf, &rsp) != 0 || rsp == NULL) {
        return 0;
    }
    const struct bt_hci_rp_read_rssi *rp = (const void *)rsp->data;
    int8_t rssi = (rp->status == 0) ? rp->rssi : 0;
    net_buf_unref(rsp);
    /* 127 = not available; the controller reports -127 before the first packet arrived */
    return (rssi >= 0 || rssi <= -127) ? 0 : rssi;
}

static void rssi_conn_cb(struct bt_conn *conn, void *data) {
    struct rssi_scan *scan = data;
    struct bt_conn_info info;

    if (bt_conn_get_info(conn, &info) != 0 || info.state != BT_CONN_STATE_CONNECTED) {
        return;
    }
    int8_t rssi = conn_rssi(conn);
#if DD_CENTRAL
    /* We are the central of the link to the other half and the peripheral towards the host. */
    if (info.role == BT_CONN_ROLE_CENTRAL) {
        scan->link = rssi;
    } else {
        scan->host = rssi;
    }
#else
    scan->link = rssi;
#endif
}

static void rssi_work_cb(struct k_work *work) {
    struct rssi_scan scan = {0};

    bt_conn_foreach(BT_CONN_TYPE_LE, rssi_conn_cb, &scan);
    if (scan.link != state.rssi_link || scan.host != state.rssi_host) {
        state.rssi_link = scan.link;
        state.rssi_host = scan.host;
        redraw();
    }
    k_work_reschedule_for_queue(zmk_display_work_q(), &rssi_work, K_MSEC(RSSI_POLL_MS));
}

/* --- Animation ----------------------------------------------------------- */

static void anim_work_cb(struct k_work *work);
static K_WORK_DELAYABLE_DEFINE(anim_work, anim_work_cb);

static void anim_work_cb(struct k_work *work) {
    tick++;
    redraw();
    k_work_reschedule_for_queue(zmk_display_work_q(), &anim_work, K_MSEC(dd_layout.anim_tick_ms));
}

/* Animation and signal polling stop while the keyboard is idle, which saves battery. The last
 * picture stays on screen. */
static int activity_cb(const zmk_event_t *eh) {
    const struct zmk_activity_state_changed *ev = as_zmk_activity_state_changed(eh);
    if (ev == NULL || !zmk_display_is_initialized()) {
        return ZMK_EV_EVENT_BUBBLE;
    }
    const bool active = ev->state == ZMK_ACTIVITY_ACTIVE;

    if (dd_layout.anim_tick_ms != 0 && IS_ENABLED(CONFIG_DISPLAY_DESIGNER_ANIM_ONLY_WHEN_ACTIVE)) {
        if (active) {
            k_work_reschedule_for_queue(zmk_display_work_q(), &anim_work,
                                        K_MSEC(dd_layout.anim_tick_ms));
        } else {
            k_work_cancel_delayable(&anim_work);
        }
    }
    if (dd_layout.rssi) {
        if (active) {
            k_work_reschedule_for_queue(zmk_display_work_q(), &rssi_work, K_NO_WAIT);
        } else {
            k_work_cancel_delayable(&rssi_work);
        }
    }
    return ZMK_EV_EVENT_BUBBLE;
}

ZMK_LISTENER(dd_activity, activity_cb);
ZMK_SUBSCRIPTION(dd_activity, zmk_activity_state_changed);

/* --- Screen -------------------------------------------------------------- */

lv_obj_t *zmk_display_status_screen() {
    lv_obj_t *screen = lv_obj_create(NULL);

    canvas = lv_canvas_create(screen);
    lv_canvas_set_buffer(canvas, canvas_buf, SCREEN_W, SCREEN_H, CANVAS_COLOR_FORMAT);
    lv_obj_align(canvas, LV_ALIGN_TOP_LEFT, 0, 0);

    dd_battery_init();
#if DD_CENTRAL
    dd_output_init();
    dd_layer_init();
    dd_wpm_init();
#if IS_ENABLED(CONFIG_ZMK_SPLIT_BLE_CENTRAL_BATTERY_LEVEL_FETCHING)
    dd_peer_battery_init();
#endif
#else
    dd_link_init();
#endif

    if (dd_layout.anim_tick_ms != 0) {
        k_work_reschedule_for_queue(zmk_display_work_q(), &anim_work,
                                    K_MSEC(dd_layout.anim_tick_ms));
    }
    if (dd_layout.rssi) {
        k_work_reschedule_for_queue(zmk_display_work_q(), &rssi_work, K_MSEC(RSSI_POLL_MS));
    }

    return screen;
}
