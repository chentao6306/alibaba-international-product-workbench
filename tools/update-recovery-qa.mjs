// Exercises the same Windows bootstrap recovery code with tiny fixture files.
// Never installs/uninstalls the user's application or changes its registry keys.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chaodekuai-recovery-qa-'));
const compiler = path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
function compile(args) {
  const result = spawnSync(compiler, ['/nologo', '/codepage:65001', ...args], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stdout + result.stderr);
}
try {
  const fixture = path.join(directory, 'Metadata.cs');
  fs.writeFileSync(fixture, 'internal static class SetupMetadata { public const string Version="1.4.53"; public const long PayloadBytes=10; public const long InstallerBytes=10; public const string InstallerSha256="fixture"; }');
  const bootstrap = path.join(directory, 'bootstrap.exe');
  // Keep any customer app running. Scope the compiled fixture's process guard
  // to its own impossible name; the restore/journal code remains unchanged.
  const source = fs.readFileSync('build/SetupBootstrap.cs', 'utf8');
  if (!source.includes('Process.GetProcessesByName("抄得快")')) throw new Error('Installer process guard changed; review the isolated fixture');
  const fixtureSource = path.join(directory, 'SetupBootstrap.cs');
  fs.writeFileSync(fixtureSource, source.replaceAll('Process.GetProcessesByName("抄得快")', 'Process.GetProcessesByName("chaodekuai-isolated-recovery-fixture")'));
  compile(['/target:winexe', '/reference:System.Windows.Forms.dll', `/out:${bootstrap}`, fixtureSource, fixture]);
  const harness = path.join(directory, 'Harness.cs');
  fs.writeFileSync(harness, `using System; using System.IO; using System.Reflection;
class Harness {
  static int Main(string[] args) {
    var type=Assembly.LoadFrom(args[0]).GetType("SetupBootstrap");
    var flags=BindingFlags.Static|BindingFlags.NonPublic;
    string root=args[1], recovery=Path.Combine(root,"recovery"), target=Path.Combine(root,"program"), data=Path.Combine(root,"userData");
    Directory.CreateDirectory(Path.Combine(target,"resources"));Directory.CreateDirectory(data);
    File.WriteAllText(Path.Combine(target,"抄得快.exe"),"old-executable");
    File.WriteAllText(Path.Combine(target,"resources","app.asar"),"old-code");
    File.WriteAllText(Path.Combine(target,"old.dll"),"old-library");
    File.WriteAllText(Path.Combine(data,"workspace.json"),"products-templates-jobs-sentinel");
    type.GetField("recoveryRoot",flags).SetValue(null,recovery);
    type.GetField("logPath",flags).SetValue(null,Path.Combine(root,"qa.log"));
    type.GetMethod("BackupProgram",flags).Invoke(null,new object[]{target});
    if(!File.Exists(Path.Combine(recovery,"pending.txt")))throw new Exception("Missing durable journal");
    File.WriteAllText(Path.Combine(target,"抄得快.exe"),"partial-new-executable");
    File.Delete(Path.Combine(target,"resources","app.asar"));File.Delete(Path.Combine(target,"old.dll"));
    // Simulate a fresh installer process after an interrupted replacement.
    type.GetField("recoveryTarget",flags).SetValue(null,null);
    type.GetMethod("RecoverInterruptedUpdate",flags).Invoke(null,null);
    if(File.ReadAllText(Path.Combine(target,"抄得快.exe"))!="old-executable" || File.ReadAllText(Path.Combine(target,"resources","app.asar"))!="old-code" || File.ReadAllText(Path.Combine(target,"old.dll"))!="old-library")throw new Exception("Recovery lost files");
    if(File.Exists(Path.Combine(recovery,"pending.txt")))throw new Exception("Recovery journal not completed");
    type.GetMethod("BackupProgram",flags).Invoke(null,new object[]{target});
    type.GetMethod("CompleteRecovery",flags).Invoke(null,null);
    if(Directory.Exists(Path.Combine(recovery,"program")))throw new Exception("Verified recovery copy not cleaned");
    if(File.ReadAllText(Path.Combine(data,"workspace.json"))!="products-templates-jobs-sentinel")throw new Exception("Business data changed");
    Console.WriteLine("Windows recovery passed: interrupted program restored, journal completed, business data unchanged.");return 0;
  }
}`);
  const exe = path.join(directory, 'qa.exe'); compile(['/target:exe', `/out:${exe}`, harness]);
  const result = spawnSync(exe, [bootstrap, directory], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stdout + result.stderr);
  console.log(result.stdout.trim());
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
