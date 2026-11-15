/*
 * SPDX-License-Identifier: MIT
 *
 * C twin of display-designer/lib/render.js - see dd_render.h.
 */

#include "dd_render.h"
#include "dd_timecalc.h"

#include <stdio.h>
#include <string.h>

struct ctx {
    uint8_t *fb;
    int cx0, cy0, cx1, cy1; /* clip rect, end exclusive */
    uint8_t fg, bg;
};

static void set_px(struct ctx *c, int x, int y, uint8_t v) {
    if (x < c->cx0 || y < c->cy0 || x >= c->cx1 || y >= c->cy1) {
        return;
    }
    c->fb[y * DD_W + x] = v;
}

static void fill_rect(struct ctx *c, int x, int y, int w, int h, uint8_t v) {
    for (int j = 0; j < h; j++) {
        for (int i = 0; i < w; i++) {
            set_px(c, x + i, y + j, v);
        }
    }
}

static void hline(struct ctx *c, int x0, int x1, int y, uint8_t v) {
    for (int x = x0; x <= x1; x++) {
        set_px(c, x, y, v);
    }
}

static int iabs(int v) { return v < 0 ? -v : v; }

static void line(struct ctx *c, int x0, int y0, int x1, int y1, uint8_t v) {
    int dx = iabs(x1 - x0);
    int dy = -iabs(y1 - y0);
    int sx = x0 < x1 ? 1 : -1;
    int sy = y0 < y1 ? 1 : -1;
    int err = dx + dy;
    for (;;) {
        set_px(c, x0, y0, v);
        if (x0 == x1 && y0 == y1) {
            break;
        }
        int e2 = 2 * err;
        if (e2 >= dy) {
            err += dy;
            x0 += sx;
        }
        if (e2 <= dx) {
            err += dx;
            y0 += sy;
        }
    }
}

static void plot_dash(struct ctx *c, int x, int y, uint8_t v, bool dashed) {
    if (dashed && ((x + y) & 3) >= 2) {
        return;
    }
    set_px(c, x, y, v);
}

static void circle(struct ctx *c, int cx, int cy, int r, uint8_t v, bool filled, bool dashed) {
    int x = r;
    int y = 0;
    int err = 1 - r;
    while (x >= y) {
        if (filled) {
            hline(c, cx - x, cx + x, cy + y, v);
            hline(c, cx - x, cx + x, cy - y, v);
            hline(c, cx - y, cx + y, cy + x, v);
            hline(c, cx - y, cx + y, cy - x, v);
        } else {
            plot_dash(c, cx + x, cy + y, v, dashed);
            plot_dash(c, cx - x, cy + y, v, dashed);
            plot_dash(c, cx + x, cy - y, v, dashed);
            plot_dash(c, cx - x, cy - y, v, dashed);
            plot_dash(c, cx + y, cy + x, v, dashed);
            plot_dash(c, cx - y, cy + x, v, dashed);
            plot_dash(c, cx + y, cy - x, v, dashed);
            plot_dash(c, cx - y, cy - x, v, dashed);
        }
        y++;
        if (err < 0) {
            err += 2 * y + 1;
        } else {
            x--;
            err += 2 * (y - x) + 1;
        }
    }
}

static void draw_text(struct ctx *c, int x, int y, const char *str, int s, uint8_t v) {
    for (int i = 0; str[i]; i++) {
        unsigned char ch = (unsigned char)str[i];
        if (ch < 32 || ch > 127) {
            ch = '?';
        }
        const uint8_t *rows = dd_font8[ch - 32];
        for (int r = 0; r < 8; r++) {
            for (int col = 0; col < 8; col++) {
                if (rows[r] & (0x80 >> col)) {
                    fill_rect(c, x + i * 8 * s + col * s, y + r * s, s, s, v);
                }
            }
        }
    }
}

