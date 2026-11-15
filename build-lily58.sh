#!/usr/bin/env bash

# Builds the firmware for both halves of the splitkb Aurora Lily58
# (nice!nano + nice!view) and prints where the resulting .uf2 files are.
#
# Usage: ./build-lily58.sh [-p] [left|right]...
#   -p            pristine build (wipe the build directories first); without it,
#                 existing build directories are rebuilt incrementally
#   left|right    build only the given half/halves (default: both)
#   --stock       build the stock nice!view screen (art.c) instead of the screen from
#                 display-designer/ (the default, see display-module/)

set -euo pipefail

BOARD="${BOARD:-nice_nano//zmk}"
SHIELD="splitkb_aurora_lily58"
EXTRA_SHIELDS="nice_view_adapter nice_view"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app_dir="$repo_root/app"

pristine=0
stock=0
sides=()
for arg in "$@"; do
    case "$arg" in
    -p | --pristine) pristine=1 ;;
    --stock) stock=1 ;;
    left | right) sides+=("$arg") ;;
    *)
        echo "Usage: $0 [-p] [--stock] [left|right]..." >&2
        exit 1
        ;;
    esac
done
if [ ${#sides[@]} -eq 0 ]; then
    sides=(left right)
fi

if [ ! -f "$repo_root/.venv/bin/activate" ]; then
    echo "Toolchain venv not found at $repo_root/.venv (see AGENTS.md, section Toolchain)." >&2
    exit 1
fi
# The venv provides west and CMake 3.x (the system CMake 4.x breaks Zephyr 4.1).
# shellcheck disable=SC1091
source "$repo_root/.venv/bin/activate"

cd "$app_dir"

# The status screen comes from the display-module Zephyr module (layout in display-designer/).
# CONFIG_NICE_VIEW_WIDGET_STATUS=n keeps the stock nice!view screen out of the build.
extra_args=(
    -DZMK_EXTRA_MODULES="$repo_root/display-module"
    -DCONFIG_DISPLAY_DESIGNER=y
    -DCONFIG_NICE_VIEW_WIDGET_STATUS=n
)
# The keyboard has no real-time clock; its clock starts at the time of this build until a helper
# program (or the left half) sets it. Passing the time on every build keeps it current.
tz="$(date +%z)"
tz_minutes=$((10#${tz:1:2} * 60 + 10#${tz:3:2}))
[ "${tz:0:1}" = "-" ] && tz_minutes=$((-tz_minutes))
time_args=(-DDD_BUILD_EPOCH="$(date +%s)" -DDD_BUILD_UTC_OFFSET_MIN="$tz_minutes")
if [ "$stock" -eq 1 ]; then
    extra_args=()
    time_args=()
fi

outputs=()
for side in "${sides[@]}"; do
    echo "==> Building $side half"
    if [ "$pristine" -eq 0 ] && [ -f "build/$side/zephyr/zmk.uf2" ]; then
        # Incremental rebuild; board and shield arguments are cached in the build directory.
        if [ "${#time_args[@]}" -gt 0 ]; then
            west build -d "build/$side" -- "${time_args[@]}"
        else
            west build -d "build/$side"
        fi
    else
        west build -p always -d "build/$side" -b "$BOARD" -- \
            -DSHIELD="${SHIELD}_${side} ${EXTRA_SHIELDS}" "${extra_args[@]}" \
            ${time_args[@]+"${time_args[@]}"}
    fi
    outputs+=("$app_dir/build/$side/zephyr/zmk.uf2")
done

echo
echo "Firmware files:"
for file in "${outputs[@]}"; do
    echo "  $file"
done
