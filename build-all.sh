#!/usr/bin/env bash
#
# build-all.sh — builds Dizako for every platform.
#
#   Linux   : full build — wasm engine, frontend, release binary, then deb,
#             rpm and appimage bundles (each bundle is best-effort; a failing
#             packager does not kill the rest).
#   Windows : scaffolding only. Run this script from Git Bash / MSYS on the
#             Windows box, or follow the printed steps in PowerShell.
#   macOS   : scaffolding only, same idea.
#
# Usage: ./build-all.sh [linux|windows|macos]   (default: autodetect)
set -uo pipefail

cd "$(dirname "$0")"

say()  { printf '\n\033[1;35m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33mWARN:\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mERR:\033[0m %s\n' "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null || die "missing dependency: $1"; }

# ---------- shared ----------
build_common() {
  need pnpm
  need cargo
  need wasm-pack
  say "wasm engine"
  pnpm build:wasm

  say "frontend (typecheck + vite)"
  pnpm exec tsc --noEmit
  pnpm exec vite build
}

release_binary() {
  say "rust shell (cargo release)"
  cargo build --release --manifest-path src-tauri/Cargo.toml
}

bundle() {
  local targets="$1"
  say "tauri bundle: ${targets}"
  pnpm tauri build --bundles "$targets" || warn "bundle '$targets' failed"
}

# ---------- platforms ----------
build_linux() {
  build_common
  release_binary

  # Native packages first (reliable), AppImage last (needs linuxdeploy +
  # FUSE or appimage extraction; commonly flaky on headless/dev boxes).
  bundle deb,rpm
  bundle appimage

  say "artifacts"
  ls -lh src-tauri/target/release/dizako 2>/dev/null
  ls -lh src-tauri/target/release/bundle/deb/*.deb \
        src-tauri/target/release/bundle/rpm/*.rpm \
        src-tauri/target/release/bundle/appimage/*.AppImage 2>/dev/null || true
}

build_windows() {
  cat <<'EOF'
== Windows build (run from the Windows machine) ==

Prerequisites: Rust (MSVC toolchain + Visual Studio Build Tools), Node 22+,
pnpm (`corepack enable` or `iwr https://get.pnpm.io/install.ps1`), wasm-pack
(`cargo install wasm-pack` or the installer), WebView2 (preinstalled on Win11).

Then from PowerShell:

    pnpm install
    pnpm build:wasm
    pnpm tauri build --bundles nsis

Output: src-tauri\target\release\bundle\nsis\Dizako_<version>_x64-setup.exe

Notes:
- .cargo/config.toml pins a mingw linker for x86_64-pc-windows-gnu. That only
  applies when targeting the GNU toolchain; native Windows builds use MSVC by
  default and ignore it. Delete that section if you want to build the GNU
  target WITHOUT mingw present.
- To cross-build from Linux instead you need the NSIS + mingw toolchains
  (`pacman -S mingw-w64-gcc nsis` or equivalent) and:
      pnpm tauri build --runner cargo --target x86_64-pc-windows-gnu --bundles nsis
  This is untested here — hence run-it-from-Windows being the supported path.
EOF
}

build_macos() {
  cat <<'EOF'
== macOS build (run from the Mac) ==

Prerequisites: Xcode CLTs (`xcode-select --install`), Rust, Node 22+, pnpm,
wasm-pack.

    pnpm install
    pnpm build:wasm
    pnpm tauri build --bundles dmg,app

Output: src-tauri/target/release/bundle/{dmg,macos}/
EOF
}

case "${1:-$(uname -s)}" in
  Linux|linux)                 build_linux ;;
  MINGW*|MSYS*|CYGWIN*|Windows|windows) build_windows ;;
  Darwin|macos)                build_macos ;;
  *) die "unknown platform '$1' (use: linux | windows | macos)" ;;
esac
