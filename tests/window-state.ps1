param(
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [string]$Action = "state"
)

Add-Type @'
using System;
using System.Runtime.InteropServices;
public class OrWindowState {
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
}
'@

$process = Get-Process -Id $ProcessId -ErrorAction Stop
$handle = $process.MainWindowHandle
if ($Action -eq "restore") {
  [OrWindowState]::ShowWindow($handle, 9) | Out-Null
  Start-Sleep -Milliseconds 400
}
$state = [ordered]@{
  pid = $ProcessId
  hwnd = $handle.ToInt64()
  title = $process.MainWindowTitle
  iconic = [OrWindowState]::IsIconic($handle)
  zoomed = [OrWindowState]::IsZoomed($handle)
}
$state | ConvertTo-Json -Compress
