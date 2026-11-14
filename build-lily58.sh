#!/usr/bin/env bash

# Builds the firmware for both halves of the splitkb Aurora Lily58
# (nice!nano + nice!view) and prints where the resulting .uf2 files are.
#
# Usage: ./build-lily58.sh [-p] [left|right]...
#   -p            pristine build (wipe the build directories first); without it,
#                 existing build directories are rebuilt incrementally
#   left|right    build only the given half/halves (default: both)

set -euo pipefail

BOARD="${BOARD:-nice_nano//zmk}"
SHIELD="splitkb_aurora_lily58"
EXTRA_SHIELDS="nice_view_adapter nice_view"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app_dir="$repo_root/app"

pristine=0
sides=()
for arg in "$@"; do
    case "$arg" in
    -p | --pristine) pristine=1 ;;
    left | right) sides+=("$arg") ;;
    *)
        echo "Usage: $0 [-p] [left|right]..." >&2
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

outputs=()
for side in "${sides[@]}"; do
    echo "==> Building $side half"
    if [ "$pristine" -eq 0 ] && [ -f "build/$side/zephyr/zmk.uf2" ]; then
        # Incremental rebuild; board and shield arguments are cached in the build directory.
        west build -d "build/$side"
    else
        west build -p always -d "build/$side" -b "$BOARD" -- \
            -DSHIELD="${SHIELD}_${side} ${EXTRA_SHIELDS}"
    fi
    outputs+=("$app_dir/build/$side/zephyr/zmk.uf2")
done

echo
echo "Firmware files:"
for file in "${outputs[@]}"; do
    echo "  $file"
done
