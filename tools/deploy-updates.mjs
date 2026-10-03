// Run after upload of auth-server/deploy/update-service.sh. Nginx only raises
// the authenticated chunk-upload route's limit, not authorization endpoints.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function updateProxyConfig(config) {
  const block = (route, limit) => `    location ${route} {
        client_max_body_size ${limit};
        proxy_pass http://127.0.0.1:8790;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 120s;
    }
`;
  // A proxied prefix ending in '/' makes Nginx redirect the collection URL
  // without that slash. A browser follows its 301 by converting POST to GET.
  // Keep both URLs usable, including already open administrator pages.
  const exact = /location\s*=\s*\/api\/admin\/updates\s*\{/.test(config) ? '' : block('= /api/admin/updates', '128k');
  const prefix = /location\s+\/api\/admin\/updates\/\s*\{/.test(config) ? '' : block('/api/admin/updates/', '5m');
  if (!exact && !prefix) return config;
  if (!config.includes('    location / {')) throw new Error('未找到已知反向代理配置，未修改文件');
  return config.replace('    location / {', `${exact}${prefix}    location / {`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) throw new Error('请指定 Nginx 站点配置文件');
  const config = fs.readFileSync(file, 'utf8');
  const updated = updateProxyConfig(config);
  if (updated !== config) {
    fs.copyFileSync(file, `${file}.before-updates-${Date.now()}`);
    fs.writeFileSync(file, updated);
  }
}
