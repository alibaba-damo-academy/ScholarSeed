#!/bin/bash
# Assemble the frozen TeX Live asset that Desktop packaging ships under
# resources/backend/texlive/.
#
# This recipe is the ONLY place that talks to a TeX Live mirror. Desktop
# packaging stays offline and consumes the committed archive plus its .sha256
# sidecar, exactly like scripts/vendor/python-build-standalone.
#
# Order is load-bearing:
#   1. fmtutil needs the TeXLive Perl modules in tlpkg/, so formats must be
#      generated BEFORE tlpkg is removed.
#   2. fmtutil must be scoped with --byengine: the prune step deletes the other
#      engines, and `--all` then exits 13 on the missing ones.
#
# Usage: scripts/vendor/texlive/build.sh [--work DIR] [--skip-oracle]
set -euo pipefail

TEXLIVE_VERSION="2026"
INSTALLER_TAG="install-tl-20260916"
INSTALLER_SHA256="1280e7948882147b52f8b2a42b6d4da0abf5650fdbd401f804d96e8ee3fc638a"
REPOSITORY="https://mirrors.aliyun.com/CTAN/systems/texlive/tlnet"
INSTALLER_URL="${REPOSITORY%/tlnet}/tlnet/install-tl-unx.tar.gz"
SCHEME="scheme-basic"
ARCHIVE_NAME="texlive-${TEXLIVE_VERSION}-universal-darwin.tar.gz"

# Frozen package set. `bm` is deliberately absent: it is not a TeX Live package
# name (bm.sty already ships in scheme-basic) and tlmgr rejects it.
PACKAGES="xetex fontspec ctex xecjk fandol zhnumber cjk cjkpunct pgf xcolor forest
natbib units microtype booktabs caption hyperref geometry environ lineno times psnfss"

# Engines and tools the product never invokes. XeLaTeX/pdfLaTeX/BibTeX stay.
PRUNE_BINARIES="luatex luahbtex lualatex luaotfload-tool luajithbtex luajittex
pmpost upmpost mpost euptex uptex ptex eptex platex uplatex xelatex-dev xdvi-xaw
ttf2tfm ttf2pk ttf2afm odvips odvipng aleph omega chktex lacheck"

# Legacy CJK-package fonts plus Japanese/Korean trees. Chinese runs through
# xeCJK with the bundled Fandol fonts, so none of these are reachable.
PRUNE_FONT_DIRS="type1/arphic type1/wadalab type1/uhc afm/arphic afm/wadalab
afm/uhc tfm/arphic tfm/uhc vf/uptex-fonts vf/ptex-fonts vf/uhc"
PRUNE_FORMAT_DIRS="luatex luahbtex euptex uptex ptex platex uplatex"
PRUNE_TEX_DIRS="tex/platex tex/uplatex tex/luatex"

VENDOR_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO="$(CDPATH= cd -- "${VENDOR_DIR}/../../.." && pwd)"
WORK=""
SKIP_ORACLE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --work) WORK="${2:?--work requires a directory}"; shift 2 ;;
    --skip-oracle) SKIP_ORACLE=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$WORK" ]; then
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/texlive-vendor-XXXXXX")"
  trap 'rm -rf "$WORK"' EXIT
fi
mkdir -p "$WORK"
echo "[texlive] work directory: $WORK"

# ── 1. installer ────────────────────────────────────────────────────────────
cd "$WORK"
if [ ! -f install-tl-unx.tar.gz ]; then
  curl -fSL --retry 3 --retry-delay 5 -o install-tl-unx.tar.gz "$INSTALLER_URL"
fi
actual="$(shasum -a 256 install-tl-unx.tar.gz | awk '{print $1}')"
if [ "$actual" != "$INSTALLER_SHA256" ]; then
  echo "[texlive] installer checksum differs: $actual" >&2
  exit 1
fi
tar xzf install-tl-unx.tar.gz
installer_dir="$(echo install-tl-*/ | head -1)"
installer_dir="${installer_dir%/}"

# ── 2. scheme-basic into a hermetic prefix ──────────────────────────────────
mkdir -p "$WORK/home"
profile="$WORK/texlive.profile"
{
  echo "selected_scheme ${SCHEME}"
  echo "TEXDIR ${WORK}/tree"
  echo "TEXMFCONFIG ${WORK}/home/texmf-config"
  echo "TEXMFHOME ${WORK}/home/texmf"
  echo "TEXMFLOCAL ${WORK}/texmf-local"
  echo "TEXMFSYSCONFIG ${WORK}/tree/texmf-config"
  echo "TEXMFSYSVAR ${WORK}/tree/texmf-var"
  echo "TEXMFVAR ${WORK}/home/texmf-var"
  echo "instopt_adjustpath 0"
  echo "instopt_adjustrepo 0"
  echo "instopt_letter 0"
  echo "instopt_portable 0"
  echo "instopt_write18_restricted 1"
  echo "tlpdbopt_autobackup 0"
  echo "tlpdbopt_create_formats 1"
  echo "tlpdbopt_desktop_integration 0"
  echo "tlpdbopt_file_assocs 0"
  echo "tlpdbopt_generate_updmap 0"
  echo "tlpdbopt_install_docfiles 0"
  echo "tlpdbopt_install_srcfiles 0"
  echo "tlpdbopt_post_code 1"
} > "$profile"
HOME="$WORK/home" "./${installer_dir}/install-tl" --profile "$profile" \
  --repository "$REPOSITORY" --no-interaction