static void draw_bitmap(struct ctx *c, const struct dd_bitmap *bmp, int x, int y, int s,
                        bool opaque) {
    int stride = (bmp->w + 7) >> 3;
    for (int j = 0; j < bmp->h; j++) {
        for (int i = 0; i < bmp->w; i++) {
            int on = (bmp->bits[j * stride + (i >> 3)] >> (7 - (i & 7))) & 1;
            if (on) {
                fill_rect(c, x + i * s, y + j * s, s, s, c->fg);
            } else if (opaque) {
                fill_rect(c, x + i * s, y + j * s, s, s, c->bg);
            }
        }
    }
}

/* ------------------------------------------------------------------------- */
/* Parts: a widget is a vertical stack of parts for a given scale. */

enum part_type { P_TEXT, P_ICON, P_BATTERY, P_PROFILE, P_BARS, P_ICONTEXT };

#define TEXT_MAX 24
#define MAX_PARTS 6

struct part {
    uint8_t type;
    int w, h;
    int s;
    char text[TEXT_MAX];
    const struct dd_bitmap *icon;
    bool slash;
    bool bolt;    /* battery: charging bolt next to the icon */
    bool unknown; /* battery: level not known */
    int level;
};

static struct part text_part(const char *str, int s, int max_w) {
    struct part p = {.type = P_TEXT, .s = s};
    size_t len = strlen(str);
    if (len > TEXT_MAX - 1) {
        len = TEXT_MAX - 1;
    }
    memcpy(p.text, str, len);
    p.text[len] = '\0';
    if (s == 1 && (int)len * 8 > max_w) {
        int n = max_w >> 3;
        if (n <= 0) {
            p.text[0] = '\0';
        } else if (n == 1) {
            p.text[1] = '\0';
        } else {
            p.text[n - 1] = '.';
            p.text[n] = '\0';
        }
    }
    p.w = (int)strlen(p.text) * 8 * s;
    p.h = 8 * s;
    return p;
}

/* an icon with a short text to its right */
static struct part icontext_part(const struct dd_bitmap *icon, const char *str, int s, int max_w) {
    struct part t = text_part(str, s, max_w);
    struct part p = {.type = P_ICONTEXT, .s = s, .icon = icon};
    memcpy(p.text, t.text, sizeof(p.text));
    p.w = icon->w * s + s + t.w;
    p.h = icon->h * s > t.h ? icon->h * s : t.h;
    return p;
}

static struct part icon_part(const struct dd_bitmap *icon, int s, bool slash) {
    return (struct part){
        .type = P_ICON, .s = s, .icon = icon, .slash = slash, .w = icon->w * s, .h = icon->h * s};
}

static struct part battery_part(int level, int s, bool unknown, bool bolt) {
    struct part p = {.type = P_BATTERY, .s = s, .level = level, .unknown = unknown, .bolt = bolt};
    p.w = 22 * s;
    p.h = 9 * s;
    if (bolt) {
        p.w += dd_icon_bolt.w * s + s;
        if (dd_icon_bolt.h * s > p.h) {
            p.h = dd_icon_bolt.h * s;
        }
    }
    return p;
}

static int rssi_bars(int rssi) {
    if (rssi == 0) {
        return 0;
    }
    if (rssi >= -60) {
        return 4;
    }
    if (rssi >= -70) {
        return 3;
    }
    return rssi >= -80 ? 2 : 1;
}

static struct part bars_part(int rssi, int s) {
    return (struct part){.type = P_BARS, .s = s, .level = rssi_bars(rssi), .w = 11 * s, .h = 8 * s};
}

static struct part profile_part(int s) {
    int d = 2 * (6 * s) + 1;
    return (struct part){.type = P_PROFILE, .s = s, .w = d, .h = d};
}

