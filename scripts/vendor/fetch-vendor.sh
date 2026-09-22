#!/usr/bin/env bash
# fetch-vendor.sh — Download python-build-standalone and ripgrep assets via npmmirror (GitHub fallback).
# Usage:
#   ./fetch-vendor.sh [--arch x86_64|aarch64] [--all]
#
# Examples:
#   ./fetch-vendor.sh              # download for current host architecture
#   ./fetch-vendor.sh --arch x86_64
#   ./fetch-vendor.sh --all        # download both architectures

set -euo pipefail

CLEANUP_FILES=()
cleanup() {
    for f in "${CLEANUP_FILES[@]}"; do
        rm -rf "$f" 2>/dev/null || true
    done
}
trap cleanup EXIT INT TERM

# ─── Configuration ────────────────────────────────────────────────────────────

DEST_DIR="$(cd "$(dirname "$0")" && pwd)/python-build-standalone"
RELEASE_TAG="$(node -p 'require(process.argv[1]).release' "$DEST_DIR/manifest.json")"
CPYTHON_VERSION="$(node -p 'require(process.argv[1]).python' "$DEST_DIR/manifest.json")"

RIPGREP_VERSION="15.1.0"
RIPGREP_DEST_DIR="$(cd "$(dirname "$0")" && pwd)/ripgrep"

# URL patterns
NPM_MIRROR_BASE="https://registry.npmmirror.com/-/binary/python-build-standalone/${RELEASE_TAG}"
GITHUB_BASE="https://github.com/astral-sh/python-build-standalone/releases/download/${RELEASE_TAG}"

# ripgrep URL patterns
RIPGREP_NPM_MIRROR_BASE="https://registry.npmmirror.com/-/binary/ripgrep/${RIPGREP_VERSION}"
RIPGREP_GITHUB_BASE="https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}"

# ─── Helpers ──────────────────────────────────────────────────────────────────

info()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m[WARN]\033[0m %s\n' "$*" >&2; }
error() { printf '\033[1;31m[ERROR]\033[0m %s\n' "$*" >&2; exit 1; }

# This script only supports macOS (Darwin) — vendor assets are macOS-specific.
if [[ "$(uname -s)" != "Darwin" ]]; then
    error "This script only runs on macOS (Darwin). Detected OS: $(uname -s)"
fi

# Map uname -m output to our canonical arch names
detect_arch() {
    local raw
    raw="$(uname -m)"
    case "$raw" in
        arm64|aarch64) echo "aarch64" ;;
        x86_64)        echo "x86_64" ;;
        *)             error "Unsupported architecture: $raw" ;;
    esac
}

# Build the asset filename for a given arch
asset_filename() {
    local arch="$1"
    echo "cpython-${CPYTHON_VERSION}+${RELEASE_TAG}-${arch}-apple-darwin-install_only.tar.gz"
}

# Encode '+' as '%2B' for GitHub URLs
github_encode() {
    echo "$1" | sed 's/+/%2B/g'
}

# Compute SHA256 checksum in portable format: "<hash>  <filename>"
compute_sha256() {
    local filepath="$1"
    if command -v shasum &>/dev/null; then
        shasum -a 256 "$filepath"
    elif command -v sha256sum &>/dev/null; then
        sha256sum "$filepath"
    else
        error "No SHA256 tool found (need shasum or sha256sum)"
    fi
}

# Verify existing file against its sidecar checksum
verify_checksum() {
    local filepath="$1"
    local sidecar="${filepath}.sha256"

    [[ -f "$filepath" ]] || return 1
    [[ -f "$sidecar" ]] || return 1

    local expected actual
    expected="$(awk '{print $1}' "$sidecar")"
    actual="$(compute_sha256 "$filepath" | awk '{print $1}')"

    [[ "$expected" == "$actual" ]]
}

