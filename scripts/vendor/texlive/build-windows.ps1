# Assemble the frozen TeX Live asset that Desktop packaging ships under
# resources/backend/texlive/ on Windows.
#
# This recipe is the ONLY place that talks to a TeX Live mirror. Desktop
# packaging stays offline and consumes the committed archive plus its .sha256
# sidecar, exactly like scripts/vendor/python-build-standalone.
#
# Windows-specific considerations (relative to build.sh):
#   - The Windows installer is install-tl-windows.exe (a GUI/CLI hybrid), not
#     the Unix tarball. It must run on Windows to produce Windows binaries and
#     platform-specific .fmt files.
#   - pdflatex.exe is created by the installer as a copy of pdftex.exe; the
#     prune step must not delete it.
#   - Format files (.fmt) are platform-specific: a macOS tree cannot serve a
#     Windows build. fmtutil-sys must run on Windows after installation.
#   - Archive members use backslash-free paths (bsdtar / System32\tar.exe
#     normalizes), so the same extraction code works on both platforms.
#
# Usage: scripts\vendor\texlive\build-windows.ps1 [-WorkDir DIR] [-SkipOracle]
[CmdletBinding()]
param(
    [string]$WorkDir = "",
    [switch]$SkipOracle
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$TEXLIVE_VERSION = "2026"
$INSTALLER_TAG = "install-tl-20260916"
$INSTALLER_SHA256 = "15a2a023ff9137b127ce65fc3987d00ca3246d0d50dbf8fab12d1a9c9bd6420d"
$REPOSITORY = "https://mirrors.aliyun.com/CTAN/systems/texlive/tlnet"
$INSTALLER_URL = "$($REPOSITORY -replace '/tlnet$','/tlnet')/install-tl-windows.exe"
$SCHEME = "scheme-basic"
$ARCHIVE_NAME = "texlive-$TEXLIVE_VERSION-windows.tar.gz"

# Frozen package set. `bm` is deliberately absent: it is not a TeX Live package
# name (bm.sty already ships in scheme-basic) and tlmgr rejects it.
$PACKAGES = @(
    "xetex", "fontspec", "ctex", "xecjk", "fandol", "zhnumber", "cjk", "cjkpunct",
    "pgf", "xcolor", "forest", "natbib", "units", "microtype", "booktabs",
    "caption", "hyperref", "geometry", "environ", "lineno", "times", "psnfss"
)

# Engines and tools the product never invokes. XeLaTeX/pdfLaTeX/BibTeX stay.
# Note: pdflatex.exe is a copy of pdftex.exe created by the installer; do not
# add it to the prune list.
$PRUNE_BINARIES = @(
    "luatex.exe", "luahbtex.exe", "lualatex.exe", "luaotfload-tool.exe",
    "luajithbtex.exe", "luajittex.exe", "pmpost.exe", "upmpost.exe",
    "mpost.exe", "euptex.exe", "uptex.exe", "ptex.exe", "eptex.exe",
    "platex.exe", "uplatex.exe", "xelatex-dev.exe", "xdvi-xaw.exe",
    "ttf2tfm.exe", "ttf2pk.exe", "ttf2afm.exe", "odvips.exe", "odvipng.exe",
    "aleph.exe", "omega.exe", "chktex.exe", "lacheck.exe"
)

# Legacy CJK-package fonts plus Japanese/Korean trees. Chinese runs through
# xeCJK with the bundled Fandol fonts, so none of these are reachable.
$PRUNE_FONT_DIRS = @(
    "type1/arphic", "type1/wadalab", "type1/uhc",
    "afm/arphic", "afm/wadalab", "afm/uhc",
    "tfm/arphic", "tfm/uhc",
    "vf/uptex-fonts", "vf/ptex-fonts", "vf/uhc"
)
$PRUNE_FORMAT_DIRS = @("luatex", "luahbtex", "euptex", "uptex", "ptex", "platex", "uplatex")
$PRUNE_TEX_DIRS = @("tex/platex", "tex/uplatex", "tex/luatex")

$VENDOR_DIR = $PSScriptRoot
$REPO = (Resolve-Path "$VENDOR_DIR/../../..").Path

if (-not $WorkDir) {
    $WorkDir = Join-Path $env:TEMP "texlive-vendor-$(Get-Random)"
}
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
Write-Host "[texlive] work directory: $WorkDir"

try {
    # ── 1. installer ──────────────────────────────────────────────────────────
    Push-Location $WorkDir
    $installerPath = "install-tl-windows.exe"
    if (-not (Test-Path $installerPath)) {
        Write-Host "[texlive] downloading installer from $INSTALLER_URL"
        Invoke-WebRequest -Uri $INSTALLER_URL -OutFile $installerPath -UseBasicParsing
    }
    $actual = (Get-FileHash -Algorithm SHA256 $installerPath).Hash.ToLower()
    if ($actual -ne $INSTALLER_SHA256) {
        throw "[texlive] installer checksum differs: $actual"
    }

    # ── 2. scheme-basic into a hermetic prefix ────────────────────────────────
    $treeDir = "$WorkDir/tree"
    $homeDir = "$WorkDir/home"
    $localDir = "$WorkDir/texmf-local"
    New-Item -ItemType Directory -Force -Path $homeDir | Out-Null

    $profileContent = @"
selected_scheme $SCHEME
TEXDIR $treeDir
TEXMFCONFIG $homeDir/texmf-config
TEXMFHOME $homeDir/texmf
TEXMFLOCAL $localDir
TEXMFSYSCONFIG $treeDir/texmf-config
TEXMFSYSVAR $treeDir/texmf-var
TEXMFVAR $homeDir/texmf-var
instopt_adjustpath 0
instopt_adjustrepo 0
instopt_letter 0
instopt_portable 0
instopt_write18_restricted 1
tlpdbopt_autobackup 0
tlpdbopt_create_formats 1
tlpdbopt_desktop_integration 0
tlpdbopt_file_assocs 0
tlpdbopt_generate_updmap 0
tlpdbopt_install_docfiles 0
tlpdbopt_install_srcfiles 0
tlpdbopt_post_code 1
"@
    $profilePath = "$WorkDir/texlive.profile"
    Set-Content -Path $profilePath -Value $profileContent -NoNewline

    Write-Host "[texlive] running installer (this may take several minutes)"
    $env:HOME = $homeDir
    & "$WorkDir/$installerPath" -profile $profilePath -repository $REPOSITORY -no-interaction | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "[texlive] installer failed with exit code $LASTEXITCODE"
    }

    $binDir = "$treeDir/bin/windows"
    if (-not (Test-Path "$binDir/pdflatex.exe")) {
        throw "[texlive] expected a windows binary directory with pdflatex.exe"
    }

    # ── 3. frozen package set ─────────────────────────────────────────────────
    Write-Host "[texlive] installing frozen package set"
    $env:HOME = $homeDir
    $env:PATH = "$binDir;$env:PATH"
    & "$binDir\tlmgr.bat" --repository $REPOSITORY install @PACKAGES | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "[texlive] tlmgr install failed with exit code $LASTEXITCODE"
    }

    # ── 4. prune ──────────────────────────────────────────────────────────────
    Write-Host "[texlive] pruning unused binaries and fonts"
    Push-Location $binDir
    foreach ($name in $PRUNE_BINARIES) {
        if (Test-Path $name) { Remove-Item $name -Force }
    }
    Pop-Location

    Push-Location "$treeDir/texmf-dist/fonts"
    foreach ($relative in $PRUNE_FONT_DIRS) {
        if (Test-Path $relative) { Remove-Item $relative -Recurse -Force }
    }
    Pop-Location

    Push-Location "$treeDir/texmf-var/web2c"
    foreach ($relative in $PRUNE_FORMAT_DIRS) {
        if (Test-Path $relative) { Remove-Item $relative -Recurse -Force }
    }
    Pop-Location

    Push-Location "$treeDir/texmf-dist"
    foreach ($relative in $PRUNE_TEX_DIRS) {
        if (Test-Path $relative) { Remove-Item $relative -Recurse -Force }
    }
    Pop-Location

    # Check for dangling symlinks (Windows junctions or broken links)
    $dangling = Get-ChildItem -Path $treeDir -Recurse -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.Attributes -match "ReparsePoint" -and -not (Test-Path $_.FullName) } |
        Select-Object -First 5
    if ($dangling) {
        Write-Host "[texlive] WARNING: dangling symlinks found:" -ForegroundColor Yellow
        $dangling | ForEach-Object { Write-Host "  $_" }
    }

    # ── 5. formats for the retained engines, while tlpkg still exists ─────────
    Write-Host "[texlive] generating format files for pdftex and xetex"
    $env:HOME = $homeDir
    $env:PATH = "$binDir;$env:PATH"
    & fmtutil-sys --byengine pdftex,xetex | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "[texlive] fmtutil-sys failed with exit code $LASTEXITCODE"
    }

    # ── 6. drop the package database and installer residue, rehash ────────────
    Write-Host "[texlive] removing tlpkg and installer residue"
    Remove-Item -Recurse -Force "$treeDir/tlpkg" -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force "$treeDir/install-tl" -ErrorAction SilentlyContinue
    Remove-Item -Force "$treeDir/install-tl.log" -ErrorAction SilentlyContinue

    $env:HOME = $homeDir
    $env:PATH = "$binDir;$env:PATH"
    & mktexlsr | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "[texlive] mktexlsr failed with exit code $LASTEXITCODE"
    }

    # ── 7. compile oracle against the skill's real preambles ──────────────────
    if (-not $SkipOracle) {
        Write-Host "[texlive] running compile oracle"
        $skill = "$REPO/skills/community/literature-review"
        $pythonBin = "$REPO/.venv/Scripts/python.exe"
        if (-not (Test-Path $pythonBin)) {
            $pythonBin = (Get-Command python.exe -ErrorAction SilentlyContinue).Source
            if (-not $pythonBin) { throw "[texlive] python not found" }
        }
        $env:HOME = $homeDir
        $env:PATH = "$binDir;$env:PATH"
        $oracleOutput = & $pythonBin "$skill/scripts/smoke_publication.py" 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "[texlive] compile oracle failed`n$oracleOutput"
        }
        # The oracle reports the engines it resolved; a host TeX must never be able to
        # stand in for the tree being frozen.
        if (-not ($oracleOutput -match '"xelatex":\s*"[^"]*\\bin\\windows\\xelatex.exe"')) {
            throw "[texlive] oracle did not use the staged toolchain`n$oracleOutput"
        }
    }

    # ── 8. freeze ─────────────────────────────────────────────────────────────
    Write-Host "[texlive] creating archive"
    Pop-Location
    Push-Location $WorkDir

    # Normalize timestamps for reproducibility (Windows: use LastWriteTime)
    $epoch = [DateTime]::new(1970, 1, 1, 0, 0, 0, [DateTimeKind]::Utc)
    Get-ChildItem -Path tree -Recurse -Force | ForEach-Object {
        $_.LastWriteTime = $epoch
    }

    # Rehash after touching (ls-R must stay newer than the tree)
    $env:HOME = $homeDir
    $env:PATH = "$binDir;$env:PATH"
    & mktexlsr | Out-Null

    Rename-Item tree texlive
    # Use System32\tar.exe (bsdtar) for consistent cross-platform extraction
    $tarExe = "$env:SystemRoot\System32\tar.exe"
    if (-not (Test-Path $tarExe)) {
        throw "[texlive] System32\tar.exe not found; Windows 10 1803+ required"
    }
    & $tarExe -czf "$VENDOR_DIR/$ARCHIVE_NAME" texlive
    if ($LASTEXITCODE -ne 0) {
        throw "[texlive] tar failed with exit code $LASTEXITCODE"
    }
    Rename-Item texlive tree

    Pop-Location
    Push-Location $VENDOR_DIR
    $sha256 = (Get-FileHash -Algorithm SHA256 $ARCHIVE_NAME).Hash.ToLower()
    "$sha256  $ARCHIVE_NAME" | Out-File -FilePath "$ARCHIVE_NAME.sha256" -Encoding ASCII -NoNewline

    $treeSize = (Get-ChildItem -Path "$WorkDir/tree" -Recurse -Force | Measure-Object -Property Length -Sum).Sum / 1MB
    $archiveSize = (Get-Item "$VENDOR_DIR/$ARCHIVE_NAME").Length / 1MB
    Write-Host "[texlive] tree: $([math]::Round($treeSize))M"
    Write-Host "[texlive] archive: $([math]::Round($archiveSize))M"
    Write-Host "[texlive] sha256: $sha256"
    Pop-Location

} finally {
    # Cleanup is optional: the user may want to inspect the tree. Pass -WorkDir
    # to control where it lives; without it, the temp directory is used.
    Write-Host "[texlive] work directory preserved at: $WorkDir"
}