static void draw_part(struct ctx *c, const struct part *p, const struct dd_state *st, int x,
                      int y) {
    int s = p->s;
    switch (p->type) {
    case P_TEXT:
        draw_text(c, x, y, p->text, s, c->fg);
        break;
    case P_ICON:
        draw_bitmap(c, p->icon, x, y, s, false);
        if (p->slash) {
            line(c, x, y + p->h - 1, x + p->w - 1, y, c->fg);
            line(c, x, y + p->h, x + p->w - 1, y + 1, c->bg);
        }
        break;
    case P_BATTERY: {
        int bx = x;
        int by = y;
        if (p->bolt) {
            int bolt_h = dd_icon_bolt.h * s;
            int row_h = bolt_h > 9 * s ? bolt_h : 9 * s;
            draw_bitmap(c, &dd_icon_bolt, x, y + ((row_h - bolt_h) >> 1), s, false);
            bx = x + dd_icon_bolt.w * s + s;
            by = y + ((row_h - 9 * s) >> 1);
        }
        fill_rect(c, bx, by, 20 * s, 9 * s, c->fg);
        fill_rect(c, bx + s, by + s, 18 * s, 7 * s, c->bg);
        fill_rect(c, bx + 20 * s, by + 3 * s, 2 * s, 3 * s, c->fg);
        if (!p->unknown) {
            int inner = 16 * s;
            int fw = (inner * p->level + 50) / 100;
            fill_rect(c, bx + 2 * s, by + 2 * s, fw, 5 * s, c->fg);
        }
        break;
    }
    case P_ICONTEXT:
        draw_bitmap(c, p->icon, x, y + ((p->h - p->icon->h * s) >> 1), s, false);
        draw_text(c, x + p->icon->w * s + s, y + ((p->h - 8 * s) >> 1), p->text, s, c->fg);
        break;
    case P_BARS:
        for (int i = 0; i < 4; i++) {
            int bh = (2 + 2 * i) * s;
            if (i < p->level) {
                fill_rect(c, x + 3 * s * i, y + 8 * s - bh, 2 * s, bh, c->fg);
            } else {
                fill_rect(c, x + 3 * s * i, y + 7 * s, 2 * s, s, c->fg);
            }
        }
        break;
    case P_PROFILE: {
        int r = 6 * s;
        int cx = x + r;
        int cy = y + r;
        char digit[4];
        snprintf(digit, sizeof(digit), "%d", (int)st->profile + 1);
        uint8_t digit_color = c->fg;
        if (st->profile_connected) {
            circle(c, cx, cy, r, c->fg, true, false);
            digit_color = c->bg;
        } else {
            circle(c, cx, cy, r, c->fg, false, st->profile_bonded);
        }
        draw_text(c, cx - 4 * s, cy - 4 * s, digit, s, digit_color);
        break;
    }
    }
}

