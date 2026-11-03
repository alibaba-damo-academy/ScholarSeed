Set-StrictMode -Version Latest

function Test-CiOrphanPath([string]$InstallRoot, [string]$AllowedRoot) {
    if ([string]::IsNullOrWhiteSpace($AllowedRoot)) { return $false }
    if ($AllowedRoot -notmatch '^[A-Za-z]:[\\/]' -or $InstallRoot -notmatch '^[A-Za-z]:[\\/]') { return $false }
    $allowed = [IO.Path]::GetFullPath($AllowedRoot).TrimEnd('\')
    $install = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
    if ($allowed.Length -le 3 -or -not $install.StartsWith($allowed+'\', [StringComparison]::OrdinalIgnoreCase)) { return $false }
    # Only the historical build acceptance layout is eligible, never a generic app folder.
    if ($install -notmatch '\\apps\\desktop\\release\\(?:dev|preview|release)-win32-x86_64\\native-install\\app$') { return $false }
    $attributes = [IO.File]::GetAttributes($allowed)
    if (($attributes -band [IO.FileAttributes]::Directory) -eq 0) { return $false }
    # Inspect all existing ancestors: missing/offline drives, denied paths and reparse
    # points must not be interpreted as an orphaned installation.
    $cursor = $install
    $missing = $false
    while ($cursor) {
        try {
            $attributes = [IO.File]::GetAttributes($cursor)
            if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
            if (($attributes -band [IO.FileAttributes]::Directory) -eq 0) { return $false }
            if ($cursor -eq $install) { return $false }
        } catch {
            $cause = $_.Exception.InnerException
            if ($cause -isnot [IO.FileNotFoundException] -and $cause -isnot [IO.DirectoryNotFoundException]) { throw }
            if ($cursor -eq $install) { $missing = $true }
        }
        $parent = [IO.Directory]::GetParent($cursor)
        if ($null -eq $parent) { break }
        $cursor = $parent.FullName
    }
    return $missing
}

function Get-RegistrationSnapshot([Microsoft.Win32.RegistryKey]$Key) {
    if ($Key.SubKeyCount -ne 0) { throw 'CI registry remediation refuses nested keys' }
    $values = @($Key.GetValueNames() | Sort-Object | ForEach-Object {
        [ordered]@{ name=$_; kind=$Key.GetValueKind($_).ToString(); value=$Key.GetValue($_,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
    })
    return ConvertTo-Json -InputObject $values -Depth 8 -Compress
}

function Repair-CiLegacyRegistration(
    [Microsoft.Win32.RegistryKey]$Base,
    [string]$InstallKey,
    [string]$UninstallKey,
    [string]$AllowedRoot,
    [string]$Scope
) {
    if ([string]::IsNullOrWhiteSpace($AllowedRoot)) { return $false }
    if ($Scope -notin @('/currentuser', '/allusers')) { throw 'Invalid legacy scope' }
    $install = $null
    $uninstall = $null
    try {
        $install = $Base.OpenSubKey($InstallKey, $false)
        $uninstall = $Base.OpenSubKey($UninstallKey, $false)
        if ($null -eq $install -or $null -eq $uninstall) { return $false }
        if ($install.SubKeyCount -ne 0 -or $uninstall.SubKeyCount -ne 0) { return $false }
        if ($install.GetValueKind('InstallLocation') -ne [Microsoft.Win32.RegistryValueKind]::String -or
            $uninstall.GetValueKind('UninstallString') -ne [Microsoft.Win32.RegistryValueKind]::String) { return $false }
        $root = $install.GetValue('InstallLocation')
        $command = $uninstall.GetValue('UninstallString')
        if (-not (Test-CiOrphanPath $root $AllowedRoot)) { return $false }
        $expected = '"' + [IO.Path]::Combine($root,'Uninstall ScholarSeed.exe') + '" ' + $Scope
        if ($command -cne $expected) { return $false }
        $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
            $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)
        })
        if ($processes.Count) { return $false }
        $beforeInstall = Get-RegistrationSnapshot $install
        $beforeUninstall = Get-RegistrationSnapshot $uninstall
    } finally {
        if ($install) { $install.Dispose() }
        if ($uninstall) { $uninstall.Dispose() }
    }
    # Reopen and compare the complete entries immediately before bounded deletion.
    $install = $null
    $uninstall = $null
    try {
        $install = $Base.OpenSubKey($InstallKey, $false)
        $uninstall = $Base.OpenSubKey($UninstallKey, $false)
        if ($null -eq $install -or $null -eq $uninstall -or
            (Get-RegistrationSnapshot $install) -cne $beforeInstall -or
            (Get-RegistrationSnapshot $uninstall) -cne $beforeUninstall -or
            -not (Test-CiOrphanPath $root $AllowedRoot)) { throw 'CI legacy registration changed before remediation' }
    } finally {
        if ($install) { $install.Dispose() }
        if ($uninstall) { $uninstall.Dispose() }
    }
    # Never recurse and never remove files. A partial deletion remains blocking.
    $Base.DeleteSubKey($UninstallKey, $true)
    $Base.DeleteSubKey($InstallKey, $true)
    foreach ($name in @($InstallKey, $UninstallKey)) {
        $remaining = $Base.OpenSubKey($name, $false)
        if ($remaining) { $remaining.Dispose(); throw 'CI registry remediation readback failed' }
    }
    return $true
}

Export-ModuleMember -Function Test-CiOrphanPath, Repair-CiLegacyRegistration
