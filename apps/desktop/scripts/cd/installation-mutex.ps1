# Kernel-owned machine lock; pipe EOF releases it if the parent exits or crashes.
param([int]$WaitMilliseconds = 0, [int]$ParentProcessId)
$ErrorActionPreference='Stop'
$MaximumWaitMilliseconds=30*60*1000
$PollMilliseconds=250
if ($WaitMilliseconds -lt 0 -or $WaitMilliseconds -gt $MaximumWaitMilliseconds -or $ParentProcessId -le 0) { throw 'Invalid verification lease arguments' }
$parent=[System.Diagnostics.Process]::GetProcessById($ParentProcessId)
# Retain the process handle while waiting; a recycled PID cannot become owner.
$null=$parent.Handle
if ($parent.StartTime -gt (Get-Process -Id $PID).StartTime) { throw 'Verification owner changed' }
$mutex=[System.Threading.Mutex]::new($false,'Global\ScholarSeedInstallationAcceptance')
$held=$false
$watch=[System.Diagnostics.Stopwatch]::StartNew()
try {
  do {
    if ($parent.HasExited) { exit 3 }
    $remaining=[Math]::Max(0,$WaitMilliseconds-[int]$watch.ElapsedMilliseconds)
    try { $held=$mutex.WaitOne([Math]::Min($PollMilliseconds,$remaining)) }
    catch [System.Threading.AbandonedMutexException] { $held=$true }
  } while (-not $held -and $watch.ElapsedMilliseconds -lt $WaitMilliseconds)
  if (-not $held) { exit 2 }
  [Console]::Out.WriteLine('ready')
  [Console]::Out.Flush()
  [Console]::In.ReadLine() | Out-Null
} finally {
  if ($held) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
  $parent.Dispose()
}
