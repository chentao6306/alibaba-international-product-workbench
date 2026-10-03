import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { transform } from 'esbuild';
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
    const source = fs.readFileSync(path.join(directory, name), 'utf8');
    const expected = /\.(js|cjs)$/.test(name) ? (await transform(source, { loader: 'js', target: 'node22', minifyWhitespace: true,
      minifySyntax: false, minifyIdentifiers: false, legalComments: 'none', sourcemap: false })).code : source;
    assert.equal(asar.extractFile(archive, `${directory}/${name}`).toString(), expected, `Stale module: ${directory}/${name}`);
    modules++;
  }
}
assert.equal(asar.extractFile(archive, 'auth-server/update-protocol.js').toString(), fs.readFileSync('auth-server/update-protocol.js', 'utf8'));
assert.equal(JSON.parse(asar.extractFile(archive, 'package.json')).version, pkg.version);
for (const entry of asar.listPackage(archive)) assert.ok(!/\/(?:\.data|\.env)(?:\/|$)|private\.pem$/.test(entry.replaceAll('\\', '/')), `Private data bundled: ${entry}`);
const executable = path.join(release, `chaodekuai-${pkg.version}-setup.exe`);
const artifact = verifyArtifact(JSON.parse(fs.readFileSync(`${executable}.update.json`, 'utf8')), UPDATE_CONFIG.publicKey);
const hash = crypto.createHash('sha256');
for await (const chunk of fs.createReadStream(executable)) hash.update(chunk);
assert.equal(hash.digest('hex'), artifact.sha256);
assert.equal(fs.statSync(executable).size, artifact.size);
console.log(JSON.stringify({ modules, ...artifact, executable }, null, 2));
