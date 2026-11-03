const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { LEASE_STATE, LEASE_GRANT, recordDenial } = require("./security.cjs");

const SYSTEM_ROOT_ENV = "SystemRoot";
const SYSTEM_DIRECTORY = "System32";
const ACL_SCRIPT = `
$ErrorActionPreference = 'Stop'
$identity = & (Join-Path $systemRoot 'System32\\whoami.exe') /user /fo csv /nh
if ($LASTEXITCODE -ne 0) { throw 'cannot identify private state owner' }
$accounts = @($identity | ConvertFrom-Csv -Header Name,Sid)
if ($accounts.Count -ne 1) { throw 'ambiguous private state owner identity' }
$user = $accounts[0].Sid
if ($user -notmatch '^S-1-[0-9]+(?:-[0-9]+)+$') { throw 'invalid private state owner identity' }
$allowed = @(${LEASE_STATE.map((sid) => (sid === "$user" ? "$user" : `'${sid}'`)).join(",")})
$writeMask = 0x116
$replaceMask = 0xD0040
$genericWriteMask = 0x40000000
$genericAllMask = 0x10000000
$inheritOnly = 8
$daclPresent = 4
$accessAllowed = 0
$accessDenied = 1
$mask = $writeMask -bor $replaceMask -bor $genericWriteMask -bor $genericAllMask
$current = PATH_LITERAL
while ($current) {
  $item = Get-Item -LiteralPath $current -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "redirected private state: $current" }
  $acl = Get-Acl -LiteralPath $current
  $descriptor = (ConvertFrom-SddlString -Sddl $acl.Sddl -Type FileSystemRights).RawDescriptor
  if ($descriptor.Owner.Value -notin $allowed) { throw "foreign private state owner: $current" }
  if (([int]$descriptor.ControlFlags -band $daclPresent) -eq 0 -or $null -eq $descriptor.DiscretionaryAcl) { throw "missing private state DACL: $current" }
  foreach ($rule in $descriptor.DiscretionaryAcl) {
    if ([int]$rule.AceType -notin @($accessAllowed,$accessDenied)) { throw "unsupported private state ACE: $current" }
    if ([int]$rule.AceType -eq $accessAllowed -and (([int]$rule.AceFlags -band $inheritOnly) -eq 0) -and
        (($rule.AccessMask -band $mask) -ne 0) -and $rule.SecurityIdentifier.Value -notin $allowed) { throw "writable or replaceable private state ACL: $current" }
  }
  $parent = Split-Path -Path $current -Parent
  if (!$parent -or $parent -eq $current) { break }
  $current = $parent
  $mask = $replaceMask -bor $genericAllMask
}`;

function systemCommand(name) {
  const systemRoot = process.env[SYSTEM_ROOT_ENV];
  if (
    !systemRoot ||
    !path.win32.isAbsolute(systemRoot) ||
    !/^[a-z]:\\/i.test(systemRoot) ||
    path.win32.normalize(systemRoot).toLowerCase() !== systemRoot.toLowerCase()
  ) {
    throw new Error(
      "private state requires a canonical OS-provided SystemRoot as a trusted platform input; PATH fallback is forbidden",
    );
  }
  const filename = path.join(systemRoot, SYSTEM_DIRECTORY, name);
  let current = filename;
  for (;;) {
    const stat = fs.lstatSync(current);
    if (
      stat.isSymbolicLink() ||
      (current === filename ? !stat.isFile() : !stat.isDirectory())
    ) {
      throw new Error(
        "OS-provided SystemRoot and fixed system tools must not be redirected",
      );
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (fs.realpathSync(filename).toLowerCase() !== filename.toLowerCase()) {
    throw new Error(
      "cannot establish fixed system tool identity from OS-provided SystemRoot",
    );
  }
  return filename;
}

function assertWindowsPermissions(filename) {
  try {
    const executable = systemCommand(
      path.join("WindowsPowerShell", "v1.0", "powershell.exe"),
    );
    const systemRoot = process.env[SYSTEM_ROOT_ENV];
    systemCommand("whoami.exe");
    const script = `$systemRoot = '${systemRoot.replaceAll("'", "''")}'\n${ACL_SCRIPT.replace("PATH_LITERAL", `'${filename.replaceAll("'", "''")}'`)}`;
    execFileSync(
      executable,
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        env: { ...process.env, SystemRoot: systemRoot },
        stdio: "pipe",
        windowsHide: true,
      },
    );
  } catch (error) {
    recordDenial(error, "lease_state", "inspect", filename);
    throw error;
  }
}

function protectWindowsDirectory(directory) {
  try {
    const user = execFileSync(systemCommand("whoami.exe"), [], {
      encoding: "utf8",
      windowsHide: true,
    }).trim();
    if (!user || /[\r\n\0]/.test(user))
      throw new Error("cannot identify private directory owner");
    execFileSync(
      systemCommand("icacls.exe"),
      [
        directory,
        "/inheritance:r",
        "/grant:r",
        ...LEASE_GRANT.map(
          (sid) => `${sid === "$user" ? user : "*" + sid}:(OI)(CI)(F)`,
        ),
      ],
      { encoding: "utf8", windowsHide: true, stdio: "pipe" },
    );
    assertWindowsPermissions(directory);
  } catch (error) {
    recordDenial(error, "lease_grant", "grant", directory);
    try {
      fs.rmdirSync(directory);
    } catch {}
    throw error;
  }
}

module.exports = { assertWindowsPermissions, protectWindowsDirectory };
