#!/usr/bin/env sh
# nah — install script. Tries a prebuilt binary (GitHub releases), falls back to npm.
#   curl -fsSL https://get.nah.sh | sh            (example host)
#   NAH_VERSION=0.0.1-beta.0 sh install.sh
set -eu

REPO="astracollab/astracollab"
PKG="@astracollab/nah"
BIN_NAME="nah"
VERSION="${NAH_VERSION:-latest}"

have() { command -v "$1" >/dev/null 2>&1; }

install_via_npm() {
  if ! have npm; then
    echo "nah: npm not found. Install Node.js >= 20.6 first: https://nodejs.org" >&2
    exit 1
  fi
  echo "Installing $PKG via npm…"
  if [ "$VERSION" = "latest" ]; then
    npm install -g "$PKG@latest"
  else
    npm install -g "$PKG@$VERSION"
  fi
}

install_binary() {
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  case "$os" in
    darwin|linux) ;;
    *) return 1 ;;
  esac
  case "$arch" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64) arch="x64" ;;
    *) return 1 ;;
  esac
  tag="$VERSION"
  [ "$VERSION" = "latest" ] && tag="latest/download" || tag="download/nah-v$VERSION"
  url="https://github.com/$REPO/releases/$tag/nah-$os-$arch"
  dest_dir="${NAH_INSTALL_DIR:-${XDG_BIN_DIR:-}}"
  if [ -z "$dest_dir" ]; then
    if have brew && [ "$os" = "darwin" ]; then dest_dir="/usr/local/bin"; else dest_dir="$HOME/.local/bin"; fi
  fi
  mkdir -p "$dest_dir"
  tmp="$(mktemp)" || exit 1
  echo "Downloading $url"
  if ! have curl || ! curl -fsSL "$url" -o "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  chmod +x "$tmp"
  mv "$tmp" "$dest_dir/$BIN_NAME"
  echo "Installed to $dest_dir/$BIN_NAME"
  case ":$PATH:" in
    *":$dest_dir:"*) ;;
    *) echo "note: $dest_dir is not on your PATH" ;;
  esac
}

main() {
  if install_binary; then
    "$BIN_NAME" --version
    exit 0
  fi
  echo "(no prebuilt binary for this platform/release; using npm)"
  install_via_npm
  "$BIN_NAME" --version
}

main
