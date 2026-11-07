// Read-only audit. Output contains file names and finding categories, never
// matched credentials, file contents, customer records or browser session data.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { listPackage, statFile, extractFile } from '@electron/asar';

const repository = fileURLToPath(new URL('../', import.meta.url));
const application = path.resolve(process.argv[2] || 'release-installer/win-unpacked');
const output = process.env.QA_OUTPUT_DIR && path.resolve(process.env.QA_OUTPUT_DIR);
if (!output) throw new Error('Set QA_OUTPUT_DIR to a new private directory outside the repository and application');
const inside = (root, file) => { const relative = path.relative(root, file); return relative === '' || !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative); };
if (inside(repository, output) || inside(application, output)) throw new Error('Privacy reports must be stored outside the repository and application');
if (fs.existsSync(output)) throw new Error('QA_OUTPUT_DIR must be new');
const archive = path.join(application, 'resources', 'app.asar');
if (!fs.existsSync(archive)) throw new Error('Candidate app.asar does not exist yet');
fs.mkdirSync(output, { recursive: true });

const findings = [];
const firstPartyAssets = [];
const ignored = { binaryFiles: 0, emptyFiles: 0, oversizedTextFiles: 0, protectedBusinessModules: 0, sourceMaterialExcluded: 0 };
const normalize = name => name.replaceAll('\\', '/').replace(/^\/+/, '');
const codeExtension = /\.(?:[cm]?js|jsx|tsx?|cs|sh|ps1|html|css)$/i;
const textExtension = /\.(?:[cm]?js|jsx|tsx?|cs|sh|ps1|html|css|json|ya?ml|txt|md|xml|ini|conf)$/i;
const sourceDirectories = ['server', 'electron', 'auth-server', 'src', 'tools', 'build', 'website/src'];
const sourceExtensions = /\.(?:[cm]?js|jsx|tsx?|cs|sh|ps1|html)$/i;
const add = (surface, file, category, extra = {}) => findings.push({ surface, path: normalize(file), category, ...extra });

