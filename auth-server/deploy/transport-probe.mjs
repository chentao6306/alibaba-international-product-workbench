import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const port = process.argv[2] || '8843';
assert.match(port, /^\d{2,5}$/);
const body = JSON.stringify({ username: '__security_probe_unlicensed__', deviceId: 'transport-probe' });
for (const protocol of ['http', 'https']) {
  const result = execFileSync('curl', ['--silent', '--show-error', '--max-time', '10', '--resolve', `106.55.45.126:${port}:127.0.0.1`, '--header', 'content-type: application/json', '--data-binary', '@-', `${protocol}://106.55.45.126:${port}/api/client/login`], { input: body, encoding: 'utf8' });
  assert.match(JSON.parse(result).reason, /没有有效的软件授权/);
}
console.log('TLS certificate validation and legacy POST-body forwarding passed.');
