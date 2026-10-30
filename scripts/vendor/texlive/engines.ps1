param(
    [Parameter(Mandatory=$true)][string]$SourceArchive,
    [Parameter(Mandatory=$true)][string]$SourceSha256,
    [Parameter(Mandatory=$true)][string]$WorkDir,
    [Parameter(Mandatory=$true)][string]$VcRoot,
    [Parameter(Mandatory=$true)][string]$SdkRoot,
    [Parameter(Mandatory=$true)][string]$UcrtRoot,
    [Parameter(Mandatory=$true)][string]$ReferenceBin
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$recipe=Get-Content "$PSScriptRoot/engines.json" -Raw | ConvertFrom-Json
function Hash([string]$Path,[string]$Expected) {
    if((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -ne $Expected){throw "Digest mismatch: $Path"}
}
$SourceArchive=[IO.Path]::GetFullPath($SourceArchive)
$WorkDir=[IO.Path]::GetFullPath($WorkDir)
$VcRoot=[IO.Path]::GetFullPath($VcRoot)
$SdkRoot=[IO.Path]::GetFullPath($SdkRoot)
$UcrtRoot=[IO.Path]::GetFullPath($UcrtRoot)
$ReferenceBin=[IO.Path]::GetFullPath($ReferenceBin)
Hash $SourceArchive $SourceSha256
foreach($tool in $recipe.tools.PSObject.Properties){Hash "$VcRoot/bin/Hostx64/x64/$($tool.Name)" $tool.Value}
foreach($dll in $recipe.reference_dlls.PSObject.Properties){Hash "$ReferenceBin/$($dll.Name)" $dll.Value}
if(Test-Path -LiteralPath $WorkDir){throw 'Engine work directory must be new'}
New-Item -ItemType Directory -Path $WorkDir | Out-Null
& tar.exe -xzf $SourceArchive -C $WorkDir
if($LASTEXITCODE){throw 'Source extraction failed'}
$root="$WorkDir/engines"
Hash "$root/engines.json" (Get-FileHash "$PSScriptRoot/engines.json" -Algorithm SHA256).Hash
$inputs=Get-Content "$root/inputs.json" -Raw | ConvertFrom-Json
foreach($file in $inputs.PSObject.Properties){
    if($file.Name -match '(^/|(^|/)\.\.(/|$)|:)'){throw 'Invalid source member'}
    Hash "$root/$($file.Name)" $file.Value
}
$save=@{}
foreach($name in @('PATH','INCLUDE','LIB','CL','_CL_','LINK','TEMP','TMP')){$save[$name]=[Environment]::GetEnvironmentVariable($name,'Process')}
$start=Get-Location
try {
    $env:PATH="$VcRoot/bin/Hostx64/x64;$env:PATH"
    $env:INCLUDE="$VcRoot/include;$UcrtRoot/include;$SdkRoot/include/shared;$SdkRoot/include/um;$SdkRoot/include/winrt"
    $env:LIB="$VcRoot/lib/x64;$UcrtRoot/lib/x64;$SdkRoot/lib/x64"
    $env:CL='';$env:_CL_='';$env:LINK=''
    $env:TEMP="$WorkDir/temp";$env:TMP=$env:TEMP
    New-Item -ItemType Directory -Path $env:TEMP,"$WorkDir/out","$root/core/web2c/headers/teckit" -Force | Out-Null
    Copy-Item "$root/deps-shaping/teckit/source/Public-headers/*.h" "$root/core/web2c/headers/teckit"
    foreach($engine in @('xetex','pdftex')){
        $short=if($engine -eq 'xetex'){'xe'}else{'pdf'}
        Copy-Item "$root/core/web2c/synctexdir/synctex.c" "$root/core/web2c/synctex-$short.c"
        $header="$root/core/web2c/${engine}d.h"
        $text=Get-Content $header -Raw
        if($text -notmatch '__SyncTeX__'){
            $text=$text.Replace('#include "texmfmp.h"',"#define __SyncTeX__`n#include `"synctexdir/synctex-common.h`"`n#include `"texmfmp.h`"")
            if($text -notmatch '__SyncTeX__'){throw 'SyncTeX activation failed'}
            [IO.File]::WriteAllText($header,$text)
        }
        "#define SYNCTEX_ENGINE_H `"synctex-$engine.h`"" | Set-Content -Encoding ascii "$root/core/web2c/headers/synctex-$engine.h"
    }
    Set-Location "$WorkDir/out"
    "LIBRARY icudt78.dll`nEXPORTS`n icudt78_dat @1 DATA" | Set-Content -Encoding ascii icudt.def
    & lib.exe /nologo /def:icudt.def /machine:x64 /out:icudt.lib
    if($LASTEXITCODE){throw 'ICU data import library failed'}
    foreach($unit in $recipe.units){
        $output="$WorkDir/out/$($unit.name)"
        New-Item -ItemType Directory -Path $output | Out-Null
        Set-Location "$root/$($unit.base)"
        $flags=@('/nologo','/MT','/O2','/utf-8','/DWIN32=1','/DNO_KPSE_DLL=1','/D_CRT_SECURE_NO_WARNINGS','/D_CRT_NONSTDC_NO_DEPRECATE')
        $flags+=@($unit.includes | ForEach-Object {"/I$root/$_"})
        $flags+=@($unit.defines | ForEach-Object {"/D$_"})
        if($unit.name -in @('xetex','pdftex')){$flags+="/FI$root/core/web2c/headers/synctex-$($unit.name).h"}
        if($unit.name -eq 'harfbuzz'){$flags+='/bigobj'}
        $objects=@()
        foreach($file in $unit.sources.Split(' ')){
            $object="$output/$(($file -replace '/','_') -replace '\.[^.]+$','.obj')"
            $objects+=$object
            $options=@($flags)
            if($file -match '\.(cc|cpp)$'){$options+=@('/EHsc','/GR','/std:c++17')}
            elseif($unit.name -in @('xetex','pdftex')){$options+='/std:c11'}
            $options+=@('/c',$file,"/Fo$object")
            Add-Content "$WorkDir/commands.log" ('cl '+($options -join ' '))
            $ErrorActionPreference='Continue'
            & cl.exe @options 2>&1 | Out-Host
            $code=$LASTEXITCODE
            $ErrorActionPreference='Stop'
            if($code){throw "Compile failed: $($unit.name)/$file ($code)"}
        }
        Set-Location "$WorkDir/out"
        if($unit.links.Count){
            $libs=@($unit.links | ForEach-Object {"$WorkDir/out/$_.lib"})
            $libs+=@('user32.lib','advapi32.lib','shell32.lib','ws2_32.lib','gdi32.lib','rpcrt4.lib')
            & link.exe /nologo /DLL "/OUT:$($unit.name).dll" /SUBSYSTEM:CONSOLE /STACK:0x300000 @objects @libs
            if($LASTEXITCODE){throw "Engine link failed: $($unit.name)"}
            $exports=@((& link.exe /dump /exports "$($unit.name).dll") | Select-String '^\s+\d+\s+[0-9A-F]+\s+[0-9A-F]{8}\s+\S+')
            if($exports.Count -ne 1 -or $exports[0].Line -notmatch ('^\s+1\s+0\s+[0-9A-F]+\s+dll'+$unit.name+'main$')){throw 'Engine export mismatch'}
        } else {
            & lib.exe /nologo "/out:$($unit.name).lib" @objects
            if($LASTEXITCODE){throw "Library archive failed: $($unit.name)"}
        }
    }
    Get-FileHash "$WorkDir/out/xetex.dll","$WorkDir/out/pdftex.dll" | ConvertTo-Json | Set-Content "$WorkDir/hashes.json"
    Write-Output "Engine outputs: $WorkDir/out"
} finally {
    Set-Location $start
    foreach($name in $save.Keys){[Environment]::SetEnvironmentVariable($name,$save[$name],'Process')}
}
