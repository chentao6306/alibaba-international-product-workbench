import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { verifyArtifact, compareVersions } from './update-protocol.js';
import { UPDATE_PUBLIC_KEY } from './update-key.js';

const CHUNK = 4 * 1024 * 1024;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const validId = (id) => /^[a-f0-9-]{36}$/.test(id);
async function digest(file) {
  const hash = crypto.createHash('sha256');
  for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}

export function registerUpdateRoutes(app, { requireAdmin, directory, publicKey = UPDATE_PUBLIC_KEY }) {
  fs.mkdirSync(directory, { recursive: true });
  const catalog = path.join(directory, 'releases.json');
  const locks = new Set();
  const read = () => fs.existsSync(catalog) ? JSON.parse(fs.readFileSync(catalog, 'utf8')) : [];
  const save = (items) => {
    const temp = `${catalog}.tmp`;
    const fd = fs.openSync(temp, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(items)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, catalog);
  };
  const find = (id) => {
    const item = validId(id) && read().find((entry) => entry.id === id);
    if (!item) throw fail('没有找到更新版本', 404);
    return item;
  };
  const file = (item, partial = false) => path.join(directory, `${item.id}.exe${partial ? '.part' : ''}`);
  const offset = (item) => { try { return fs.statSync(file(item, true)).size; } catch { return 0; } };
  const patch = (id, changes) => save(read().map((item) => item.id === id ? { ...item, ...changes, updatedAt: new Date().toISOString() } : item));
  const details = (body) => {
    const title = String(body?.title || '').trim(), notes = String(body?.notes || '').trim();
    if (!title || title.length > 100 || notes.length > 10000) throw fail('请填写更新标题（最多 100 字）和说明（最多 10000 字）');
    return { title, notes };
  };
  const publicRelease = (item) => ({ title: item.title, notes: item.notes, publishedAt: item.publishedAt, envelope: item.envelope, url: `/updates/chaodekuai/files/${item.id}.exe` });
  const prefix = '/api/admin/updates';
  app.get('/updates/chaodekuai/latest.json', (_request, response) => {
    // Withdrawing the newest release stops distribution rather than silently
    // advertising an older package to clients that have not updated yet.
    const newest = read().filter((entry) => entry.publishedAt).sort((a, b) => compareVersions(b.artifact.version, a.artifact.version))[0];
    const item = newest?.status === 'published' && newest.complete ? newest : null;
    response.set('Cache-Control', 'no-store').json({ release: item ? publicRelease(item) : null });
  });
  app.get('/updates/chaodekuai/files/:filename', (request, response) => {
    const item = find(request.params.filename.replace(/\.exe$/, ''));
    if (request.params.filename !== `${item.id}.exe` || item.status !== 'published' || !item.complete) throw fail('此安装包尚未发布或已撤回', 404);
    response.set('Cache-Control', 'no-store');
    response.sendFile(file(item));
  });
  app.get(prefix, requireAdmin, (_request, response) => response.json(read().map((item) => ({ ...item, uploaded: item.complete ? item.artifact.size : offset(item) })).reverse()));
  app.post(prefix, requireAdmin, (request, response) => {
    const content = details(request.body);
    const artifact = verifyArtifact(request.body.envelope, publicKey);
    if (artifact.version.includes('-')) throw fail('只能上传正式版安装包');
    const items = read();
    const previous = items.find((item) => item.artifact.version === artifact.version);
    if (previous) {
      if (previous.artifact.sha256 !== artifact.sha256) throw fail('该版本已存在其他安装包，请提升版本号重新打包');
      if (previous.status !== 'draft') throw fail('该版本已有发布记录，请在下方版本记录中编辑说明或调整分发状态；新安装包请使用更高版本号', 409);
      patch(previous.id, content);
      response.json({ ...find(previous.id), uploaded: previous.complete ? artifact.size : offset(previous) });
      return;
    }
    if (items.length >= 200) throw fail('版本记录已达上限，请联系维护人员归档历史版本');
    const item = { id: crypto.randomUUID(), artifact, envelope: request.body.envelope, ...content, status: 'draft', complete: false, createdAt: new Date().toISOString(), author: request.admin.username };
    save([...items, item]);
    response.status(201).json({ ...item, uploaded: 0 });
  });
  app.get(`${prefix}/:id/file`, requireAdmin, (request, response) => {
    const item = find(request.params.id);
    if (!item.complete || !fs.existsSync(file(item))) throw fail('安装包尚未上传完成并通过校验', 409);
    response.set('Cache-Control', 'no-store');
    response.download(file(item), item.artifact.filename);
  });
  app.put(`${prefix}/:id/file`, requireAdmin, express.raw({ type: 'application/octet-stream', limit: CHUNK }), async (request, response) => {
    const item = find(request.params.id);
    if (locks.has(item.id)) throw fail('该安装包正在处理，请稍后重试', 409);
    if (item.complete) throw fail('安装包已上传完成', 409);
    const start = Number(request.query.offset);
    if (!Number.isSafeInteger(start) || start < 0 || start !== offset(item)) throw fail('上传进度已变化，请重新选择相同文件继续上传', 409);
    if (!Buffer.isBuffer(request.body) || !request.body.length || start + request.body.length > item.artifact.size) throw fail('上传文件大小不正确');
    locks.add(item.id);
    try {
      const fd = await fs.promises.open(file(item, true), 'a', 0o600);
      try { await fd.writeFile(request.body); await fd.sync(); } finally { await fd.close(); }
      response.json({ uploaded: offset(item) });
    } finally { locks.delete(item.id); }
  });
  app.post(`${prefix}/:id/complete`, requireAdmin, async (request, response) => {
    const item = find(request.params.id);
    if (locks.has(item.id)) throw fail('该安装包正在处理，请稍后重试', 409);
    locks.add(item.id);
    try {
      const candidate = fs.existsSync(file(item)) ? file(item) : file(item, true);
      if (!fs.existsSync(candidate) || fs.statSync(candidate).size !== item.artifact.size || await digest(candidate) !== item.artifact.sha256) {
        // A failed checksum can never be published; allow a complete re-upload.
        if (fs.existsSync(file(item, true))) fs.unlinkSync(file(item, true));
        throw fail('安装包完整性校验失败，请重新上传相同的官方安装包');
      }
      if (candidate !== file(item)) fs.renameSync(candidate, file(item));
      patch(item.id, { complete: true });
      response.json(find(item.id));
    } finally { locks.delete(item.id); }
  });
  app.patch(`${prefix}/:id`, requireAdmin, async (request, response) => {
    const item = find(request.params.id);
    if (locks.has(item.id)) throw fail('该安装包正在处理，请稍后重试', 409);
    locks.add(item.id);
    try {
      const content = details(request.body);
      const status = request.body.status;
      if (!['draft', 'published', 'withdrawn'].includes(status)) throw fail('无效的发布状态');
      if (status === 'published') {
        if (!item.complete || !fs.existsSync(file(item)) || await digest(file(item)) !== item.artifact.sha256) throw fail('请先完整上传并校验安装包');
        const newer = read().some((entry) => entry.publishedAt && compareVersions(entry.artifact.version, item.artifact.version) > 0);
        if (newer && item.status !== 'published') throw fail('已有更高版本发布过，请提升版本号，不能重新发布旧版');
      }
      patch(item.id, { ...content, status, author: request.admin.username, ...(status === 'published' ? { publishedAt: item.publishedAt || new Date().toISOString() } : {}) });
      response.json(find(item.id));
    } finally { locks.delete(item.id); }
  });
}
