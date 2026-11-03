# Build the reviewed MSVC kpathsea DLL; never modify an installed runtime.
# Requires VC10 RTM x64, Windows SDK 7.1, and Git for the exact source patch.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$WorkDir,
    [Parameter(Mandatory=$true)][string]$VcRoot,
    [Parameter(Mandatory=$true)][string]$WindowsSdkRoot,
    [Parameter(Mandatory=$true)][string]$ReferenceDll,
    [Parameter(Mandatory=$true)][string]$SourceCache
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$VcRoot = (Resolve-Path -LiteralPath $VcRoot).Path
$WindowsSdkRoot = (Resolve-Path -LiteralPath $WindowsSdkRoot).Path
$ReferenceDll = (Resolve-Path -LiteralPath $ReferenceDll).Path
$recipe = Get-Content -LiteralPath "$PSScriptRoot/kpathsea.json" -Raw | ConvertFrom-Json
$tar = "$env:SystemRoot/System32/tar.exe"
$git = (Get-Command git.exe -ErrorAction Stop).Source
$cl = "$VcRoot/bin/amd64/cl.exe"
$link = "$VcRoot/bin/amd64/link.exe"
$dumpbin = "$VcRoot/bin/amd64/dumpbin.exe"
$mt = "$WindowsSdkRoot/Bin/x64/mt.exe"

function Assert-Hash([string]$Path, [string]$Expected) {
    if ((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Expected) {
        throw "[kpathsea] unexpected SHA256: $Path"
    }
}
function Invoke-Checked([string]$Program, [string[]]$Arguments) {
    & $Program @Arguments | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "[kpathsea] $Program failed ($LASTEXITCODE)" }
}
function Get-Archive($Spec) {
    $target = Join-Path $SourceCache $Spec.filename
    if (!(Test-Path -LiteralPath $target)) {
        Invoke-WebRequest -Uri $Spec.url -OutFile $target -UseBasicParsing
    }
    Assert-Hash $target $Spec.sha256
    return $target
}
function Get-Abi([string]$Dll) {
    $exports = & $dumpbin /exports $Dll
    if ($LASTEXITCODE -ne 0) { throw '[kpathsea] export inspection failed' }
    $imports = & $dumpbin /imports $Dll
    if ($LASTEXITCODE -ne 0) { throw '[kpathsea] import inspection failed' }
    $names = @($exports | ForEach-Object {
        if ($_ -match '^\s+(\d+)\s+[0-9A-F]+\s+[0-9A-F]+\s+(\S+)') { "$($Matches[1]):$($Matches[2])" }
    })
    $libraries = @($imports | ForEach-Object {
        if ($_ -match '^\s+([A-Za-z0-9_.-]+\.dll)\s*$') { $Matches[1].ToLowerInvariant() }
    } | Sort-Object -Unique)
    if (!$names.Count -or !$libraries.Count) { throw '[kpathsea] empty ABI inspection' }
    return @{exports=$names; imports=$libraries}
}

Assert-Hash $ReferenceDll $recipe.reference_dll_sha256
Assert-Hash $cl $recipe.compiler_sha256
Assert-Hash $link $recipe.linker_sha256
Assert-Hash $mt $recipe.manifest_tool_sha256
if (Test-Path -LiteralPath $WorkDir) { throw '[kpathsea] WorkDir must be a new directory' }
if (!(Test-Path -LiteralPath $ReferenceDll -PathType Leaf)) { throw '[kpathsea] reference DLL missing' }
New-Item -ItemType Directory -Force -Path $SourceCache | Out-Null
New-Item -ItemType Directory -Path $WorkDir | Out-Null
$WorkDir = (Resolve-Path -LiteralPath $WorkDir).Path
$SourceCache = (Resolve-Path -LiteralPath $SourceCache).Path
$sourceArchive = Get-Archive $recipe.source_archive
$windowsArchive = Get-Archive $recipe.recipe_archive
$sourceMember = 'texlive-20260301-source/texk/kpathsea'
Invoke-Checked $tar @('-xJf', $sourceArchive, '-C', $WorkDir, $sourceMember)
$generated = @($recipe.generated_inputs.PSObject.Properties.Name)
Invoke-Checked $tar (@('-xJf', $windowsArchive, '-C', $WorkDir) + $generated + @($recipe.extra_header.path))
$library = Join-Path $WorkDir $sourceMember
foreach ($item in $recipe.generated_inputs.PSObject.Properties) {
    $inputPath = Join-Path $WorkDir $item.Name
    Assert-Hash $inputPath $item.Value
    Copy-Item -LiteralPath $inputPath -Destination $library
}
$header = Join-Path $WorkDir $recipe.extra_header.path
Assert-Hash $header $recipe.extra_header.sha256
$utf8 = New-Object System.Text.UTF8Encoding($false)
$configPath = Join-Path $library 'c-auto.h'
$config = [IO.File]::ReadAllText($configPath)
if (!$config.Contains('kpathsea version 6.4.1')) { throw '[kpathsea] unexpected generated configuration' }
$config = $config.Replace('kpathsea version 6.4.1', 'kpathsea version 6.4.2')
# Keep the string macro in a header: PS 5.1 and PS 7 bind native quotes differently.
$config = $config.Replace('#endif /* !KPATHSEA_C_AUTO_H */',
    '#define EXEEXT ".exe"' + "`n#endif /* !KPATHSEA_C_AUTO_H */")
