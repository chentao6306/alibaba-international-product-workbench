param([Parameter(Mandatory = $true)][string]$LiteralPath)

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class RestartManagerNative {
  public const int CCH_RM_SESSION_KEY = 32;
  public const int CCH_RM_MAX_APP_NAME = 255;
  public const int CCH_RM_MAX_SVC_NAME = 63;
  public const int ERROR_MORE_DATA = 234;

  [StructLayout(LayoutKind.Sequential)]
  public struct RM_UNIQUE_PROCESS {
    public int dwProcessId;
    public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
  }

  public enum RM_APP_TYPE {
    RmUnknownApp = 0, RmMainWindow = 1, RmOtherWindow = 2,
    RmService = 3, RmExplorer = 4, RmConsole = 5,
    RmCritical = 1000
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = CCH_RM_MAX_APP_NAME + 1)]
    public string strAppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = CCH_RM_MAX_SVC_NAME + 1)]
    public string strServiceShortName;
    public RM_APP_TYPE ApplicationType;
    public uint AppStatus;
    public uint TSSessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
  }

  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  public static extern int RmStartSession(out uint handle, int flags, StringBuilder sessionKey);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  public static extern int RmRegisterResources(uint handle, uint fileCount, string[] fileNames,
    uint applicationCount, IntPtr applications, uint serviceCount, string[] serviceNames);
  [DllImport("rstrtmgr.dll")]
  public static extern int RmGetList(uint handle, out uint needed, ref uint count,
    [In, Out] RM_PROCESS_INFO[] affectedApps, ref uint rebootReasons);
  [DllImport("rstrtmgr.dll")]
  public static extern int RmEndSession(uint handle);
}
'@

$fullPath = (Resolve-Path -LiteralPath $LiteralPath).Path
$handle = 0
$key = [Text.StringBuilder]::new([RestartManagerNative]::CCH_RM_SESSION_KEY + 1)
$result = [RestartManagerNative]::RmStartSession([ref]$handle, 0, $key)
if ($result -ne 0) { throw "RmStartSession failed: $result" }
try {
  $result = [RestartManagerNative]::RmRegisterResources($handle, 1, @($fullPath), 0, [IntPtr]::Zero, 0, $null)
  if ($result -ne 0) { throw "RmRegisterResources failed: $result" }
  $needed = 0
  $count = 0
  $rebootReasons = 0
  $result = [RestartManagerNative]::RmGetList($handle, [ref]$needed, [ref]$count, $null, [ref]$rebootReasons)
  if ($result -eq [RestartManagerNative]::ERROR_MORE_DATA) {
    $processes = New-Object 'RestartManagerNative+RM_PROCESS_INFO[]' $needed
    $count = $needed
    $result = [RestartManagerNative]::RmGetList($handle, [ref]$needed, [ref]$count, $processes, [ref]$rebootReasons)
    if ($result -ne 0) { throw "RmGetList failed: $result" }
    $processes | Select-Object @{n='ProcessId';e={$_.Process.dwProcessId}}, strAppName, ApplicationType, bRestartable
  } elseif ($result -ne 0) {
    throw "RmGetList failed: $result"
  }
} finally {
  [void][RestartManagerNative]::RmEndSession($handle)
}
