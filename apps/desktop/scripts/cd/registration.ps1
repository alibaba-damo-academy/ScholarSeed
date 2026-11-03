param([Parameter(Mandatory=$true)][ValidatePattern('^[a-zA-Z0-9_.-]+$')][string]$AppId)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'registration.psm1') -Force
# Historical NSIS identity, shared with cmd/setup/legacy.go; never discover by display name.
$legacyId = 'b37a0805-d862-5fec-aab9-cb527040f854'
$uninstall = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\'
$entries = @(
    @{ kind = 'velopack'; key = $uninstall + $AppId },
    @{ kind = 'nsis-install'; key = 'Software\' + $legacyId },
    @{ kind = 'nsis-uninstall'; key = $uninstall + $legacyId }
)
$records = @()
foreach ($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryHive]::LocalMachine)) {
    foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
        $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
        try {
            $scope = if ($hive -eq [Microsoft.Win32.RegistryHive]::CurrentUser) { '/currentuser' } else { '/allusers' }
            $repaired = Repair-CiLegacyRegistration $base ('Software\' + $legacyId) ($uninstall + $legacyId) $env:SCHOLARSEED_CI_REGISTRATION_ROOT $scope
            if ($repaired) {
                [Console]::Error.WriteLine('[installer-preflight] ' + (ConvertTo-Json -Compress -InputObject @{status='reclaimed';hive=$hive.ToString();view=$view.ToString();kind='nsis'}))
            }
            foreach ($entry in $entries) {
                $key = $base.OpenSubKey($entry.key, $false)
                if ($null -ne $key) {
                    try { $records += @{ hive = $hive.ToString(); view = $view.ToString(); kind = $entry.kind } }
                    finally { $key.Dispose() }
                }
            }
        } finally { $base.Dispose() }
    }
}
ConvertTo-Json -InputObject @($records) -Compress
