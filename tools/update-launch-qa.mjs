// Real Windows process launch with a tiny stand-in, never the installed app.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { launchInstaller } from '../electron/update-install.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), "更新 启动 & O'Brien $() %-"));
const source = path.join(root, 'Fixture.cs'), executable = path.join(root, 'fixture.exe');
fs.writeFileSync(source, `using System; using System.IO; using System.Text; using System.Diagnostics; using System.Threading;
class Fixture {
 static int Main(string[] args) {
  string root=Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
  try {
  File.WriteAllLines(Path.Combine(root,"arguments.txt"), args, Encoding.UTF8);
  File.WriteAllText(Path.Combine(root,"pid.txt"), Process.GetCurrentProcess().Id.ToString());
  if (!File.Exists(Path.Combine(root,"hang"))) {
   foreach(string arg in args) if(arg.StartsWith("/update-ready=")) File.WriteAllText(arg.Substring(14),"ready",Encoding.UTF8);
  }
  while (!File.Exists(Path.Combine(root,"finish"))) Thread.Sleep(50);
  return 0;
  } catch(Exception error) { File.WriteAllText(Path.Combine(root,"fixture-error.txt"),error.ToString()); return 1; }
 }
}`);
const compiler = path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const compiled = spawnSync(compiler, ['/nologo', '/target:winexe', `/out:${executable}`, source], { windowsHide: true, encoding: 'utf8' });
assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
const target = path.join(root, '中文 Program & Test $() %', 'trailing') + '\\';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let broker;
const fallback = (...args) => {
  if (args[0] === executable) throw Object.assign(new Error('spawn UNKNOWN'), { code: 'UNKNOWN' });
  broker = spawn(...args);
  return broker;
};
try {
  for (const mode of ['direct', 'fallback']) {
    console.log('Testing ' + mode);
    const result = await launchInstaller({ file: executable, directory: root, target, ...(mode === 'fallback' ? { spawnImpl: fallback } : {}) });
    assert.equal(result.launcher, mode === 'direct' ? 'direct' : 'windows-shell');
    const args = fs.readFileSync(path.join(root, 'arguments.txt'), 'utf8').replace(/^\uFEFF/, '').trimEnd().split(/\r?\n/);
    assert.equal(args.at(-1), '/D=' + target);
    assert.equal(args[1], '/update-parent=' + process.pid);
    const pid = Number(fs.readFileSync(path.join(root, 'pid.txt'), 'utf8'));
    fs.writeFileSync(path.join(root, 'finish'), 'finish');
    for (let index = 0; index < 100; index++) { try { process.kill(pid, 0); await wait(50); } catch { break; } }
    await wait(300);
    fs.rmSync(path.join(root, 'finish'));
  }
  // A ready broker must survive the updater process exiting, otherwise the
  // application could close without leaving a working installer behind.
  const driver = path.join(root, 'driver.mjs');
  fs.writeFileSync(driver, `import { spawn } from 'node:child_process';
import { launchInstaller } from ${JSON.stringify(new URL('../electron/update-install.js', import.meta.url).href)};
await launchInstaller({ file: process.argv[2], directory: process.argv[3], target: process.argv[4], spawnImpl: (...args) => {
  if (args[0] === process.argv[2]) throw Object.assign(new Error('spawn UNKNOWN'), { code: 'UNKNOWN' });
  return spawn(...args);
} });
`);
  const driverResult = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [driver, executable, root, target], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = ''; child.stderr.on('data', value => { errors += value; });
    child.once('error', reject); child.once('exit', code => resolve({ code, errors }));
  });
  assert.equal(driverResult.code, 0, driverResult.errors);
  const independentPid = Number(fs.readFileSync(path.join(root, 'pid.txt'), 'utf8'));
  assert.doesNotThrow(() => process.kill(independentPid, 0));
  fs.writeFileSync(path.join(root, 'finish'), 'finish');
  for (let index = 0; index < 100; index++) { try { process.kill(independentPid, 0); await wait(50); } catch { break; } }
  await wait(300); fs.rmSync(path.join(root, 'finish'));
  fs.writeFileSync(path.join(root, 'hang'), 'hang');
  await assert.rejects(launchInstaller({ file: executable, directory: root, target, timeout: 3000, spawnImpl: fallback }), { code: 'UPDATE_INSTALLER_TIMEOUT' });
  const pid = Number(fs.readFileSync(path.join(root, 'pid.txt'), 'utf8'));
  assert.throws(() => process.kill(pid, 0), 'Timed-out installer must not remain waiting for app exit');
  assert.ok(broker.exitCode !== null);
  console.log(JSON.stringify({ ok: true, direct: true, fallback: true, unicodeAndSpecialArguments: true, survivesParentExit: true, timeoutStopsInstaller: true }));
} catch (error) {
  for (const name of fs.readdirSync(root).filter(name => /error|arguments/.test(name))) console.error(name + ': ' + fs.readFileSync(path.join(root, name), 'utf8'));
  throw error;
} finally {
  fs.writeFileSync(path.join(root, 'finish'), 'finish');
  await wait(200);
  if (process.env.QA_KEEP_OUTPUT) console.log(root);
  else fs.rmSync(root, { recursive: true, force: true });
}
