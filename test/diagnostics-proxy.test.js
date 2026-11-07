import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { diagnosticProxyConfig } from '../tools/deploy-diagnostics-proxy.mjs';

test('diagnostic deployment upgrades the legacy proxy without changing other upload limits or duplicating its route', () => {
  const current = fs.readFileSync(new URL('../auth-server/deploy/nginx-compatible-https.conf', import.meta.url), 'utf8');
  const legacy = current.replace(/    location = \/api\/client\/diagnostics \{[\s\S]*?\n    \}\r?\n/, '');
  assert.notEqual(legacy, current);
  const upgraded = diagnosticProxyConfig(legacy);
  assert.equal((upgraded.match(/location = \/api\/client\/diagnostics/g) || []).length, 1);
  assert.match(upgraded, /location = \/api\/client\/diagnostics \{\s+client_max_body_size 8m;/);
  assert.match(upgraded, /client_max_body_size 128k;/);
  assert.match(upgraded, /location \/api\/admin\/updates\/ \{\s+client_max_body_size 5m;/);
  assert.equal(diagnosticProxyConfig(upgraded), upgraded);
  assert.equal(diagnosticProxyConfig(current), current);
});

test('diagnostic deployment rejects an unrecognized proxy instead of broadening request limits', () => {
  assert.throws(() => diagnosticProxyConfig('server { listen 80; location / { } }'), /未识别 HTTPS/);
  assert.throws(() => diagnosticProxyConfig('server { listen 443 ssl; }'), /未识别 HTTPS/);
});
