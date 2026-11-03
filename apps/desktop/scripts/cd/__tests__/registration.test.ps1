param([Parameter(Mandatory=$true)][string]$TaskRoot)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path (Split-Path $PSScriptRoot -Parent) 'registration.psm1') -Force
$namespace = 'Software\ScholarSeedCiTests\' + [guid]::NewGuid().ToString('N')
$installKey = $namespace + '\Install'
$uninstallKey = $namespace + '\Uninstall'
$base = [Microsoft.Win32.Registry]::CurrentUser
$allowed = Join-Path $TaskRoot 'allowed'
$orphan = Join-Path $allowed 'job\apps\desktop\release\preview-win32-x86_64\native-install\app'
New-Item -ItemType Directory -Path $allowed -Force | Out-Null
function Assert([bool]$Condition, [string]$Message) { if(-not $Condition){throw $Message} }
function SetFixture([string]$Root, [string]$Command) {
    $a = $base.CreateSubKey($installKey)
    $b = $base.CreateSubKey($uninstallKey)
    try { $a.SetValue('InstallLocation',$Root); $b.SetValue('UninstallString',$Command) }
    finally { $a.Dispose();$b.Dispose() }
}
function CommandFor([string]$Root) { return '"' + (Join-Path $Root 'Uninstall ScholarSeed.exe') + '" /currentuser' }
try {
    SetFixture $orphan (CommandFor $orphan)
    Assert (-not (Repair-CiLegacyRegistration $base $installKey $uninstallKey '' '/currentuser')) 'No opt-in must remain read-only'
    Assert (Repair-CiLegacyRegistration $base $installKey $uninstallKey $allowed '/currentuser') 'Exact absent CI pair must be reclaimed'
    Assert ($null -eq $base.OpenSubKey($installKey)) 'Install key remains'
    Assert ($null -eq $base.OpenSubKey($uninstallKey)) 'Uninstall key remains'
    Assert (-not (Repair-CiLegacyRegistration $base $installKey $uninstallKey $allowed '/currentuser')) 'Already absent must be idempotent'
    SetFixture $orphan (CommandFor $orphan)
    New-Item -ItemType Directory -Path $orphan -Force | Out-Null
    Assert (-not (Repair-CiLegacyRegistration $base $installKey $uninstallKey $allowed '/currentuser')) 'Real installation must survive'
    Remove-Item -LiteralPath $orphan
    SetFixture $orphan 'unexpected uninstall command'
    Assert (-not (Repair-CiLegacyRegistration $base $installKey $uninstallKey $allowed '/currentuser')) 'Unknown command must survive'
    SetFixture $orphan (CommandFor $orphan)
    Assert (-not (Repair-CiLegacyRegistration $base $installKey $uninstallKey $allowed '/allusers')) 'Wrong scope must survive'
    $child = $base.CreateSubKey($installKey+'\extra');$child.Dispose()
    Assert (-not (Repair-CiLegacyRegistration $base $installKey $uninstallKey $allowed '/currentuser')) 'Nested key must survive'
    $base.DeleteSubKey($installKey+'\extra')
    $outside = Join-Path $TaskRoot 'other\apps\desktop\release\preview-win32-x86_64\native-install\app'
    SetFixture $outside (CommandFor $outside)
    Assert (-not (Repair-CiLegacyRegistration $base $installKey $uninstallKey $allowed '/currentuser')) 'Outside root must survive'
    $ordinary = Join-Path $allowed 'user-app'
    SetFixture $ordinary (CommandFor $ordinary)
    Assert (-not (Repair-CiLegacyRegistration $base $installKey $uninstallKey $allowed '/currentuser')) 'Unknown layout must survive'
    SetFixture $orphan (CommandFor $orphan)
    $base.DeleteSubKey($uninstallKey)
    Assert (-not (Repair-CiLegacyRegistration $base $installKey $uninstallKey $allowed '/currentuser')) 'Partial registration must survive'
    SetFixture $orphan (CommandFor $orphan)
    $a=$base.OpenSubKey($installKey,$true);try{$a.SetValue('InstallLocation',$orphan,[Microsoft.Win32.RegistryValueKind]::ExpandString)}finally{$a.Dispose()}
    Assert (-not (Repair-CiLegacyRegistration $base $installKey $uninstallKey $allowed '/currentuser')) 'Expandable root must survive'
    Assert (-not (Test-CiOrphanPath $orphan 'C:\')) 'Volume root must be rejected'
    Assert (-not (Test-CiOrphanPath $orphan 'relative')) 'Relative root must be rejected'
    Assert (-not (Test-CiOrphanPath '\\server\share\app' $allowed)) 'UNC root must be rejected'
    $target=Join-Path $TaskRoot 'junction-target'
    New-Item -ItemType Directory -Path $target | Out-Null
    $link=Join-Path $allowed 'linked-job'
    New-Item -ItemType Junction -Path $link -Target $target | Out-Null
    try {
        $linked=Join-Path $link 'apps\desktop\release\preview-win32-x86_64\native-install\app'
        Assert (-not (Test-CiOrphanPath $linked $allowed)) 'Junction ancestor must be rejected'
    } finally { [IO.Directory]::Delete($link) }
    Write-Output 'PASS native registry remediation: eligible orphan removed; unsafe/partial/real installation cases preserved'
} finally {
    $base.DeleteSubKeyTree($namespace,$false)
    # Only this invocation's random namespace is deleted, never the production GUID.
}
