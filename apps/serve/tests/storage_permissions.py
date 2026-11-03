"""Inspect real platform file permissions for configuration contracts."""

from __future__ import annotations

import os
import stat
import subprocess
from pathlib import Path


def private_file(path: Path) -> bool:
    if os.name != "nt":
        return stat.S_IMODE(path.stat().st_mode) == 0o600
    result = subprocess.run(
        [
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            """
$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = Get-Acl -LiteralPath $env:SCHOLARSEED_PERMISSION_TEST_PATH
if (!$acl.AreAccessRulesProtected -or $acl.GetOwner([System.Security.Principal.SecurityIdentifier]) -ne $sid) { exit 1 }
$ownerAllowed = $false
foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq 'Allow') {
        if ($rule.IdentityReference -ne $sid) { exit 1 }
        $ownerAllowed = $true
    }
}
if (!$ownerAllowed) { exit 1 }
""",
        ],
        env={**os.environ, "SCHOLARSEED_PERMISSION_TEST_PATH": str(path)},
        capture_output=True,
        check=False,
    )
    return result.returncode == 0
