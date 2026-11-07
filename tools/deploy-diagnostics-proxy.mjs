import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function diagnosticProxyConfig(config) {
  if (/location\s*=\s*\/api\/client\/diagnostics\s*\{/.test(config)) return config;
  if (!config.includes('    location / {') || !/listen\s+443\s+ssl/.test(config)) throw new Error('未识别 HTTPS 代理配置，未修改文件');
  return config.replace('    location / {', `    location = /api/client/diagnostics {
        client_max_body_size 8m;
        proxy_pass http://127.0.0.1:8790;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 60s;
    }
    location / {`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('请指定 Nginx 配置文件');
  fs.writeFileSync(process.argv[2], diagnosticProxyConfig(fs.readFileSync(process.argv[2], 'utf8')));
}
