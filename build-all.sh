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

check_deps() {
  local missing=()
  for cmd in "$@"; do
    command -v "$cmd" >/dev/null || missing+=("$cmd")
  done
  if [ ${#missing[@]} -ne 0 ]; then
    die "missing dependencies: ${missing[*]}"
  fi
}

# ---------- shared ----------
build_common() {
  check_deps pnpm cargo wasm-pack
  
  say "wasm engine"
  wasm-pack build dither-wasm --release --target web --out-dir pkg

  say "installing dependencies"
  echo "strict-dep-builds=false" > .npmrc
  pnpm install

  say "frontend (typecheck + vite)"
  pnpm exec tsc --noEmit
  pnpm exec vite build
}

# ---------- platforms ----------
check_linux_deps() {
  local missing_arch_pkgs=()
  local missing_msgs=()

  if ! command -v pnpm >/dev/null; then
    missing_msgs+=("pnpm (Node package manager)")
    missing_arch_pkgs+=(pnpm)
  fi
  if ! command -v cargo >/dev/null; then
    missing_msgs+=("cargo (Rust toolchain)")
    missing_arch_pkgs+=(rust)
  fi
  if ! command -v wasm-pack >/dev/null; then
    missing_msgs+=("wasm-pack (Rust Wasm builder)")
    missing_arch_pkgs+=(wasm-pack)
  fi
  if ! command -v pkg-config >/dev/null || ! pkg-config --exists webkit2gtk-4.1; then
    missing_msgs+=("Tauri system dependencies (webkit2gtk-4.1, etc.)")
    missing_arch_pkgs+=(webkit2gtk-4.1 base-devel curl wget openssl appmenu-gtk-module gtk3 libvips libayatana-appindicator)
  fi

  # Check wasm32-unknown-unknown target if rust is installed or will be installed
  if command -v rustc >/dev/null; then
    if [ ! -d "$(rustc --print sysroot 2>/dev/null)/lib/rustlib/wasm32-unknown-unknown" ]; then
      missing_msgs+=("Rust WebAssembly target (wasm32-unknown-unknown)")
      missing_arch_pkgs+=(rust-wasm)
    fi
  elif [[ " ${missing_arch_pkgs[*]} " =~ " rust " ]]; then
    missing_msgs+=("Rust WebAssembly target (wasm32-unknown-unknown)")
    missing_arch_pkgs+=(rust-wasm)
  fi

  if [ ${#missing_msgs[@]} -gt 0 ]; then
    warn "The following system dependencies are missing:"
    for msg in "${missing_msgs[@]}"; do
      echo "  - $msg"
    done
    
    if command -v pacman >/dev/null </dev/tty; then
      read -p "Arch Linux detected. Install them now with pacman? [y/N] " -r ans </dev/tty
      if [[ "$ans" =~ ^[Yy] ]]; then
        pkexec pacman -S --noconfirm --needed "${missing_arch_pkgs[@]}" </dev/tty
      else
        warn "Skipping dependency installation. Build will likely fail."
      fi
    else
      warn "Please install them manually for your distribution."
    fi
  fi
}

build_linux() {
  check_linux_deps
  build_common

  say "tauri build (binary + bundles)"
  # We run deb,rpm first. This compiles the release binary WITH frontend assets
  # and produces the packages.
  say "tauri bundle: deb,rpm"
  pnpm tauri build --bundles deb,rpm || warn "bundle 'deb,rpm' failed"

  say "tauri bundle: appimage"
  # NO_STRIP is mandatory. linuxdeploy carries its own binutils `strip`, built
  # in 2024 and too old to parse the SHT_RELR (`.relr.dyn`) sections every
  # current Arch library ships. Without it, stripping fails on each bundled
  # library, linuxdeploy exits non-zero and no AppImage is ever produced.
  ./packaging/patch-linuxdeploy-gtk.sh
  NO_STRIP=1 pnpm tauri build --bundles appimage || warn "bundle 'appimage' failed"

  if command -v makepkg >/dev/null; then
    say "arch package (makepkg)"
    if (cd packaging && makepkg -cf); then
      say "installing arch package"
      # Install ONLY the package we just built. Globbing packaging/*.pkg.tar.zst
      # hands pacman every stale artifact still lying around -- duplicate targets
      # for the same pkgname, plus any truncated one -- and pacman then aborts the
      # whole transaction, so nothing gets installed at all.
      pkg=$(ls -t "$PWD"/packaging/*.pkg.tar.zst 2>/dev/null | head -1)
      if [ -n "$pkg" ]; then
        pkexec /usr/bin/pacman -U --noconfirm "$pkg" || warn "installation failed"
      else
        warn "makepkg reported success but produced no package"
      fi
    else
      warn "makepkg failed"
    fi
  fi

  say "artifacts"
  ls -lh src-tauri/target/release/dizako 2>/dev/null
  ls -lh src-tauri/target/release/bundle/deb/*.deb \
        src-tauri/target/release/bundle/rpm/*.rpm \
        src-tauri/target/release/bundle/appimage/*.AppImage 2>/dev/null || true
  ls -lh packaging/*.pkg.tar.zst 2>/dev/null || true
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
