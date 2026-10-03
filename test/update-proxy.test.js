import test from 'node:test';
import assert from 'node:assert/strict';
import { updateProxyConfig } from '../tools/deploy-updates.mjs';

const base = 'server {\n    listen 443 ssl;\n    location / { proxy_pass http://127.0.0.1:8790; }\n}';
test('update proxy accepts the collection POST without redirecting it to a GET', () => {
  const config = updateProxyConfig(base);
  assert.match(config, /location = \/api\/admin\/updates \{[\s\S]*?client_max_body_size 128k/);
  assert.match(config, /location \/api\/admin\/updates\/ \{[\s\S]*?client_max_body_size 5m/);
  assert.equal(updateProxyConfig(config), config);
});
test('existing upload proxies gain an exact collection location without replacing other settings', () => {
  const prefix = '    location /api/admin/updates/ { client_max_body_size 5m; proxy_pass http://127.0.0.1:8790; }\n';
  const original = base.replace('    location / {', prefix + '    location / {');
  const fixed = updateProxyConfig(original);
  assert.ok(fixed.includes(prefix));
  assert.equal((fixed.match(/location \/api\/admin\/updates\//g) || []).length, 1);
  assert.ok(fixed.includes('location = /api/admin/updates {'));
  assert.equal(updateProxyConfig(fixed), fixed);
});
test('unknown reverse proxy layouts are left untouched', () => {
  assert.throws(() => updateProxyConfig('server { listen 443; }'), /未修改/);
});
