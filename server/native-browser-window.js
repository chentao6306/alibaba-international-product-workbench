import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const operations = new WeakMap();

// Only the PID reported by this Playwright browser is eligible. Never search
// by chrome.exe or alter another browser owned by the user.
export async function nativeBrowserWindows(context, action) {
  if (process.platform !== 'win32' || !['hide', 'show', 'inspect'].includes(action)) return null;
  const previous = operations.get(context) || Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    let session;
    try {
      session = await context.browser().newBrowserCDPSession();
      const { processInfo } = await session.send('SystemInfo.getProcessInfo');
      const browserPid = processInfo.find(item => item.type === 'browser')?.id;
      if (!Number.isSafeInteger(browserPid) || browserPid <= 0) return null;
      const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class OwnedBrowserWindows {
  public delegate bool EnumCallback(IntPtr handle, IntPtr parameter);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumCallback callback, IntPtr parameter);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr handle, out uint process);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr handle, StringBuilder value, int count);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr handle, int command);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr handle);
  public static string Apply(uint process, int command) {
    int count = 0, visible = 0;
    EnumWindows((handle, parameter) => {
      uint owner; GetWindowThreadProcessId(handle, out owner);
      if (owner != process) return true;
      var name = new StringBuilder(256); GetClassName(handle, name, name.Capacity);
      if (name.ToString() != "Chrome_WidgetWin_1") return true;
      count++;
      if (command >= 0) ShowWindow(handle, command);
      if (IsWindowVisible(handle)) visible++;
      return true;
    }, IntPtr.Zero);
    return count + "," + visible;
  }
}
'@
[OwnedBrowserWindows]::Apply(${browserPid}, ${action === 'hide' ? 0 : action === 'show' ? 4 : -1})
`;
      const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { windowsHide: true, timeout: 10000, maxBuffer: 65536 });
      const match = stdout.trim().match(/^(\d+),(\d+)$/);
      return match ? { count: Number(match[1]), visible: Number(match[2]) } : null;
    } catch { return null; }
    finally { await session?.detach().catch(() => {}); }
  });
  operations.set(context, operation);
  try { return await operation; }
  finally { if (operations.get(context) === operation) operations.delete(context); }
}