# Download a single asset
download_asset() {
    local arch="$1"
    local filename
    filename="$(asset_filename "$arch")"

    local dest_file="${DEST_DIR}/${filename}"
    local sidecar_file="${dest_file}.sha256"

    # Skip if already present and checksum matches
    if verify_checksum "$dest_file"; then
        info "✓ Already cached: ${filename}"
        return 0
    fi

    mkdir -p "$DEST_DIR"

    # Primary: npmmirror (no encoding needed for '+')
    local npm_url="${NPM_MIRROR_BASE}/${filename}"
    # Fallback: GitHub (encode '+' as '%2B')
    local gh_url="${GITHUB_BASE}/$(github_encode "$filename")"

    info "Downloading ${filename} ..."

    local success=false

    # Try npmmirror first
    info "  Source: npmmirror"
    if curl -fSL --progress-bar --retry 3 --retry-delay 5 -o "$dest_file" "$npm_url"; then
        success=true
    else
        warn "npmmirror failed, trying GitHub fallback..."
        info "  Source: GitHub"
        if curl -fSL --progress-bar --retry 3 --retry-delay 5 -o "$dest_file" "$gh_url"; then
            success=true
        fi
    fi

    if [[ "$success" != "true" ]]; then
        # Clean up partial download
        rm -f "$dest_file"
        error "Failed to download ${filename} from all sources"
    fi

    # Verify or generate SHA256 sidecar
    local actual_hash
    actual_hash="$(cd "$DEST_DIR" && compute_sha256 "$filename" | awk '{print $1}')"
    if [[ -f "$sidecar_file" ]]; then
        local expected_hash
        expected_hash="$(awk '{print $1}' "$sidecar_file")"
        if [[ "$actual_hash" != "$expected_hash" ]]; then
            rm -f "$dest_file"
            error "Downloaded file checksum mismatch! Expected: $expected_hash Got: $actual_hash"
        fi
        info "  Checksum verified against existing sidecar."
    else
        (cd "$DEST_DIR" && compute_sha256 "$filename") > "$sidecar_file"
        warn "⚠️  SECURITY: First download — generated new sidecar $sidecar_file."
        warn "⚠️  No pre-existing hash to verify against. Please review before committing!"
    fi

    info "✓ Saved: ${dest_file}"
    info "  SHA256: $actual_hash"
}

# Map canonical arch name to ripgrep release triple
ripgrep_triple() {
    local arch="$1"
    case "$arch" in
        aarch64) echo "aarch64-apple-darwin" ;;
        x86_64)  echo "x86_64-apple-darwin" ;;
        *)       error "Unsupported ripgrep architecture: $arch" ;;
    esac
}