bin_dir="$WORK/tree/bin/universal-darwin"
if [ ! -x "$bin_dir/pdflatex" ]; then
  echo "[texlive] expected a universal-darwin binary directory" >&2
  exit 1
fi

# ── 3. frozen package set ───────────────────────────────────────────────────
# shellcheck disable=SC2086
HOME="$WORK/home" "$bin_dir/tlmgr" --repository "$REPOSITORY" install $PACKAGES

# ── 4. prune ────────────────────────────────────────────────────────────────
cd "$bin_dir"
for name in $PRUNE_BINARIES; do rm -f "$name"; done
# install-tl links `man` into texmf-dist/doc, which instopt_install_docfiles 0
# never creates; shipping a dangling link is a defect, not a saving.
rm -f man
cd "$WORK/tree/texmf-dist/fonts"
for relative in $PRUNE_FONT_DIRS; do rm -rf "$relative"; done
cd "$WORK/tree/texmf-var/web2c"
for relative in $PRUNE_FORMAT_DIRS; do rm -rf "$relative"; done
cd "$WORK/tree/texmf-dist"
for relative in $PRUNE_TEX_DIRS; do rm -rf "$relative"; done
cd "$WORK"
dangling="$(find tree -type l ! -exec test -e {} \; -print | head -5)"
if [ -n "$dangling" ]; then
  echo "[texlive] dangling symlinks survived the prune:" >&2
  echo "$dangling" >&2
  exit 1
fi

# ── 5. formats for the retained engines, while tlpkg still exists ───────────
HOME="$WORK/home" PATH="$bin_dir:$PATH" fmtutil-sys --byengine pdftex,xetex

# ── 6. drop the package database and installer residue, rehash ──────────────
rm -rf "$WORK/tree/tlpkg" "$WORK/tree/install-tl" "$WORK/tree/install-tl.log"
HOME="$WORK/home" PATH="$bin_dir:$PATH" mktexlsr

# ── 7. compile oracle against the skill's real preambles ────────────────────
if [ "$SKIP_ORACLE" -eq 0 ]; then
  skill="${REPO}/skills/community/literature-review"
  python_bin="${REPO}/.venv/bin/python"
  [ -x "$python_bin" ] || python_bin="$(command -v python3)"
  oracle="$(PATH="$bin_dir:$PATH" HOME="$WORK/home" \
    "$python_bin" "${skill}/scripts/smoke_publication.py")" \
    || { echo "[texlive] compile oracle failed" >&2; exit 1; }
  # The oracle reports the engines it resolved; a host TeX must never be able to
  # stand in for the tree being frozen.
  case "$oracle" in
    *"\"xelatex\": \"${bin_dir}/xelatex\""*) : ;;
    *) echo "[texlive] oracle did not use the staged toolchain" >&2; exit 1 ;;
  esac
fi

# ── 8. freeze ───────────────────────────────────────────────────────────────
# bsdtar (macOS /usr/bin/tar, Windows System32\tar.exe) has neither --mtime nor
# --sort, so determinism comes from normalizing member mtimes on disk and
# stripping the gzip header. Member ORDER still follows the filesystem walk, so
# a re-run yields an equivalent tree verified by the oracle, not necessarily
# identical bytes. The committed archive plus its sidecar are the record.
cd "$WORK"
# Skip symlinks: touch follows them, and the tree keeps internal links whose
# targets were just normalized.
find tree ! -type l -exec touch -t 197001010000.00 {} +
# ls-R must stay newer than the tree it indexes, so rehash after touching.
HOME="$WORK/home" PATH="$bin_dir:$PATH" mktexlsr
mv tree texlive
COPYFILE_DISABLE=1 tar -cf - texlive | gzip -n > "${VENDOR_DIR}/${ARCHIVE_NAME}"
mv texlive tree
cd "$VENDOR_DIR"
shasum -a 256 "$ARCHIVE_NAME" > "${ARCHIVE_NAME}.sha256"

echo "[texlive] tree: $(du -sh "$WORK/tree" | awk '{print $1}')"
echo "[texlive] archive: $(du -sh "${VENDOR_DIR}/${ARCHIVE_NAME}" | awk '{print $1}')"
echo "[texlive] sha256: $(awk '{print $1}' "${ARCHIVE_NAME}.sha256")"
