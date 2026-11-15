#!/usr/bin/env bash
# Builds dd-helper and installs it as a systemd user service (Linux).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
cargo build --release
install -Dm755 target/release/dd-helper "$HOME/.local/bin/dd-helper"
install -Dm644 dd-helper.service "$HOME/.config/systemd/user/dd-helper.service"
systemctl --user daemon-reload
systemctl --user enable --now dd-helper.service
echo "dd-helper installed; log: journalctl --user -u dd-helper -f"