# Download a single ripgrep binary
download_ripgrep() {
    local arch="$1"
    local triple
    triple="$(ripgrep_triple "$arch")"

    local filename="ripgrep-${RIPGREP_VERSION}-${triple}.tar.gz"
    local target_dir="${RIPGREP_DEST_DIR}/${triple}"
    local dest_file="${target_dir}/rg"
    local sidecar_file="${dest_file}.sha256"

    # Skip if already present and checksum matches
    if verify_checksum "$dest_file"; then
        info "✓ Already cached: ripgrep/${triple}/rg"
        return 0
    fi

    mkdir -p "$target_dir"

    # Primary: npmmirror
    local npm_url="${RIPGREP_NPM_MIRROR_BASE}/${filename}"
    # Fallback: GitHub
    local gh_url="${RIPGREP_GITHUB_BASE}/${filename}"

    info "Downloading ${filename} ..."

    local tmp_tarball
    tmp_tarball="$(mktemp "${target_dir}/rg-download.XXXXXX.tar.gz")"
    CLEANUP_FILES=("${CLEANUP_FILES[@]}" "$tmp_tarball")

    local success=false

    # Try npmmirror first
    info "  Source: npmmirror"
    if curl -fSL --progress-bar --retry 3 --retry-delay 5 -o "$tmp_tarball" "$npm_url"; then
        success=true
    else
        warn "npmmirror failed, trying GitHub fallback..."
        info "  Source: GitHub"
        if curl -fSL --progress-bar --retry 3 --retry-delay 5 -o "$tmp_tarball" "$gh_url"; then
            success=true
        fi
    fi

    if [[ "$success" != "true" ]]; then
        rm -f "$tmp_tarball"
        error "Failed to download ${filename} from all sources"
    fi

    # Extract just the rg binary from the tarball (path: ripgrep-<ver>-<triple>/rg)
    info "  Extracting rg binary ..."
    local tmp_extract
    tmp_extract="$(mktemp -d "${target_dir}/rg-extract.XXXXXX")"
    CLEANUP_FILES=("${CLEANUP_FILES[@]}" "$tmp_extract")
    if ! tar -xzf "$tmp_tarball" -C "$tmp_extract"; then
        rm -rf "$tmp_tarball" "$tmp_extract"
        error "Failed to extract ${filename}"
    fi

    local extracted_rg
    extracted_rg="$(find "$tmp_extract" -type f -name rg -print -quit)"
    if [[ -z "$extracted_rg" ]]; then
        rm -rf "$tmp_tarball" "$tmp_extract"
        error "Could not locate rg binary inside ${filename}"
    fi

    mv -f "$extracted_rg" "$dest_file"
    chmod 755 "$dest_file"

    # Clean up temp files
    rm -rf "$tmp_tarball" "$tmp_extract"

    # Verify or generate SHA256 sidecar
    local actual_hash
    actual_hash="$(cd "$target_dir" && compute_sha256 "rg" | awk '{print $1}')"
    if [[ -f "$sidecar_file" ]]; then
        local expected_hash
        expected_hash="$(awk '{print $1}' "$sidecar_file")"
        if [[ "$actual_hash" != "$expected_hash" ]]; then
            rm -f "$dest_file"
            error "Downloaded file checksum mismatch! Expected: $expected_hash Got: $actual_hash"
        fi
        info "  Checksum verified against existing sidecar."
    else
        (cd "$target_dir" && compute_sha256 "rg") > "$sidecar_file"
        warn "⚠️  SECURITY: First download — generated new sidecar $sidecar_file."
        warn "⚠️  No pre-existing hash to verify against. Please review before committing!"
    fi

    info "✓ Saved: ${dest_file}"
    info "  SHA256: $actual_hash"
}

# ─── Argument Parsing ─────────────────────────────────────────────────────────

ARCHS=()
DOWNLOAD_ALL=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --arch)
            [[ -n "${2:-}" ]] || error "--arch requires a value (x86_64 or aarch64)"
            case "$2" in
                x86_64|aarch64) ARCHS=("${ARCHS[@]}" "$2") ;;
                arm64)          ARCHS=("${ARCHS[@]}" "aarch64") ;;
                *)              error "Invalid architecture: $2 (expected x86_64 or aarch64)" ;;
            esac
            shift 2
            ;;
        --all)
            DOWNLOAD_ALL=true
            shift
            ;;
        -h|--help)
            sed -n '2,/^$/s/^# //p' "$0"
            exit 0
            ;;
        *)
            error "Unknown option: $1"
            ;;
    esac
done

# Resolve target architectures
if [[ "$DOWNLOAD_ALL" == "true" ]]; then
    ARCHS=("aarch64" "x86_64")
elif [[ ${#ARCHS[@]} -eq 0 ]]; then
    ARCHS=("$(detect_arch)")
fi

# ─── Main ─────────────────────────────────────────────────────────────────────

info "python-build-standalone + ripgrep vendor fetch"
info "  Release: ${RELEASE_TAG} | CPython: ${CPYTHON_VERSION} | ripgrep: ${RIPGREP_VERSION}"
info "  Target architectures: ${ARCHS[*]}"
info "  Destination: ${DEST_DIR}"
info "  ripgrep destination: ${RIPGREP_DEST_DIR}"
echo

for arch in "${ARCHS[@]}"; do
    download_asset "$arch"
    download_ripgrep "$arch"
    echo
done

info "Done."
