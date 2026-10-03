// Run after upload of auth-server/deploy/update-service.sh. Nginx only raises
// the authenticated chunk-upload route's limit, not authorization endpoints.
import fs from 'node:fs';
const file = process.argv[2];
if (!file) throw new Error('请指定 Nginx 站点配置文件');
const config = fs.readFileSync(file, 'utf8');
if (!config.includes('location /api/admin/updates/')) {
  const location = `    location /api/admin/updates/ {
        client_max_body_size 5m;
        proxy_pass http://127.0.0.1:8790;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 120s;
    }
`;
  if (!config.includes('    location / {')) throw new Error('未找到已知反向代理配置，未修改文件');
  fs.copyFileSync(file, `${file}.before-updates-${Date.now()}`);
  fs.writeFileSync(file, config.replace('    location / {', `${location}    location / {`));
}
