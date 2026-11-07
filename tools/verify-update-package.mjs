import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { verifyArtifact } from '../auth-server/update-protocol.js';
import { UPDATE_CONFIG } from '../electron/update-config.js';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const release = path.resolve(process.argv[2] || process.env.CHAODEKUAI_RELEASE_DIR || 'release-installer');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const archive = path.join(release, 'win-unpacked', 'resources', 'app.asar');
let modules = 0;
for (const directory of ['electron', 'server']) {
  for (const name of fs.readdirSync(directory).filter((name) => /\.(js|cjs|html)$/.test(name))) {
    const generated = path.join('.packaged', directory, name);
    assert.ok(fs.existsSync(generated), `Missing protected build output: ${directory}/${name}`);
    assert.ok(asar.extractFile(archive, `${directory}/${name}`).equals(fs.readFileSync(generated)), `Stale module: ${directory}/${name}`);
    modules++;
  }
  for (const name of fs.readdirSync(path.join('.packaged', directory)).filter((name) => /\.(?:bin|jsc)$/.test(name))) {
    assert.ok(asar.extractFile(archive, `${directory}/${name}`).equals(fs.readFileSync(path.join('.packaged', directory, name))), `Stale protected module: ${directory}/${name}`);
  }
}
for (const file of ['auth-server/update-protocol.js', 'auth-server/announcement-content.js']) {
  assert.equal(asar.extractFile(archive, file).toString(), fs.readFileSync(file, 'utf8'), `Stale shared module: ${file}`);
}
assert.equal(JSON.parse(asar.extractFile(archive, 'package.json')).version, pkg.version);
for (const entry of asar.listPackage(archive)) assert.ok(!/\/(?:\.data|\.env)(?:\/|$)|private\.pem$/.test(entry.replaceAll('\\', '/')), `Private data bundled: ${entry}`);
const executable = path.join(release, `chaodekuai-${pkg.version}-setup.exe`);
const artifact = verifyArtifact(JSON.parse(fs.readFileSync(`${executable}.update.json`, 'utf8')), UPDATE_CONFIG.publicKey);
const hash = crypto.createHash('sha256');
for await (const chunk of fs.createReadStream(executable)) hash.update(chunk);
assert.equal(hash.digest('hex'), artifact.sha256);
assert.equal(fs.statSync(executable).size, artifact.size);
console.log(JSON.stringify({ modules, ...artifact, executable }, null, 2));