/* Builds the parts of widget `sl` at scale s; returns the number of parts. */
static int build_parts(const struct dd_layout *layout, const struct dd_slot *sl,
                       const struct dd_state *st, int s, struct part *out) {
    char buf[TEXT_MAX];
    int n = 0;
    switch (sl->kind) {
    case DD_KIND_BATTERY: {
        bool peer = sl->source == 1;
        int level = peer ? st->peer_battery : st->battery;
        bool unknown = level < 0;
        if (sl->style != 2) {
            out[n++] = battery_part(unknown ? 0 : level, s, unknown, !peer && st->charging);
        }
        if (sl->style != 1) {
            if (unknown) {
                snprintf(buf, sizeof(buf), "--");
            } else {
                snprintf(buf, sizeof(buf), "%d%%", level);
            }
            out[n++] = text_part(buf, s, sl->w);
        }
        break;
    }
    case DD_KIND_CONNECTION: {
        const struct dd_bitmap *icon;
        bool slash = false;
        bool radio = true;
        const char *label;
        int rssi = 0;
        if (layout->peripheral) {
            icon = &dd_icon_bluetooth;
            slash = !st->link_connected;
            label = st->link_connected ? "LINK" : "OFF";
            rssi = st->link_connected ? st->rssi_link : 0;
        } else if (sl->source == 1) {
            icon = &dd_icon_bluetooth;
            rssi = st->rssi_link;
            slash = rssi == 0;
            label = rssi != 0 ? "LINK" : "OFF";
        } else if (st->transport == DD_TRANSPORT_USB) {
            icon = &dd_icon_usb;
            label = "USB";
            radio = false;
        } else {
            icon = &dd_icon_bluetooth;
            if (st->profile_connected) {
                label = "BT";
                rssi = st->rssi_host;
            } else if (st->profile_bonded) {
                slash = true;
                label = "OFF";
            } else {
                label = "PAIR";
            }
        }
        if (sl->style >= 2 && radio) {
            out[n++] = bars_part(rssi, s);
            if (sl->style == 3) {
                if (rssi != 0) {
                    snprintf(buf, sizeof(buf), "%d", rssi);
                } else {
                    snprintf(buf, sizeof(buf), "--");
                }
                out[n++] = text_part(buf, s >> 1 > 1 ? s >> 1 : 1, sl->w);
            }
            break;
        }
        out[n++] = icon_part(icon, s, slash);
        if (sl->style == 1) {
            out[n++] = text_part(label, s, sl->w);
        }
        break;
    }
    case DD_KIND_CLOCK: {
        struct dd_datetime dt;
        dd_datetime_from(st->utc, st->utc_offset_min, &dt);
        if (sl->style == 0) {
            snprintf(buf, sizeof(buf), "%02d", dt.hour);
            out[n++] = text_part(buf, s, sl->w);
            snprintf(buf, sizeof(buf), "%02d", dt.minute);
            out[n++] = text_part(buf, s, sl->w);
        } else if (sl->style == 1) {
            snprintf(buf, sizeof(buf), "%02d:%02d", dt.hour, dt.minute);
            out[n++] = text_part(buf, s, sl->w);
        } else {
            snprintf(buf, sizeof(buf), "%02d:%02d:%02d", dt.hour, dt.minute, dt.second);
            out[n++] = text_part(buf, s, sl->w);
        }
        break;
    }
    case DD_KIND_DATE: {
        struct dd_datetime dt;
        dd_datetime_from(st->utc, st->utc_offset_min, &dt);
        const char *wd = dd_weekdays[dt.weekday - 1];
        char kw[12];
        snprintf(kw, sizeof(kw), "KW %02d", dt.week);
        switch (sl->style) {
        case 1:
            snprintf(buf, sizeof(buf), "%s %02d.%02d", wd, dt.day, dt.month);
            out[n++] = text_part(buf, s, sl->w);
            break;
        case 2:
            snprintf(buf, sizeof(buf), "%02d.%02d.%02d", dt.day, dt.month, dt.year % 100);
            out[n++] = text_part(buf, s, sl->w);
            break;
        case 3:
            out[n++] = text_part(kw, s, sl->w);
            break;
        case 4:
            out[n++] = text_part(wd, s, sl->w);
            snprintf(buf, sizeof(buf), "%02d.%02d.", dt.day, dt.month);
            out[n++] = text_part(buf, s, sl->w);
            out[n++] = text_part(kw, s, sl->w);
            break;
        default:
            snprintf(buf, sizeof(buf), "%02d.%02d.", dt.day, dt.month);
            out[n++] = text_part(buf, s, sl->w);
            break;
        }
        break;
    }
    case DD_KIND_WORDCLOCK: {
        struct dd_datetime dt;
        const char *lines[5];
        dd_datetime_from(st->utc, st->utc_offset_min, &dt);
        int count = dd_word_clock(dt.hour, dt.minute, sl->style == 1, lines);
        for (int i = 0; i < count; i++) {
            out[n++] = text_part(lines[i], s, sl->w);
        }
        break;
    }
    case DD_KIND_SUN: {
        int rise, set;
        int status =
            dd_sun_times(st->utc, st->utc_offset_min, layout->lat_e4, layout->lon_e4, &rise, &set);
        if (sl->style != 2) {
            if (status == DD_SUN_OK) {
                snprintf(buf, sizeof(buf), "%02d:%02d", rise / 60, rise % 60);
            } else {
                snprintf(buf, sizeof(buf), "--:--");
            }
            out[n++] = icontext_part(&dd_icon_sunrise, buf, s, sl->w);
        }
        if (sl->style != 1) {
            if (status == DD_SUN_OK) {
                snprintf(buf, sizeof(buf), "%02d:%02d", set / 60, set % 60);
            } else {
                snprintf(buf, sizeof(buf), "--:--");
            }
            out[n++] = icontext_part(&dd_icon_sunset, buf, s, sl->w);
        }
        break;
    }
    case DD_KIND_PROFILE:
        out[n++] = profile_part(s);
        break;
    case DD_KIND_LAYER: {
        const char *name = st->layer_label;
        if (name == NULL || name[0] == '\0') {
            snprintf(buf, sizeof(buf), "L%d", (int)st->layer_index);
            name = buf;
        }
        char num[8];
        snprintf(num, sizeof(num), "%d", (int)st->layer_index);
        if (sl->style == 1) {
            out[n++] = text_part(num, s, sl->w);
        } else if (sl->style == 2) {
            out[n++] = text_part(num, s, sl->w);
            out[n++] = text_part(name, s >> 1 > 1 ? s >> 1 : 1, sl->w);
        } else {
            out[n++] = text_part(name, s, sl->w);
        }
        break;
    }
    case DD_KIND_WPM:
        snprintf(buf, sizeof(buf), "%d", (int)st->wpm[DD_WPM_HIST - 1]);
        out[n++] = text_part(buf, s, sl->w);
        out[n++] = text_part("WPM", s >> 1 > 1 ? s >> 1 : 1, sl->w);
        break;
    case DD_KIND_TEXT:
        out[n++] = text_part(sl->text ? sl->text : "", s, sl->w);
        break;
    }
    return n;
}

