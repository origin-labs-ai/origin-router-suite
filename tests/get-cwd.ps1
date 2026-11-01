Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public class CwdReader {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buffer, IntPtr size, out IntPtr read);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, ref PBI pbi, int size, out int len);

  [StructLayout(LayoutKind.Sequential)]
  struct PBI {
    public IntPtr ExitStatus;
    public IntPtr PebBaseAddress;
    public IntPtr AffinityMask;
    public IntPtr BasePriority;
    public IntPtr UniqueProcessId;
    public IntPtr InheritedFromUniqueProcessId;
  }

  static IntPtr ReadPtr(IntPtr h, IntPtr addr) {
    byte[] buf = new byte[8];
    IntPtr read;
    if (!ReadProcessMemory(h, addr, buf, (IntPtr)8, out read)) return IntPtr.Zero;
    return (IntPtr)BitConverter.ToInt64(buf, 0);
  }

  public static string Get(int pid) {
    IntPtr h = OpenProcess(0x0400 | 0x0010, false, pid);
    if (h == IntPtr.Zero) return null;
    try {
      PBI pbi = new PBI();
      int len;
      if (NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(pbi), out len) != 0) return null;
      IntPtr pp = ReadPtr(h, (IntPtr)((long)pbi.PebBaseAddress + 0x20));
      if (pp == IntPtr.Zero) return null;
      byte[] lenBuf = new byte[2];
      IntPtr read;
      if (!ReadProcessMemory(h, (IntPtr)((long)pp + 0x38), lenBuf, (IntPtr)2, out read)) return null;
      int strLen = BitConverter.ToUInt16(lenBuf, 0);
      if (strLen <= 0 || strLen > 4096) return null;
      IntPtr bufPtr = ReadPtr(h, (IntPtr)((long)pp + 0x40));
      if (bufPtr == IntPtr.Zero) return null;
      byte[] strBuf = new byte[strLen];
      if (!ReadProcessMemory(h, bufPtr, strBuf, (IntPtr)strLen, out read)) return null;
      return Encoding.Unicode.GetString(strBuf);
    } finally {
      CloseHandle(h);
    }
  }
}
'@

$pids = @(20240, 22940, 22840, 23812, 21192, 21648, 14036, 7412, 13848, 8980, 9056, 19860, 22348, 21544, 21928)
foreach ($procId in $pids) {
  $cwd = [CwdReader]::Get($procId)
  if ($cwd) {
    $name = (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName
    Write-Output ("$procId | $name | $cwd")
  }
}
