import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { signUpdate } from './sign-update.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const release = path.resolve(process.env.CHAODEKUAI_RELEASE_DIR || path.join(root, 'release-installer'));
const inner = path.join(release, `chaodekuai-${pkg.version}-inner.exe`);
const output = path.join(release, `chaodekuai-${pkg.version}-setup.exe`);
const generated = path.join(root, '.packaged', 'installer');
fs.mkdirSync(generated, { recursive: true });
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const payloadRoot = path.join(release, 'win-unpacked');
const files = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (entry.isFile()) files.push({ path: path.relative(payloadRoot, file), size: fs.statSync(file).size, sha256: hash(file) });
    else throw new Error(`不支持的安装文件：${file}`);
  }
}
walk(payloadRoot);
if (!files.some((file) => file.path === '抄得快.exe')) throw new Error('安装目录缺少抄得快.exe');
const manifest = path.join(generated, 'payload.manifest');
fs.writeFileSync(manifest, files.map((file) => `${file.sha256}\t${file.size}\t${file.path}`).join('\n') + '\n');
const metadata = path.join(generated, 'SetupMetadata.cs');
fs.writeFileSync(metadata, `using System.Reflection;
[assembly: AssemblyTitle("抄得快 安装")]
[assembly: AssemblyProduct("抄得快")]
[assembly: AssemblyVersion("${pkg.version}.0")]
[assembly: AssemblyFileVersion("${pkg.version}.0")]
internal static class SetupMetadata {
  public const string Version="${pkg.version}";
  public const long PayloadBytes=${files.reduce((n, file) => n + file.size, 0)}L;
  public const long InstallerBytes=${fs.statSync(inner).size}L;
  public const string InstallerSha256="${hash(inner)}";
}\n`);
const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const result = spawnSync(compiler, ['/nologo', '/codepage:65001', '/target:winexe', '/platform:anycpu', '/optimize+', '/reference:System.Windows.Forms.dll',
  `/win32icon:${path.join(root, 'assets', 'brand.ico')}`, `/out:${output}`, `/resource:${inner},installer.exe`, `/resource:${manifest},payload.manifest`,
  path.join(root, 'build', 'SetupBootstrap.cs'), metadata], { encoding: 'utf8', windowsHide: true });
if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stdout + result.stderr);
const artifact = signUpdate(output, pkg.version);
console.log(JSON.stringify({ installer: output, ...artifact }, null, 2));
