param([int]$ProcessId = 0, [string]$Executable = '')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Drawing
if ($Executable) {
  $appIcon = [System.Drawing.Icon]::ExtractAssociatedIcon((Resolve-Path -LiteralPath $Executable).Path)
  $bitmap = $appIcon.ToBitmap()
  $stream = New-Object System.IO.MemoryStream
  try {
    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    [Convert]::ToBase64String($stream.ToArray())
  } finally { $stream.Dispose(); $bitmap.Dispose(); $appIcon.Dispose() }
  exit
}
if ($ProcessId -le 0) { throw 'Provide the owned process ID or executable path.' }
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Text;
using System.IO;
using System.Drawing;
using System.Drawing.Imaging;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class WindowIconProbe {
  public class Result {
    public string handle, title, small, big;
    public bool visible;
  }
  delegate bool EnumCallback(IntPtr handle, IntPtr parameter);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumCallback callback, IntPtr parameter);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr handle, out uint process);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr handle, StringBuilder value, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr handle, StringBuilder value, int count);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
  static string Image(IntPtr handle, int kind) {
    IntPtr result;
    SendMessageTimeout(handle, 0x007f, new IntPtr(kind), IntPtr.Zero, 2, 1000, out result);
    if (result == IntPtr.Zero) return "";
    // Clone the window-owned icon; never destroy another process's HICON.
    using (var icon = (Icon)Icon.FromHandle(result).Clone())
    using (var bitmap = icon.ToBitmap())
    using (var stream = new MemoryStream()) {
      bitmap.Save(stream, ImageFormat.Png);
      return Convert.ToBase64String(stream.ToArray());
    }
  }
  public static Result[] Read(uint process) {
    var results = new List<Result>();
    EnumWindows((handle, parameter) => {
      uint owner; GetWindowThreadProcessId(handle, out owner);
      if (owner != process) return true;
      var name = new StringBuilder(256); GetClassName(handle, name, name.Capacity);
      if (name.ToString() != "Chrome_WidgetWin_1") return true;
      var title = new StringBuilder(1024); GetWindowText(handle, title, title.Capacity);
      results.Add(new Result { handle = handle.ToInt64().ToString(), title = title.ToString(),
        small = Image(handle, 0), big = Image(handle, 1), visible = IsWindowVisible(handle) });
      return true;
    }, IntPtr.Zero);
    return results.ToArray();
  }
}
'@
ConvertTo-Json -InputObject @([WindowIconProbe]::Read($ProcessId)) -Compress
