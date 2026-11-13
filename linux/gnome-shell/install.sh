#!/usr/bin/env bash
# TokenBar GNOME Shell 扩展安装脚本
#   ./install.sh [--api-key <Z.ai API key>]
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
uuid="tokenbar@zuohang"
dest="$HOME/.local/share/gnome-shell/extensions/$uuid"

api_key=""
while [ $# -gt 0 ]; do
    case "$1" in
        --api-key) api_key="${2:?--api-key 需要一个值}"; shift 2 ;;
        *) echo "用法: $0 [--api-key <Z.ai API key>]"; exit 1 ;;
    esac
done

# 写入 API key（始终走 python3 保证 JSON 转义正确）
if [ -n "$api_key" ]; then
    cfg_dir="$HOME/.config/tokenbar"
    mkdir -m 700 -p "$cfg_dir"
    cfg="$cfg_dir/config.json"
    python3 - "$cfg" "$api_key" <<'EOF'
import json, os, sys
path, key = sys.argv[1], sys.argv[2]
try:
    with open(path) as f:
        obj = json.load(f)
except Exception:
    obj = {}
obj["apiKey"] = key
with open(path, "w") as f:
    json.dump(obj, f, ensure_ascii=False, indent=2)
    f.write("\n")
os.chmod(path, 0o600)
EOF
    echo "✓ API key 已写入 $cfg"
fi

mkdir -p "$(dirname "$dest")"
rm -rf "$dest"
cp -r "$here/$uuid" "$dest"
echo "✓ 扩展已安装到 $dest"

# 启用（新扩展目录尚未被 Shell 扫描时会失败，属预期）
if gnome-extensions enable "$uuid" 2>/dev/null; then
    echo "✓ 已启用"
else
    echo "· 未能立即启用（新扩展需要 Shell 重新扫描，见下方说明）"
fi

# 用户扩展总开关检查
if [ "$(gsettings get org.gnome.shell disable-user-extensions 2>/dev/null)" = "true" ]; then
    echo "! 用户扩展被系统开关禁用：gsettings set org.gnome.shell disable-user-extensions false"
fi

session="${XDG_SESSION_TYPE:-}"
case "$session" in
    wayland)
        echo
        echo "→ Wayland 会话：请注销并重新登录（GNOME Shell 只在启动时扫描扩展目录），"
        echo "  然后运行 gnome-extensions info $uuid 确认 State: ACTIVE"
        ;;
    x11)
        echo
        echo "→ X11 会话：按 Alt+F2 输入 r 重启 Shell 即可加载；或注销重登"
        ;;
    *)
        echo
        echo "→ 注销并重新登录后生效；用 gnome-extensions info $uuid 确认 State: ACTIVE"
        ;;
esac