static int choose_scale(const struct dd_layout *layout, const struct dd_slot *sl,
                        const struct dd_state *st) {
    int start = sl->scale > 0 ? sl->scale : 4;
    struct part parts[MAX_PARTS];
    for (int s = start; s >= 1; s--) {
        int n = build_parts(layout, sl, st, s, parts);
        int tw = 0;
        int th = 0;
        for (int i = 0; i < n; i++) {
            if (parts[i].w > tw) {
                tw = parts[i].w;
            }
            th += parts[i].h;
        }
        th += (n - 1) * 2 * s;
        if (tw <= sl->w && th <= sl->h) {
            return s;
        }
    }
    return 1;
}

static int align_x(const struct dd_slot *sl, int w) {
    if (sl->align == 1) {
        return sl->x;
    }
    if (sl->align == 2) {
        return sl->x + sl->w - w;
    }
    return sl->x + ((sl->w - w) >> 1);
}

static void draw_stack(struct ctx *c, const struct dd_layout *layout, const struct dd_slot *sl,
                       const struct dd_state *st) {
    int s = choose_scale(layout, sl, st);
    struct part parts[MAX_PARTS];
    int n = build_parts(layout, sl, st, s, parts);
    int gap = 2 * s;
    int th = 0;
    for (int i = 0; i < n; i++) {
        th += parts[i].h;
    }
    th += (n - 1) * gap;
    int y = sl->y + ((sl->h - th) >> 1);
    for (int i = 0; i < n; i++) {
        draw_part(c, &parts[i], st, align_x(sl, parts[i].w), y);
        y += parts[i].h + gap;
    }
}

static void hand_end(int cx, int cy, int len, int idx, int *x, int *y) {
    *x = cx + dd_rdiv(len * dd_sin720[idx], 1000);
    *y = cy - dd_rdiv(len * dd_sin720[(idx + 180) % 720], 1000);
}

