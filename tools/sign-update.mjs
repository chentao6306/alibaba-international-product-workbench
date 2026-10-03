import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { signArtifact, verifyArtifact } from '../auth-server/update-protocol.js';
import { UPDATE_CONFIG } from '../electron/update-config.js';

export function signUpdate(file, version) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const keyFile = process.env.CHAODEKUAI_UPDATE_SIGNING_KEY || path.join(root, '.data', 'chaodekuai-update-private.pem');
  if (!fs.existsSync(keyFile)) throw new Error('缺少更新签名私钥，请设置 CHAODEKUAI_UPDATE_SIGNING_KEY。不可替换已发行客户端的公钥。');
  const artifact = { schema: 1, product: 'com.kua-yipu.workbench', platform: 'win32', arch: 'x64', version,
    filename: path.basename(file), size: fs.statSync(file).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
  const envelope = signArtifact(artifact, fs.readFileSync(keyFile));
  verifyArtifact(envelope, UPDATE_CONFIG.publicKey);
  fs.writeFileSync(`${file}.update.json`, `${JSON.stringify(envelope, null, 2)}\n`);
  return artifact;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(signUpdate(path.resolve(process.argv[2]), process.argv[3]));