function pathRisks(name, directory = false) {
  const relative = normalize(name);
  const base = relative.split('/').at(-1);
  const segments = relative.split('/');
  const risks = [];
  if (/^\.env(?:\..*)?$/i.test(base)) risks.push('environment-file');
  if (segments.some(part => /^(?:\.data.*|user-data|browser-profile.*|browserprofile|user data|playwright-report|test-results|qa-output|screenshots|backups)$/i.test(part))) risks.push('runtime-data-directory');
  if (/^(?:workspace(?:\..+)?\.json|products?[-_.](?:data|snapshot|export).*|products\.json|customers?\.json|users\.json|licenses\.json|auth-settings\.json|secure-settings\.json)$/i.test(base)) risks.push('business-or-account-data');
  if (/^(?:cookies|login data|local state|web data|history|preferences|secure preferences|sessions?)$/i.test(base) && !directory) risks.push('browser-session-data');
  if (/^(?:.*cookies.*\.json|.*credentials.*\.json|.*session-state.*\.json|.*storage-state.*\.json)$/i.test(base)) risks.push('credential-or-session-file');
  if (/\.(?:db|sqlite3?|sqlite-(?:wal|shm)|db-(?:wal|shm))$/i.test(base)) risks.push('database-file');
  if (/\.(?:jsonl|ndjson|csv|xlsx?)$/i.test(base)) risks.push('data-export-file');
  if (/\.(?:pem|key|pfx|p12)$/i.test(base) || /^(?:id_rsa|id_ed25519|.*private[-_]key.*|.*secret[-_]key.*|.*restore[-_]key.*|credentials\.json|secrets\.json)$/i.test(base)) risks.push('key-or-secret-file');
  if (/\.(?:log|dump|har)$/i.test(base) || /^(?:diagnostics?|report)[-_.].*\.(?:json|zip)$/i.test(base)) risks.push('diagnostic-capture');
  if (/^resources\/chromium\//i.test(relative) && segments.some(part => /^(?:Default|Profile \d+|System Profile|Guest Profile|BrowserMetrics)$/i.test(part))) risks.push('chromium-user-profile');
  return [...new Set(risks)];
}

const credentialPatterns = [
  ['api-token', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}\b/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['bearer-jwt', /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{20,}\b/g],
  ['private-key-material', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[\s\r\n\\n]+[A-Za-z0-9+/=]{40,}/g],
  ['credential-url', /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s/:@'"`]+:[^\s/@'"`]{8,}@/g],
];
function scanText(surface, name, bytes) {
  if (!bytes.length) { ignored.emptyFiles++; return; }
  if (bytes.length > 32 * 1024 * 1024) { ignored.oversizedTextFiles++; add(surface, name, 'text-too-large-to-scan'); return; }
  if (bytes.subarray(0, 8192).includes(0)) { ignored.binaryFiles++; return; }
  const source = bytes.toString('utf8');
  for (const [category, expression] of credentialPatterns) {
    expression.lastIndex = 0;
    for (const match of source.matchAll(expression)) {
      // Documented placeholders are not usable credentials. Do not print even
      // these matches: reviewers see only the path, line and classification.
      if (/(?:example|placeholder|your[_-]?(?:api[_-]?)?key|dummy|redacted|test[_-]?token)/i.test(match[0])) continue;
      add(surface, name, category, { line: source.slice(0, match.index).split('\n').length });
    }
  }
}

function inventory(root, relative = '', excludeDirectories) {
  const result = [];
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const name = path.join(relative, entry.name);
    const stat = fs.lstatSync(path.join(root, name));
    result.push({ path: normalize(name), directory: entry.isDirectory(), link: entry.isSymbolicLink(), size: stat.size, mtimeMs: stat.mtimeMs });
    if (entry.isDirectory() && !entry.isSymbolicLink() && !excludeDirectories?.test(entry.name)) result.push(...inventory(root, name, excludeDirectories));
  }
  return result;
}
const signature = rows => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
async function fileHash(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

const before = inventory(application);
const archiveHashBefore = await fileHash(archive);
let archiveFiles = 0, archiveEntries = 0, sourceFiles = 0, plainPackageFiles = 0;
for (const archiveEntry of before.filter(entry => !entry.directory && /\.asar$/i.test(entry.path))) {
  try {
    const currentArchive = path.join(application, archiveEntry.path);
    const entries = listPackage(currentArchive).map(normalize);
    archiveEntries += entries.length;
    for (const name of entries) {
      const innerPath = path.normalize(name);
      const reportPath = `${archiveEntry.path}/${name}`;
      const stat = statFile(currentArchive, innerPath, false);
      const directory = Boolean(stat.files);
      const risks = pathRisks(name, directory);
      for (const risk of risks) add('asar', reportPath, risk);
      if (directory) continue;
      archiveFiles++;
      if (currentArchive === archive && !name.startsWith('node_modules/')
        && /\.(?:png|jpe?g|webp|gif|bmp|svg|mp4|webm|csv|xlsx?|jsonl|ndjson|db|sqlite3?)$/i.test(name)) firstPartyAssets.push({ path: reportPath, bytes: stat.size });
      if (stat.link) { add('asar', reportPath, 'archive-link'); continue; }
      if (/^(?:server|electron)\/.*\.js\.bin$/i.test(name)) ignored.protectedBusinessModules++;
      // Never open suspected key/session/business files, even for confirmation.
      if (risks.length) continue;
      if (!textExtension.test(name)) { ignored.binaryFiles++; continue; }
      if (stat.size > 32 * 1024 * 1024) { ignored.oversizedTextFiles++; add('asar', reportPath, 'text-too-large-to-scan'); continue; }
      scanText('asar', reportPath, extractFile(currentArchive, innerPath)); plainPackageFiles++;
    }
  } catch {
    add('asar', archiveEntry.path, 'archive-read-incomplete');
  }
}

for (const entry of before) {
  const risks = pathRisks(entry.path, entry.directory);
  for (const risk of risks) add('application', entry.path, risk);
  if (entry.link) { add('application', entry.path, 'filesystem-link'); continue; }
  if (entry.directory || risks.length || /\.asar$/i.test(entry.path)) continue;
  if (!textExtension.test(entry.path)) { ignored.binaryFiles++; continue; }
  if (entry.size > 32 * 1024 * 1024) { ignored.oversizedTextFiles++; add('application', entry.path, 'text-too-large-to-scan'); continue; }
  scanText('application', entry.path, fs.readFileSync(path.join(application, entry.path))); plainPackageFiles++;
}

for (const directory of sourceDirectories) {
  const root = path.join(repository, directory);
  if (!fs.existsSync(root)) continue;
  for (const entry of inventory(root, '', /^(?:node_modules|test|tests|fixtures|\.data.*|data|uploads|backups)$/i)) {
    if (entry.directory || entry.link || !sourceExtensions.test(entry.path)) continue;
    const name = normalize(path.join(directory, entry.path));
    // Dependencies, fixture records, local profiles and all key material are
    // excluded. Only first-party executable source is eligible for this pass.
    if (/(?:^|\/)(?:node_modules|test|tests|fixtures|\.data[^/]*|data|uploads|backups)(?:\/|$)/i.test(name)
      || pathRisks(name).length || !codeExtension.test(name)) { ignored.sourceMaterialExcluded++; continue; }
    scanText('source', name, fs.readFileSync(path.join(repository, name))); sourceFiles++;
  }
}

const after = inventory(application);
const archiveHashAfter = await fileHash(archive);
const stable = signature(before) === signature(after) && archiveHashBefore === archiveHashAfter;
if (!stable) add('application', '.', 'candidate-changed-during-audit');
const result = {
  createdAt: new Date().toISOString(), application, archiveSha256: archiveHashAfter,
  ok: stable && findings.length === 0, stable,
  inspected: { archiveEntries, archiveFiles, applicationEntries: before.length, sourceFiles, plainPackageFiles,
    unpackedFiles: before.filter(entry => !entry.directory && /^resources\/app\.asar\.unpacked\//.test(entry.path)).length,
    chromiumFiles: before.filter(entry => !entry.directory && /^resources\/chromium\//.test(entry.path)).length },
  findings, ignored, firstPartyAssets,
  limitations: ['Opaque binaries and encrypted business modules are not semantically inspected; first-party source token scanning supplements the package inventory.',
    'Third-party fixture/example findings require explicit human review; no allowlist is applied automatically.',
    'No user key files, browser sessions or suspected business-data files are opened.'],
};
fs.writeFileSync(path.join(output, 'package-privacy.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
if (!result.ok) process.exitCode = 1;
