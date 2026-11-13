#!/usr/bin/env bash
# TokenBar GNOME Shell 扩展卸载脚本
set -euo pipefail

uuid="tokenbar@zuohang"
dest="$HOME/.local/share/gnome-shell/extensions/$uuid"

gnome-extensions disable "$uuid" 2>/dev/null || true
rm -rf "$dest"
echo "✓ 已移除 $dest（Wayland 下需重新登录让 Shell 彻底忘记它）"
echo "  API key 保留在 ~/.config/tokenbar/config.json，如不需要请手动删除"