static void draw_analog(struct ctx *c, const struct dd_slot *sl, const struct dd_state *st,
                        bool with_seconds) {
    struct dd_datetime dt;
    dd_datetime_from(st->utc, st->utc_offset_min, &dt);
    int cx = sl->x + (sl->w >> 1);
    int cy = sl->y + (sl->h >> 1);
    int r = ((sl->w < sl->h ? sl->w : sl->h) >> 1) - 1;
    if (r < 6) {
        return;
    }
    circle(c, cx, cy, r, c->fg, false, false);
    for (int i = 0; i < 12; i++) {
        int len = i % 3 == 0 ? 4 : 2;
        int ax, ay, bx, by;
        hand_end(cx, cy, r - len, i * 60, &ax, &ay);
        hand_end(cx, cy, r - 1, i * 60, &bx, &by);
        line(c, ax, ay, bx, by, c->fg);
    }
    int ex, ey;
    hand_end(cx, cy, (r * 5) / 10, (dt.hour % 12) * 60 + dt.minute, &ex, &ey);
    line(c, cx, cy, ex, ey, c->fg);
    line(c, cx + 1, cy, ex + 1, ey, c->fg);
    hand_end(cx, cy, (r * 8) / 10, (dt.minute * 60 + dt.second) / 5, &ex, &ey);
    line(c, cx, cy, ex, ey, c->fg);
    if (with_seconds) {
        hand_end(cx, cy, (r * 9) / 10, dt.second * 12, &ex, &ey);
        line(c, cx, cy, ex, ey, c->fg);
    }
    circle(c, cx, cy, 2, c->fg, true, false);
}

static void draw_binary(struct ctx *c, const struct dd_slot *sl, const struct dd_state *st,
                        bool with_seconds) {
    struct dd_datetime dt;
    dd_datetime_from(st->utc, st->utc_offset_min, &dt);
    int digits[6] = {dt.hour / 10, dt.hour % 10, dt.minute / 10, dt.minute % 10, 0, 0};
    int bits[6] = {2, 4, 3, 4, 3, 4};
    int n = 4;
    if (with_seconds) {
        digits[4] = dt.second / 10;
        digits[5] = dt.second % 10;
        n = 6;
    }
    int cw = sl->w / n;
    int ch = sl->h / 4;
    int cs = cw < ch ? cw : ch;
    if (cs < 3) {
        return;
    }
    int x0 = sl->x + ((sl->w - cs * n) >> 1);
    int y0 = sl->y + ((sl->h - cs * 4) >> 1);
    int r = ((cs - 1) >> 1) - 1;
    if (r < 1) {
        r = 1;
    }
    for (int col = 0; col < n; col++) {
        for (int row = 0; row < 4; row++) {
            int bit = 3 - row;
            if (bit >= bits[col]) {
                continue;
            }
            circle(c, x0 + col * cs + (cs >> 1), y0 + row * cs + (cs >> 1), r, c->fg,
                   ((digits[col] >> bit) & 1) == 1, false);
        }
    }
}

static void draw_moon(struct ctx *c, const struct dd_slot *sl, const struct dd_state *st,
                      bool show_percent) {
    int reserve = show_percent ? 10 : 0;
    int avail_h = sl->h - reserve;
    int r = ((sl->w < avail_h ? sl->w : avail_h) >> 1) - 1;
    if (r < 3) {
        return;
    }
    int cx = sl->x + (sl->w >> 1);
    int cy = sl->y + (avail_h >> 1);
    int p = dd_moon_phase(st->utc);
    int k = dd_sin720[((p * 720) / 1024 + 180) % 720];
    bool waxing = p < 512;
    for (int dy = -r; dy <= r; dy++) {
        int hw = dd_isqrt(r * r - dy * dy);
        int xt = dd_rdiv(hw * k, 1000);
        int lo = waxing ? xt : -hw;
        int hi = waxing ? hw : -xt;
        for (int x = lo; x <= hi; x++) {
            set_px(c, cx + x, cy + dy, c->fg);
        }
    }
    circle(c, cx, cy, r, c->fg, false, false);
    if (show_percent) {
        char t[8];
        snprintf(t, sizeof(t), "%d%%", (1000 - k) / 20);
        draw_text(c, sl->x + ((sl->w - (int)strlen(t) * 8) >> 1), sl->y + sl->h - 9, t, 1, c->fg);
    }
}

