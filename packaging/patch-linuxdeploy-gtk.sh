#!/usr/bin/env bash
# Patch Tauri's cached linuxdeploy GTK plugin so AppImages do not ship
# bundled libwayland*. Host Wayland/EGL (Arch+NVIDIA etc.) then loads
# matching system libs instead of aborting with EGL_BAD_PARAMETER
# (tauri#11988). Also inject WebKit NVIDIA-safe env into AppRun.
set -euo pipefail

CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/tauri"
mkdir -p "$CACHE"
PLUGIN="$CACHE/linuxdeploy-plugin-gtk.sh"

if [[ ! -f "$PLUGIN" ]]; then
  curl -fsSL \
    https://raw.githubusercontent.com/tauri-apps/linuxdeploy-plugin-gtk/master/linuxdeploy-plugin-gtk.sh \
    -o "$PLUGIN"
fi
chmod +x "$PLUGIN"

MARKER="# Dizako: libwayland must come from the host"
if grep -qF "$MARKER" "$PLUGIN"; then
  exit 0
fi

cat >> "$PLUGIN" <<'EOF'

# Dizako: libwayland must come from the host (tauri#11988 / AppImage EGL_BAD_PARAMETER).
find "$APPDIR" -name 'libwayland-*.so*' -delete 2>/dev/null || true

# Inject WebKit NVIDIA-safe defaults into the AppRun hook (runs at launch).
cat >> "$HOOKFILE" <<'DIZAKO_EOF'
export WEBKIT_DISABLE_DMABUF_RENDERER="${WEBKIT_DISABLE_DMABUF_RENDERER:-1}"
export __NV_DISABLE_EXPLICIT_SYNC="${__NV_DISABLE_EXPLICIT_SYNC:-1}"
DIZAKO_EOF
EOF
