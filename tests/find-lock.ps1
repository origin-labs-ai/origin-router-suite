$root = "C:\Users\thaku\Workspaces\9router"
$files = @()
$files += Get-ChildItem -LiteralPath $root -File -Force | Select-Object -First 100 -ExpandProperty FullName
$files += Get-ChildItem -LiteralPath (Join-Path $root ".git") -File -Force -ErrorAction SilentlyContinue | Select-Object -First 30 -ExpandProperty FullName
if (Test-Path (Join-Path $root "package.json")) { $files += (Join-Path $root "package.json") }

Add-Type @'
using System;
using System.Runtime.InteropServices;
public class RM2 {
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] public static extern int RmStartSession(out uint handle, int flags, string key);
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] public static extern int RmRegisterResources(uint handle, uint nFiles, string[] files, uint nApps, string[] apps, uint nServices, string[] services);
  [DllImport("rstrtmgr.dll")] public static extern int RmGetList(uint handle, out uint needed, ref uint count, IntPtr info, ref uint reboot);
  [DllImport("rstrtmgr.dll")] public static extern int RmEndSession(uint handle);
  public struct RM_UNIQUE_PROCESS { public int dwProcessId; public long ProcessStartTime; }
  public struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string strAppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)] public string strServiceShortName;
    public int ApplicationType;
    public uint AppStatus;
    public uint TSSessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
  }
}
'@

$key = [guid]::NewGuid().ToString()
$h = [uint32]0
$r = [RM2]::RmStartSession([ref]$h, 0, $key)
Write-Output "start=$r handle=$h files=$($files.Count)"
$r = [RM2]::RmRegisterResources($h, [uint32]$files.Count, [string[]]$files, 0, $null, 0, $null)
Write-Output "register=$r"
$needed = [uint32]0
$count = [uint32]0
$reboot = [uint32]0
$r = [RM2]::RmGetList($h, [ref]$needed, [ref]$count, [IntPtr]::Zero, [ref]$reboot)
Write-Output "first=$r needed=$needed"
if ($needed -gt 0) {
  $size = [Runtime.InteropServices.Marshal]::SizeOf([type][RM2+RM_PROCESS_INFO]) * $needed
  $ptr = [Runtime.InteropServices.Marshal]::AllocHGlobal($size)
  $count = $needed
  $r = [RM2]::RmGetList($h, [ref]$needed, [ref]$count, $ptr, [ref]$reboot)
  Write-Output "second=$r count=$count"
  for ($i = 0; $i -lt $count; $i++) {
    $pi = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][RM2+RM_PROCESS_INFO], $i * [Runtime.InteropServices.Marshal]::SizeOf([type][RM2+RM_PROCESS_INFO]))
    Write-Output ("LOCK " + $pi.Process.dwProcessId + " | " + $pi.strAppName)
  }
  [Runtime.InteropServices.Marshal]::FreeHGlobal($ptr)
}
[RM2]::RmEndSession($h) | Out-Null
