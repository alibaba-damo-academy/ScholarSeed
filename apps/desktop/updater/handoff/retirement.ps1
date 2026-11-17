# Embedded, fixed code. The caller supplies inherited capabilities, never delete paths.
$ErrorActionPreference = 'Stop'
$assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('ScholarSeedRetirement'), [Reflection.Emit.AssemblyBuilderAccess]::Run)
$module = $assembly.DefineDynamicModule('Native')
$builder = $module.DefineType('RetirementNative', 'Public, Sealed, Abstract')
function Import-Native($name, $result, $parameters) {
    $method = $builder.DefinePInvokeMethod($name, 'kernel32.dll', 'Public, Static, PinvokeImpl', [Reflection.CallingConventions]::Standard, $result, $parameters, [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode)
    $method.SetImplementationFlags($method.GetMethodImplementationFlags() -bor [Reflection.MethodImplAttributes]::PreserveSig)
}
Import-Native 'WaitForSingleObject' ([uint32]) @([IntPtr], [uint32])
Import-Native 'GetExitCodeProcess' ([bool]) @([IntPtr], [uint32].MakeByRefType())
Import-Native 'GetFileInformationByHandleEx' ([bool]) @([IntPtr], [int], [IntPtr], [uint32])
Import-Native 'SetFileInformationByHandle' ([bool]) @([IntPtr], [int], [IntPtr], [uint32])
Import-Native 'GetFinalPathNameByHandleW' ([uint32]) @([IntPtr], [Text.StringBuilder], [uint32], [uint32])
Import-Native 'CloseHandle' ([bool]) @([IntPtr])
Import-Native 'GetLastError' ([uint32]) @()
Import-Native 'CreateFileW' ([IntPtr]) @([string], [uint32], [uint32], [IntPtr], [uint32], [uint32], [IntPtr])
$native = $builder.CreateType()

function File-Identity([IntPtr]$handle) {
    $info = [Runtime.InteropServices.Marshal]::AllocHGlobal(24)
    try {
        # FileIdInfo binds the volume serial and 128-bit file identity.
        if (!$native::GetFileInformationByHandleEx($handle, 18, $info, 24)) { throw 'retirement identity query failed' }
        $bytes = [byte[]]::new(24)
        [Runtime.InteropServices.Marshal]::Copy($info, $bytes, 0, 24)
        return [Convert]::ToBase64String($bytes)
    } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($info) }
}

function Reopen-Deletion([ref]$handle, [string]$path, [string]$stage) {
    $info = [Runtime.InteropServices.Marshal]::AllocHGlobal(24)
    try {
        if (!$native::GetFileInformationByHandleEx($handle.Value, 1, $info, 24)) { throw 'retirement state query failed' }
        if ([Runtime.InteropServices.Marshal]::ReadByte($info, 20) -ne 0) {
            [void]$native::CloseHandle($handle.Value)
            $handle.Value = [IntPtr]::Zero
            return
        }
    } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($info) }
    $identity = File-Identity $handle.Value
    [void]$native::CloseHandle($handle.Value)
    $handle.Value = [IntPtr]::Zero
    # The running image/CWD cannot grant DELETE. After exit, acquire it anew,
    # without following a reparse point, and refuse any intervening replacement.
    $opened = $native::CreateFileW($path, 0x10080, 3, [IntPtr]::Zero, 3, 0x02200000, [IntPtr]::Zero)
    if ($opened -eq [IntPtr]::new(-1)) { throw "retirement $stage deletion open refused: $($native::GetLastError())" }
    $handle.Value = $opened
    if ((File-Identity $opened) -cne $identity) { throw 'retirement object replaced' }
}

function Handle-Path([IntPtr]$handle) {
    $text = [Text.StringBuilder]::new(32768)
    $count = $native::GetFinalPathNameByHandleW($handle, $text, $text.Capacity, 0)
    if ($count -eq 0 -or $count -ge $text.Capacity) { throw 'retirement path query failed' }
    return $text.ToString()
}

function Remove-Pinned([IntPtr]$handle, [string]$expected, [bool]$directory) {
    if ($handle -eq [IntPtr]::Zero) { return }
    $info = [Runtime.InteropServices.Marshal]::AllocHGlobal(24)
    try {
        if (!$native::GetFileInformationByHandleEx($handle, 1, $info, 24)) { throw 'retirement state query failed' }
        # An earlier official deletion is already committed; closing our handle completes it.
        if ([Runtime.InteropServices.Marshal]::ReadByte($info, 20) -ne 0) { return }
        if (([Runtime.InteropServices.Marshal]::ReadByte($info, 21) -ne 0) -ne $directory) { throw 'retirement object type changed' }
        if (!$directory -and [Runtime.InteropServices.Marshal]::ReadInt32($info, 16) -ne 1) { throw 'retirement image linked' }
        if (!$native::GetFileInformationByHandleEx($handle, 9, $info, 8)) { throw 'retirement attribute query failed' }
        if (([Runtime.InteropServices.Marshal]::ReadInt32($info) -band 0x400) -ne 0) { throw 'retirement reparse object refused' }
        if (![string]::Equals((Handle-Path $handle), $expected, [StringComparison]::OrdinalIgnoreCase)) { throw 'retirement identity changed' }
        [Runtime.InteropServices.Marshal]::WriteByte($info, 0, 1)
        # FileDispositionInfo never recursively deletes directory members.
        if (!$native::SetFileInformationByHandle($handle, 4, $info, 1)) { throw 'retirement deletion refused' }
    } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($info) }
}

function Invoke-Retirement([IntPtr]$process, [IntPtr]$image, [IntPtr]$root, [uint32]$timeout) {
    try {
        $rootPath = Handle-Path $root
        $imagePath = Handle-Path $image
        if (![string]::Equals($imagePath, "$rootPath\Update.exe", [StringComparison]::OrdinalIgnoreCase)) { throw 'retirement image mismatch' }
        if ($native::WaitForSingleObject($process, 0) -ne 258) { throw 'retirement parent is not running' }
        [Console]::Out.WriteLine('ready')
        [Console]::Out.Flush()
        if ($native::WaitForSingleObject($process, $timeout) -ne 0) { throw 'retirement parent exit timeout' }
        [uint32]$code = 0
        if (!$native::GetExitCodeProcess($process, [ref]$code) -or $code -ne 0) { throw 'retirement parent failed' }
        Reopen-Deletion ([ref]$root) $rootPath 'root'
        Reopen-Deletion ([ref]$image) $imagePath 'image'
        Remove-Pinned $image $imagePath $false
        [void]$native::CloseHandle($image)
        $image = [IntPtr]::Zero
        Remove-Pinned $root $rootPath $true
        exit 0
    } catch {
        [Console]::Error.WriteLine($_.Exception.Message)
        exit 1
    } finally {
        foreach ($handle in @($process, $image, $root)) {
            if ($handle -ne [IntPtr]::Zero) { [void]$native::CloseHandle($handle) }
        }
    }
}
