Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class HandleScan {
  [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int cls, IntPtr buf, int len, out int ret);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr srcProc, IntPtr src, IntPtr dstProc, out IntPtr dst, uint access, bool inherit, uint options);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandle(IntPtr h, StringBuilder path, int len, uint flags);

  [StructLayout(LayoutKind.Sequential)]
  struct Entry {
    public IntPtr Object;
    public IntPtr UniqueProcessId;
    public IntPtr HandleValue;
    public uint GrantedAccess;
    public ushort CreatorBackTraceIndex;
    public ushort ObjectTypeIndex;
    public uint HandleAttributes;
    public uint Reserved;
  }

  public static List<string> Scan(string needle) {
    var found = new List<string>();
    int size = 1 << 22;
    IntPtr buf = IntPtr.Zero;
    int ret;
    while (true) {
      buf = Marshal.AllocHGlobal(size);
      ret = NtQuerySystemInformation(64, buf, size, out ret);
      if (ret == 0) break;
      Marshal.FreeHGlobal(buf);
      if ((uint)ret != 0xC0000004u) return found;
      size *= 2;
      if (size > 1 << 28) return found;
    }
    try {
      long count = Marshal.ReadInt64(buf);
      int entrySize = Marshal.SizeOf(typeof(Entry));
      IntPtr first = IntPtr.Add(buf, 16);
      var procs = new Dictionary<int, IntPtr>();
      IntPtr self = OpenProcess(0x0040, false, System.Diagnostics.Process.GetCurrentProcess().Id);
      for (long i = 0; i < count; i++) {
        var e = (Entry)Marshal.PtrToStructure(IntPtr.Add(first, (int)(i * entrySize)), typeof(Entry));
        int pid = e.UniqueProcessId.ToInt32();
        if (pid == 0 || pid == 4 || pid == System.Diagnostics.Process.GetCurrentProcess().Id) continue;
        IntPtr proc;
        if (!procs.TryGetValue(pid, out proc)) {
          proc = OpenProcess(0x0040, false, pid);
          procs[pid] = proc;
        }
        if (proc == IntPtr.Zero) continue;
        IntPtr dup;
        if (!DuplicateHandle(proc, e.HandleValue, self, out dup, 0, false, 2)) continue;
        try {
          var sb = new StringBuilder(2048);
          uint n = GetFinalPathNameByHandle(dup, sb, sb.Capacity, 0);
          if (n > 0) {
            string path = sb.ToString();
            if (path.IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0) {
              found.Add(pid + "|" + path);
            }
          }
        } catch {}
        CloseHandle(dup);
      }
      foreach (var p in procs.Values) if (p != IntPtr.Zero) CloseHandle(p);
      if (self != IntPtr.Zero) CloseHandle(self);
    } finally {
      Marshal.FreeHGlobal(buf);
    }
    return found;
  }
}
'@

$matches = [HandleScan]::Scan("Workspaces\9router")
$matches | Sort-Object -Unique | ForEach-Object {
  $parts = $_ -split '\|', 2
  $name = (Get-Process -Id ([int]$parts[0]) -ErrorAction SilentlyContinue).ProcessName
  Write-Output ("$($parts[0]) | $name | $($parts[1])")
}
