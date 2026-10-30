import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const powershellLiteral = value => `'${String(value).replaceAll("'", "''")}'`;
const quoteWindowsArgument = value => `"${String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;

// Use Windows' normal shell launch only when CreateProcess returns UNKNOWN.
// Arguments are data, never shell syntax; no elevation or policy changes.
export function installerBrokerScript(file, args, cancel, errorFile) {
  return `$ErrorActionPreference = 'Stop'
$installer = $null
try {
  $installer = Start-Process -FilePath ${powershellLiteral(file)} -ArgumentList ${powershellLiteral(args.map(quoteWindowsArgument).join(' '))} -WorkingDirectory ${powershellLiteral(path.dirname(file))} -WindowStyle Hidden -PassThru
  while (-not $installer.WaitForExit(100)) {
    if ([System.IO.File]::Exists(${powershellLiteral(cancel)})) {
      $installer.Kill()
      $installer.WaitForExit()
      exit 1
    }
  }
  exit $installer.ExitCode
} catch {
  [System.IO.File]::WriteAllText(${powershellLiteral(errorFile)}, $_.Exception.Message)
  exit 1
}`;
}

function launchFailure(error) {
  const code = error?.code || 'UNKNOWN';
  return Object.assign(new Error(`无法启动更新安装程序（${code}）。当前软件保持打开，已校验安装包已保留；可重试，或退出软件后使用完整安装包覆盖安装。`), {
    code: 'UPDATE_INSTALLER_LAUNCH_FAILED', cause: error,
  });
}

async function startChild(spawnImpl, file, args, options) {
  // spawn can throw synchronously on Windows, before an 'error' listener can
  // be attached. Both failure paths must leave the workbench usable.
  const child = spawnImpl(file, args, options);
  const state = { child, exited: false, error: null };
  child.once('exit', () => { state.exited = true; });
  await new Promise((resolve, reject) => {
    child.once('error', error => { state.error = error; reject(error); });
    child.once('spawn', resolve);
    if (child.pid) resolve();
  });
  return state;
}

export async function launchInstaller({ file, directory, target, pid = process.pid, spawnImpl = spawn, timeout = 60000,
  platform = process.platform, windowsDirectory = process.env.SystemRoot || process.env.WINDIR }) {
  const token = crypto.randomUUID();
  const ready = path.join(directory, `install-ready-${token}`);
  const result = path.join(directory, 'install-result.txt');
  const cancel = path.join(directory, `install-cancel-${token}`);
  const errorFile = path.join(directory, `install-launch-error-${token}.txt`);
  const args = ['/S', `/update-parent=${pid}`, `/update-ready=${ready}`, `/update-result=${result}`, '/restart', `/D=${target}`];
  let state, broker = false;
  try {
    try { state = await startChild(spawnImpl, file, args, { detached: true, stdio: 'ignore', windowsHide: true, cwd: directory }); }
    catch (error) {
      if (platform !== 'win32' || !(error?.code === 'UNKNOWN' || error?.message === 'spawn UNKNOWN') || !windowsDirectory) throw error;
      broker = true;
      const script = installerBrokerScript(file, args, cancel, errorFile);
      state = await startChild(spawnImpl, path.join(windowsDirectory, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        // Windows PowerShell exits immediately under DETACHED_PROCESS on some
        // systems. Ignored stdio plus unref permits it to outlive our process.
        { detached: false, stdio: 'ignore', windowsHide: true, cwd: directory });
    }
  } catch (error) { throw launchFailure(error); }
  const deadline = Date.now() + timeout;
  try {
    while (Date.now() < deadline) {
      if (state.error) throw launchFailure(state.error);
      if (fs.existsSync(ready) && fs.readFileSync(ready, 'utf8').replace(/^\ufeff/, '').trim() === 'ready') {
        fs.unlinkSync(ready); state.child.unref(); return { result, launcher: broker ? 'windows-shell' : 'direct' };
      }
      if (state.exited) {
        const reason = fs.existsSync(errorFile) ? fs.readFileSync(errorFile, 'utf8') : '';
        throw Object.assign(new Error('更新安装检查未通过，当前软件仍可使用；请重试或使用完整安装包覆盖安装'), {
          code: 'UPDATE_INSTALLER_PREFLIGHT_FAILED', ...(reason ? { cause: new Error(reason) } : {}),
        });
      }
      await wait(100);
    }
    if (broker) {
      fs.writeFileSync(cancel, 'cancel');
      // Stop the exact installer handle; killing only PowerShell could leave
      // a late installer waiting for a subsequent, unrelated application exit.
      const stopDeadline = Date.now() + 5000;
      while (!state.exited && Date.now() < stopDeadline) await wait(100);
    } else state.child.kill();
    throw Object.assign(new Error('启动更新安装程序超时，软件保持打开，请重试'), { code: 'UPDATE_INSTALLER_TIMEOUT' });
  } finally {
    if (state.exited) fs.rmSync(cancel, { force: true });
  }
}