[IO.File]::WriteAllText($configPath, $config, $utf8)
$program = Join-Path $library 'progname.c'
Assert-Hash $program $recipe.original_progname_sha256
$patch = (Resolve-Path -LiteralPath "$PSScriptRoot/discovery.patch").Path
Push-Location (Join-Path $WorkDir 'texlive-20260301-source')
try {
    # Bound Git to this extracted tree even when WorkDir is inside a checkout.
    Invoke-Checked $git @('init', '--quiet')
    Invoke-Checked $git @('-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'apply', '--check', '--', $patch)
    Invoke-Checked $git @('-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'apply', '--', $patch)
} finally { Pop-Location }
Assert-Hash $program $recipe.patched_progname_sha256

$sources = @(
    'tex-file.c','absolute.c','atou.c','cnf.c','concat.c','concat3.c','concatn.c',
    'db.c','debug.c','dir.c','elt-dirs.c','expand.c','extend-fname.c','file-p.c',
    'find-suffix.c','fn.c','fontmap.c','getopt.c','getopt1.c','hash.c','kdefault.c',
    'kpathsea.c','line.c','magstep.c','make-suffix.c','path-elt.c','pathsearch.c',
    'proginit.c','progname.c','readable.c','rm-suffix.c','str-list.c','str-llist.c',
    'tex-glyph.c','tex-hush.c','tex-make.c','tilde.c','uppercasify.c','variable.c',
    'version.c','xbasename.c','xcalloc.c','xdirname.c','xfopen.c','xfseek.c','xftell.c',
    'xgetcwd.c','xmalloc.c','xopendir.c','xputenv.c','xrealloc.c','xstat.c',
    'xstrdup.c','dirent.c','knj.c','win32lib.c'
)
$originalEnvironment = @{}
foreach ($name in @('PATH','INCLUDE','LIB','TMP','TEMP','CL','_CL_','LINK')) {
    $originalEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
try {
    foreach ($name in @('CL','_CL_','LINK')) {
        [Environment]::SetEnvironmentVariable($name, $null, 'Process')
    }
    $env:PATH = "$VcRoot/bin/amd64;$env:PATH"
    $env:INCLUDE = "$VcRoot/include;$WindowsSdkRoot/Include;$(Split-Path $header)"
    $env:LIB = "$VcRoot/lib/amd64;$WindowsSdkRoot/Lib/x64"
    $env:TEMP = Join-Path $WorkDir 'temp'
    $env:TMP = $env:TEMP
    New-Item -ItemType Directory -Path $env:TEMP | Out-Null
    Push-Location $library
    try {
        Invoke-Checked $cl (@('-nologo','-W3','-favor:blend','-MD','-O2',
            '-DHAVE_CONFIG_H','-DWIN32=1','-DMAKE_KPSE_DLL=1',
            '-D_CRT_SECURE_NO_DEPRECATE','-I.','-I..','-c') + $sources)
        $objects = @($sources | ForEach-Object { $_ -replace '\.c$', '.obj' })
        Invoke-Checked $link (@('-DLL','-out:kpathsealibw64.dll') + $objects + @(
            'user32.lib','advapi32.lib','shell32.lib','/MANIFEST'))
        Invoke-Checked $mt @('-nologo','-manifest','kpathsealibw64.dll.manifest',
            '-outputresource:kpathsealibw64.dll;2')
        $result = Join-Path $library 'kpathsealibw64.dll'
        $reference = Get-Abi $ReferenceDll
        $candidate = Get-Abi $result
        if (($reference.exports -join "`n") -cne ($candidate.exports -join "`n") -or
            ($reference.imports -join "`n") -cne ($candidate.imports -join "`n")) {
            throw '[kpathsea] ABI differs from the staged upstream DLL'
        }
        if ($candidate.imports -notcontains 'msvcr100.dll') { throw '[kpathsea] wrong CRT' }
        Copy-Item -LiteralPath $result -Destination (Join-Path $WorkDir 'kpathsealibw64.dll')
        $candidate | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $WorkDir 'abi.json')
    } finally { Pop-Location }
} finally {
    foreach ($name in $originalEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $originalEnvironment[$name], 'Process')
    }
}
# Preserve complete corresponding library sources, generated headers, license,
# inttypes header, patch and build recipe together for publication with the binary.
Copy-Item -LiteralPath $header -Destination $library
Copy-Item -LiteralPath "$PSScriptRoot/kpathsea.ps1","$PSScriptRoot/kpathsea.json",$patch -Destination $library
Get-ChildItem -LiteralPath $library -File | Where-Object {
    $_.Extension -in @('.obj','.dll','.lib','.exp')
} | Remove-Item
Invoke-Checked $tar @('-czf', (Join-Path $WorkDir 'kpathsea-source.tar.gz'), '-C',
    (Join-Path $WorkDir 'texlive-20260301-source/texk'), 'kpathsea')
Write-Host "[kpathsea] DLL and corresponding sources: $WorkDir"
