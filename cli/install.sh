#!/usr/bin/env bash

set -euo pipefail

REPO="wormhole-foundation/native-token-transfers"
INSTALL_DIR="${NTT_INSTALL_DIR:-$HOME/.ntt}"
BIN_DIR="$INSTALL_DIR/bin"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

info() { echo -e "${GREEN}info${NC}: $1"; }
warn() { echo -e "${YELLOW}warn${NC}: $1"; }
error() { echo -e "${RED}error${NC}: $1" >&2; }

# Detect OS and architecture
detect_platform() {
  local os arch

  case "$(uname -s)" in
    Linux*)  os="linux" ;;
    Darwin*) os="darwin" ;;
    MINGW*|MSYS*|CYGWIN*) os="windows" ;;
    *)
      error "Unsupported operating system: $(uname -s)"
      exit 1
      ;;
  esac

  case "$(uname -m)" in
    x86_64|amd64) arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *)
      error "Unsupported architecture: $(uname -m)"
      exit 1
      ;;
  esac

  echo "${os}-${arch}"
}

# Get the latest release tag matching v*+cli pattern
# Args: $1 = include_prerelease (true/false)
get_latest_version() {
  local include_prerelease="${1:-false}"
  local version

  if [ "$include_prerelease" = true ]; then
    # Get all releases (including prereleases), sorted by date
    version=$(curl -fsSL "https://api.github.com/repos/$REPO/releases" | \
      grep -o '"tag_name": *"v[^"]*+cli"' | \
      head -1 | \
      sed 's/"tag_name": *"\(.*\)"/\1/')
  else
    # Get only stable releases (exclude prereleases)
    version=$(curl -fsSL "https://api.github.com/repos/$REPO/releases" | \
      grep -B5 '"tag_name": *"v[^"]*+cli"' | \
      grep -B5 '"prerelease": *false' | \
      grep -o '"tag_name": *"v[^"]*+cli"' | \
      head -1 | \
      sed 's/"tag_name": *"\(.*\)"/\1/')
  fi

  if [ -z "$version" ]; then
    error "Could not find a CLI release. Check https://github.com/$REPO/releases"
    exit 1
  fi

  echo "$version"
}

# Download and install the binary
install_binary() {
  local version="$1"
  local platform="$2"
  local artifact="ntt-${platform}"
  local url="https://github.com/$REPO/releases/download/${version}/${artifact}"

  # Windows binaries have .exe extension
  if [[ "$platform" == windows-* ]]; then
    artifact="${artifact}.exe"
    url="${url}.exe"
  fi

  info "Downloading NTT CLI ${version} for ${platform}..."

  mkdir -p "$BIN_DIR"

  local tmp_file
  tmp_file=$(mktemp)
  trap "rm -f '$tmp_file'" EXIT

  if ! curl -fsSL "$url" -o "$tmp_file"; then
    error "Failed to download from $url"
    error "The release may not exist yet for this platform."
    exit 1
  fi

  local bin_name="ntt"
  if [[ "$platform" == windows-* ]]; then
    bin_name="ntt.exe"
  fi

  mv "$tmp_file" "$BIN_DIR/$bin_name"
  chmod +x "$BIN_DIR/$bin_name"

  info "Installed to $BIN_DIR/$bin_name"

  # Store version info
  echo "$version" > "$INSTALL_DIR/version"
}

# Check if bin directory is in PATH
check_path() {
  if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
    warn "$BIN_DIR is not in your PATH"
    echo ""
    echo "Add the following to your shell configuration file (~/.bashrc, ~/.zshrc, etc.):"
    echo ""
    echo "  export PATH=\"$BIN_DIR:\$PATH\""
    echo ""
    echo "Then restart your terminal or run: source ~/.bashrc (or ~/.zshrc)"
  fi
}

# Verify installation
verify_install() {
  if [ -x "$BIN_DIR/ntt" ]; then
    info "Installation complete!"
    if command -v ntt &> /dev/null; then
      echo ""
      ntt --version
    fi
  else
    error "Installation failed"
    exit 1
  fi
}

main() {
  local version=""
  local from_source=false
  local include_prerelease=false

  while [[ $# -gt 0 ]]; do
    case "$1" in
      -v|--version)
        version="$2"
        shift 2
        ;;
      --from-source)
        from_source=true
        shift
        ;;
      --prerelease)
        include_prerelease=true
        shift
        ;;
      -h|--help)
        echo "Usage: install.sh [OPTIONS]"
        echo ""
        echo "Options:"
        echo "  -v, --version VERSION  Install a specific version (e.g., v1.7.0+cli)"
        echo "  --prerelease           Include prerelease/beta versions when finding latest"
        echo "  --from-source          Build from source instead of downloading binary"
        echo "  -h, --help             Show this help message"
        echo ""
        echo "Examples:"
        echo "  install.sh                        # Install latest stable release"
        echo "  install.sh --prerelease           # Install latest including prereleases"
        echo "  install.sh -v v1.7.0-beta.1+cli   # Install specific beta version"
        exit 0
        ;;
      *)
        error "Unknown option: $1"
        exit 1
        ;;
    esac
  done

  # Auto-detect: if we're in the repo with cli source, build from source
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [ -f "$script_dir/package.json" ] && grep -q '"@wormhole-foundation/ntt-cli"' "$script_dir/package.json"; then
    info "Detected local source tree, building from source..."
    install_from_source "$version" "$script_dir/.."
    return
  fi

  if [ "$from_source" = true ]; then
    info "Building from source..."
    install_from_source "$version"
    return
  fi

  local platform
  platform=$(detect_platform)

  if [ -z "$version" ]; then
    version=$(get_latest_version "$include_prerelease")
  fi

  install_binary "$version" "$platform"
  check_path
  verify_install
}

# Fallback: build from source (requires bun)
install_from_source() {
  local branch="${1:-}"
  local source_dir="${2:-}"

  if ! command -v bun &> /dev/null; then
    error "bun is required to build from source"
    error "Install bun: curl -fsSL https://bun.sh/install | bash"
    exit 1
  fi

  # If source_dir is provided, use it directly (local build)
  if [ -n "$source_dir" ]; then
    cd "$source_dir"
    info "Installing dependencies..."
    bun install

    info "Building..."
    bun run build

    info "Linking CLI..."
    cd cli
    bun link

    info "Built from source successfully"
    return
  fi

  # Otherwise clone the repo
  local checkout_dir="$INSTALL_DIR/.checkout"
  mkdir -p "$INSTALL_DIR"

  if [ ! -d "$checkout_dir" ]; then
    info "Cloning repository..."
    git clone "https://github.com/$REPO.git" "$checkout_dir"
  fi

  cd "$checkout_dir"
  git fetch origin

  if [ -n "$branch" ]; then
    git checkout "$branch"
  else
    # Find latest v*+cli tag
    local tag
    tag=$(git tag -l 'v*+cli' | sort -V | tail -1)
    if [ -n "$tag" ]; then
      git checkout "$tag"
    else
      git checkout origin/main
    fi
  fi

  info "Installing dependencies..."
  bun install

  info "Building..."
  bun run build

  info "Linking CLI..."
  cd cli
  bun link

  info "Built from source successfully"
}

main "$@"