static void draw_wpm_graph(struct ctx *c, const struct dd_slot *sl, const struct dd_state *st,
                           bool with_number) {
    int x = sl->x, y = sl->y, w = sl->w, h = sl->h;
    fill_rect(c, x, y, w, 1, c->fg);
    fill_rect(c, x, y + h - 1, w, 1, c->fg);
    fill_rect(c, x, y, 1, h, c->fg);
    fill_rect(c, x + w - 1, y, 1, h, c->fg);
    if (w < 8 || h < 8) {
        return;
    }
    const int n = DD_WPM_HIST;
    int max = 40;
    for (int i = 0; i < n; i++) {
        if (st->wpm[i] > max) {
            max = st->wpm[i];
        }
    }
    int gw = w - 4;
    int gh = h - 4;
    int px = 0, py = 0;
    for (int i = 0; i < n; i++) {
        int gx = x + 2 + (i * (gw - 1)) / (n - 1);
        int gy = y + 2 + gh - 1 - (st->wpm[i] * (gh - 1)) / max;
        if (i > 0) {
            line(c, px, py, gx, gy, c->fg);
        }
        px = gx;
        py = gy;
    }
    if (with_number) {
        char t[8];
        snprintf(t, sizeof(t), "%d", (int)st->wpm[n - 1]);
        int tw = (int)strlen(t) * 8;
        fill_rect(c, x + w - tw - 3, y + 1, tw + 2, 9, c->bg);
        draw_text(c, x + w - tw - 2, y + 2, t, 1, c->fg);
    }
}

static void draw_centered_bitmap(struct ctx *c, const struct dd_slot *sl,
                                 const struct dd_bitmap *bmp) {
    int x = align_x(sl, bmp->w);
    int y = sl->y + ((sl->h - bmp->h) >> 1);
    draw_bitmap(c, bmp, x, y, 1, true);
}

static void draw_slot(struct ctx *c, const struct dd_layout *layout, const struct dd_slot *sl,
                      const struct dd_state *st, uint32_t tick) {
    c->fg = sl->invert ? 0 : 1;
    c->bg = sl->invert ? 1 : 0;
    c->cx0 = sl->x;
    c->cy0 = sl->y;
    c->cx1 = sl->x + sl->w;
    c->cy1 = sl->y + sl->h;
    fill_rect(c, sl->x, sl->y, sl->w, sl->h, c->bg);

    switch (sl->kind) {
    case DD_KIND_NONE:
        break;
    case DD_KIND_WPM:
        if (sl->style == 0) {
            draw_stack(c, layout, sl, st);
        } else {
            draw_wpm_graph(c, sl, st, sl->style == 2);
        }
        break;
    case DD_KIND_IMAGE:
        if (sl->bitmaps) {
            draw_centered_bitmap(c, sl, &sl->bitmaps[0]);
        }
        break;
    case DD_KIND_ANALOG:
        draw_analog(c, sl, st, sl->style == 1);
        break;
    case DD_KIND_BINARY:
        draw_binary(c, sl, st, sl->style == 1);
        break;
    case DD_KIND_MOON:
        draw_moon(c, sl, st, sl->style == 1);
        break;
    case DD_KIND_ANIM:
        if (sl->bitmaps && sl->frame_count) {
            uint32_t div = sl->frame_div ? sl->frame_div : 1;
            draw_centered_bitmap(c, sl, &sl->bitmaps[(tick / div) % sl->frame_count]);
        }
        break;
    default:
        draw_stack(c, layout, sl, st);
        break;
    }
}

void dd_render(const struct dd_layout *layout, const struct dd_state *state, uint32_t tick,
               uint8_t *fb) {
    struct ctx c = {.fb = fb};
    memset(fb, 0, DD_W * DD_H);
    for (int i = 0; i < layout->slot_count; i++) {
        draw_slot(&c, layout, &layout->slots[i], state, tick);
    }
}
