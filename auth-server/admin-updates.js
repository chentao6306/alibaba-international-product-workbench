// Uses the administrator's existing session; no public write endpoints.
const byId = (id) => document.getElementById(id);
let selectedRelease = null;
let uploading = false;
let stopUpload = false;
let uploadController;

async function updateRequest(route, { raw, ...options } = {}) {
  const response = await fetch(`/api/admin/updates${route}`, { ...options, headers: {
    authorization: `Bearer ${sessionStorage.getItem('auth-admin-token') || ''}`,
    'content-type': raw ? 'application/octet-stream' : 'application/json',
  }, signal: options.signal || AbortSignal.timeout(120000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '操作失败，请重新登录或稍后重试');
  return result;
}
function report(message, error = false) { byId('updateMessage').textContent = message; byId('updateMessage').style.color = error ? '#b64032' : '#147b70'; }
function fields() { return { title: byId('updateTitle').value, notes: byId('updateNotes').value }; }
function edit(item) {
  selectedRelease = item;
  byId('updateTitle').value = item.title; byId('updateNotes').value = item.notes;
  byId('updateEditing').textContent = `当前编辑：${item.artifact.version} · ${item.complete ? '安装包已校验' : '上传未完成'}`;
  for (const id of ['saveUpdateNotes', 'publishUpdate', 'withdrawUpdate']) byId(id).disabled = uploading;
  byId('publishUpdate').disabled = uploading || !item.complete;
}
async function loadUpdates() {
  const items = await updateRequest('');
  const list = byId('updateVersions'); list.replaceChildren();
  for (const item of items) {
    const row = document.createElement('div'); row.className = 'row update-version';
    const label = document.createElement('span'); label.className = 'grow';
    label.textContent = `${item.artifact.version} · ${item.title} · ${{ draft: '草稿', published: '已发布', withdrawn: '已撤回' }[item.status]}${item.complete ? '' : ` · 已上传 ${(item.uploaded / 1048576).toFixed(1)} MB`}`;
    const button = document.createElement('button'); button.className = 'secondary'; button.textContent = '编辑'; button.disabled = uploading;
    button.onclick = () => edit(item); row.append(label, button); list.append(row);
  }
  if (!items.length) list.textContent = '尚未上传软件更新';
  return items;
}
byId('updatesTab').addEventListener('click', () => loadUpdates().catch((e) => report(e.message, true)));
byId('newUpdate').onclick = () => {
  selectedRelease = null; byId('updateForm').reset(); byId('updateEditing').textContent = '上传新版本';
  for (const id of ['saveUpdateNotes', 'publishUpdate', 'withdrawUpdate']) byId(id).disabled = true;
  report('');
};
byId('stopUpdateUpload').onclick = () => { stopUpload = true; uploadController?.abort(); };
byId('updateForm').onsubmit = async (event) => {
  event.preventDefault(); if (uploading) return;
  const installer = byId('updateInstaller').files[0], signature = byId('updateSignature').files[0];
  if (!installer || !signature) return report('请选择安装包 EXE 和对应的签名 JSON 文件', true);
  if (signature.size > 20000) return report('签名文件过大', true);
  uploading = true; stopUpload = false;
  byId('uploadUpdate').disabled = true; byId('newUpdate').disabled = true;
  byId('stopUpdateUpload').hidden = false;
  for (const id of ['saveUpdateNotes', 'publishUpdate', 'withdrawUpdate']) byId(id).disabled = true;
  try {
    const envelope = JSON.parse(await signature.text());
    const item = await updateRequest('', { method: 'POST', body: JSON.stringify({ ...fields(), envelope }) });
    if (installer.size !== item.artifact.size || installer.name !== item.artifact.filename) throw new Error('安装包名称或大小与签名不一致，请选择同一版本的两个文件');
    let start = item.uploaded;
    while (start < installer.size) {
      if (stopUpload) throw new Error('上传已暂停。下次选择相同的安装包和签名文件，可继续上传');
      uploadController = new AbortController();
      const result = await updateRequest(`/${item.id}/file?offset=${start}`, { method: 'PUT', raw: true, body: installer.slice(start, start + 4194304), signal: AbortSignal.any([uploadController.signal, AbortSignal.timeout(120000)]) });
      start = result.uploaded;
      byId('updateUploadProgress').value = start / installer.size * 100;
      report(`正在上传 ${Math.floor(start / installer.size * 100)}% · ${(start / 1048576).toFixed(1)} / ${(installer.size / 1048576).toFixed(1)} MB`);
    }
    report('上传完成，正在校验安装包…');
    const completed = await updateRequest(`/${item.id}/complete`, { method: 'POST', body: '{}' });
    selectedRelease = completed;
    report('安装包校验通过，已保存草稿。确认更新说明后点击“正式发布”');
  } catch (e) { report(stopUpload ? '上传已暂停，重新选择相同文件可继续上传' : e.message, true); }
  finally {
    uploading = false; uploadController = null;
    byId('uploadUpdate').disabled = false; byId('newUpdate').disabled = false; byId('stopUpdateUpload').hidden = true;
    if (selectedRelease) edit(selectedRelease);
    loadUpdates().catch((e) => report(e.message, true));
  }
};
for (const [id, status, question] of [
  ['saveUpdateNotes', null, ''], ['publishUpdate', 'published', '正式发布后，客户的软件即可检测到此更新。确认发布？'],
  ['withdrawUpdate', 'withdrawn', '撤回后将停止分发此版本。已安装的客户端不会降级。确认撤回？'],
]) byId(id).onclick = async () => {
  if (!selectedRelease || uploading || (question && !window.confirm(question))) return;
  byId(id).disabled = true;
  try {
    const item = await updateRequest(`/${selectedRelease.id}`, { method: 'PATCH', body: JSON.stringify({ ...fields(), status: status || selectedRelease.status }) });
    edit(item); await loadUpdates(); report('已保存软件更新');
  } catch (e) { report(e.message, true); } finally { if (selectedRelease) edit(selectedRelease); }
};
window.addEventListener('beforeunload', (event) => { if (uploading) { event.preventDefault(); event.returnValue = ''; } });
