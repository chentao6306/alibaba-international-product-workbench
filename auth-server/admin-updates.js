// Uses the administrator's existing session; no public write endpoints.
const byId = (id) => document.getElementById(id);
const apiUrl = (route = '') => `/api/admin/updates/${route.replace(/^\/+/, '')}`;
const authorization = () => `Bearer ${sessionStorage.getItem('auth-admin-token') || ''}`;
let selectedRelease = null;
let uploading = false;
let mutating = false;
let stopUpload = false;
let uploadController;
let listRequest = 0;

async function updateRequest(route, { raw, ...options } = {}) {
  let response;
  try {
    response = await fetch(apiUrl(route), { ...options, redirect: 'error', headers: {
      authorization: authorization(), 'content-type': raw ? 'application/octet-stream' : 'application/json',
    }, signal: options.signal || AbortSignal.timeout(120000) });
  } catch (error) {
    if (stopUpload) throw error;
    throw new Error('无法连接更新服务，请刷新页面或稍后重试；已上传的部分可以继续上传');
  }
  let result;
  try { result = await response.json(); } catch { throw new Error(`更新服务返回异常（HTTP ${response.status}），请刷新页面后重试`); }
  if (!response.ok) throw new Error(result?.error || '操作失败，请重新登录或稍后重试');
  return result;
}
function releaseItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item) || !/^[a-f0-9-]{36}$/.test(item.id)
    || !Number.isSafeInteger(item.artifact?.size) || item.artifact.size < 2
    || typeof item.artifact.version !== 'string' || item.artifact.filename !== `chaodekuai-${item.artifact.version}-setup.exe`
    || typeof item.title !== 'string' || typeof item.notes !== 'string'
    || !['draft', 'published', 'withdrawn'].includes(item.status)) {
    throw new Error('更新服务返回的版本信息不完整，请刷新管理页面后重试');
  }
  const uploaded = item.uploaded ?? (item.complete ? item.artifact.size : 0);
  if (!Number.isSafeInteger(uploaded) || uploaded < 0 || uploaded > item.artifact.size) throw new Error('服务器返回的上传进度无效，请刷新页面后重试');
  return { ...item, uploaded };
}
function report(message, error = false, history = false) {
  const target = byId(history ? 'updateHistoryMessage' : 'updateMessage');
  target.textContent = message; target.classList.toggle('error', error);
}
function fields() { return { title: byId('updateTitle').value, notes: byId('updateNotes').value }; }
function controls() {
  const busy = uploading || mutating;
  for (const id of ['uploadUpdate', 'newUpdate', 'saveUpdateNotes', 'cancelUpdateEdit', 'refreshUpdates']) byId(id).disabled = busy;
  for (const element of byId('updateVersions').querySelectorAll('button')) element.disabled = busy;
  for (const id of ['updateInstaller', 'updateSignature', 'updateTitle', 'updateNotes']) byId(id).disabled = busy;
  byId('stopUpdateUpload').hidden = !uploading;
  byId('saveUpdateNotes').hidden = !selectedRelease;
  byId('cancelUpdateEdit').hidden = !selectedRelease;
  byId('newUpdate').hidden = !selectedRelease;
  byId('uploadUpdate').hidden = Boolean(selectedRelease?.complete);
}
function resetEditor() {
  selectedRelease = null; byId('updateForm').reset(); byId('updateEditing').hidden = true;
  byId('updateProgressArea').hidden = true; controls();
}
function edit(item) {
  if (uploading || mutating) return;
  selectedRelease = item;
  byId('updateTitle').value = item.title; byId('updateNotes').value = item.notes;
  byId('updateInstaller').value = ''; byId('updateSignature').value = '';
  byId('updateEditing').hidden = false;
  byId('updateEditing').textContent = `当前编辑：${item.artifact.version} · ${item.complete ? '安装包已校验，可修改更新说明' : '上传未完成，选择相同的 EXE 和签名文件可继续上传'}`;
  controls(); report(''); byId('updateEditor').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
const node = (tag, text, className = '') => {
  const element = document.createElement(tag); element.textContent = text; element.className = className; return element;
};
const time = (value) => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—';
const megabytes = (value) => (value / 1048576).toFixed(1);
function actionButton(label, action, item, kind = 'secondary') {
  const button = node('button', label, kind); button.type = 'button'; button.dataset.action = action;
  button.onclick = () => {
    if (action === 'edit') edit(item);
    else if (action === 'download') void download(item);
    else void changeRelease(item, action === 'publish' ? 'published' : 'withdrawn');
  };
  return button;
}
function renderUpdates(items) {
  const container = byId('updateVersions'); container.replaceChildren();
  byId('updateVersionCount').textContent = items.length;
  if (!items.length) { container.append(node('p', '尚未上传软件更新，上传安装包后将在这里显示版本记录。', 'empty')); return; }
  const table = document.createElement('table'); table.className = 'update-records';
  const head = table.createTHead().insertRow();
  for (const text of ['版本 / 状态', '更新说明', '时间', '操作']) { const cell = node('th', text); cell.scope = 'col'; head.append(cell); }
  const body = table.createTBody();
  for (const item of items) {
    const row = body.insertRow(); row.dataset.releaseId = item.id;
    const version = row.insertCell(); version.className = 'update-version-cell';
    version.append(node('strong', item.artifact.version), node('span', { draft: '草稿', published: '已正式发布', withdrawn: '已停止分发' }[item.status], `badge ${item.status}`),
      node('small', item.complete ? `安装包已校验 · ${megabytes(item.artifact.size)} MB` : `已上传 ${megabytes(item.uploaded)} / ${megabytes(item.artifact.size)} MB`));
    const notes = row.insertCell(); notes.className = 'update-notes-cell';
    notes.append(node('strong', item.title), node('div', item.notes || '暂无更新说明', 'update-record-notes'));
    const dates = row.insertCell(); dates.className = 'update-time-cell'; dates.append(node('span', time(item.createdAt)));
    if (item.publishedAt) dates.append(node('small', `发布时间：${time(item.publishedAt)}`));
    if (item.updatedAt && item.updatedAt !== item.publishedAt) dates.append(node('small', `最后修改：${time(item.updatedAt)}`));
    const actions = row.insertCell(); const group = node('div', '', 'update-record-actions'); actions.append(group);
    if (item.status === 'published') group.append(actionButton('停止分发', 'withdraw', item));
    else if (item.complete) group.append(actionButton('正式发布', 'publish', item, ''));
    group.append(actionButton(item.complete ? '编辑说明' : '继续上传', 'edit', item));
    if (item.complete && item.status === 'published') {
      const link = node('a', '下载安装包'); link.href = `/updates/chaodekuai/files/${item.id}.exe`; link.download = item.artifact.filename; group.append(link);
    } else if (item.complete) group.append(actionButton('下载安装包', 'download', item, 'text-link'));
  }
  container.append(table); controls();
}
async function loadUpdates() {
  const request = ++listRequest;
  const items = await updateRequest('');
  if (!Array.isArray(items)) throw new Error('更新服务返回的版本列表无效，请刷新页面后重试');
  const verified = items.map(releaseItem);
  if (request === listRequest) renderUpdates(verified);
  return verified;
}
async function changeRelease(item, status, fromEditor = false) {
  if (uploading || mutating) return;
  const question = status === 'published' ? `正式发布 ${item.artifact.version} 后，客户的软件即可检测到此更新。确认发布？`
    : status === 'withdrawn' ? `停止分发 ${item.artifact.version}？客户将不能再下载此版本，已安装的客户端不会降级。` : '';
  if (!fromEditor && question && !window.confirm(question)) return;
  mutating = true; controls();
  try {
    const updated = releaseItem(await updateRequest(item.id, { method: 'PATCH', body: JSON.stringify({
      ...(fromEditor ? fields() : { title: item.title, notes: item.notes }), status: status || item.status,
    }) }));
    if (selectedRelease?.id === updated.id) selectedRelease = updated;
    await loadUpdates();
    report(fromEditor ? '更新说明已保存' : status === 'published' ? '版本已正式发布，客户现在可以检查更新' : '版本已停止分发', false, !fromEditor);
  } catch (error) { report(error.message, true, !fromEditor); }
  finally { mutating = false; controls(); }
}
async function download(item) {
  if (uploading || mutating) return;
  try {
    report('正在准备下载安装包…', false, true);
    const response = await fetch(apiUrl(`${item.id}/file`), { headers: { authorization: authorization() }, redirect: 'error', signal: AbortSignal.timeout(600000) });
    if (!response.ok) { const error = await response.json(); throw new Error(error?.error || '下载失败'); }
    const blob = await response.blob();
    if (blob.size !== item.artifact.size) throw new Error('安装包下载不完整，请重新下载');
    const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = item.artifact.filename;
    document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
    report('安装包已下载', false, true);
  } catch (error) { report(error.message || '下载失败，请稍后重试', true, true); }
}
byId('updatesTab').addEventListener('click', () => loadUpdates().catch((error) => report(error.message, true, true)));
byId('refreshUpdates').onclick = () => { report('', false, true); loadUpdates().catch((error) => report(error.message, true, true)); };
byId('newUpdate').onclick = byId('cancelUpdateEdit').onclick = () => { if (!uploading && !mutating) { resetEditor(); report(''); } };
byId('saveUpdateNotes').onclick = () => { if (selectedRelease && byId('updateForm').reportValidity()) void changeRelease(selectedRelease, selectedRelease.status, true); };
byId('stopUpdateUpload').onclick = () => { stopUpload = true; uploadController?.abort(); };
byId('updateForm').onsubmit = async (event) => {
  event.preventDefault(); if (uploading || mutating) return;
  const installer = byId('updateInstaller').files[0], signature = byId('updateSignature').files[0];
  if (!installer || !signature) return report('请选择安装包 EXE 和对应的签名 JSON 文件', true);
  if (signature.size > 20000) return report('签名文件过大，请选择构建时生成的 .exe.update.json 文件', true);
  uploading = true; stopUpload = false; controls(); report('正在验证签名信息…');
  byId('updateProgressArea').hidden = false; byId('updateUploadProgress').value = 0; byId('updateProgressText').textContent = '';
  try {
    let envelope;
    try { envelope = JSON.parse(await signature.text()); } catch { throw new Error('签名文件不是有效的 JSON，请选择安装包配套的 .exe.update.json 文件'); }
    if (stopUpload) throw new Error('上传已暂停');
    uploadController = new AbortController();
    const item = releaseItem(await updateRequest('', { method: 'POST', body: JSON.stringify({ ...fields(), envelope }),
      signal: AbortSignal.any([uploadController.signal, AbortSignal.timeout(120000)]) }));
    if (installer.size !== item.artifact.size || installer.name !== item.artifact.filename) throw new Error('安装包名称或大小与签名不一致，请选择同一版本的两个文件');
    const progress = (bytes) => {
      byId('updateUploadProgress').value = bytes / installer.size * 100;
      byId('updateProgressText').textContent = `${Math.floor(bytes / installer.size * 100)}% · ${megabytes(bytes)} / ${megabytes(installer.size)} MB`;
    };
    let start = item.uploaded; progress(start);
    while (start < installer.size) {
      if (stopUpload) throw new Error('上传已暂停');
      uploadController = new AbortController();
      const result = await updateRequest(`${item.id}/file?offset=${start}`, { method: 'PUT', raw: true, body: installer.slice(start, start + 4194304), signal: AbortSignal.any([uploadController.signal, AbortSignal.timeout(120000)]) });
      if (!Number.isSafeInteger(result?.uploaded) || result.uploaded <= start || result.uploaded > installer.size) throw new Error('服务器返回的上传进度无效，请重新选择相同文件继续上传');
      start = result.uploaded; progress(start); report('正在上传安装包，关闭页面后可重新选择相同文件继续上传');
    }
    if (stopUpload) throw new Error('上传已暂停');
    report('上传完成，正在校验安装包…');
    releaseItem(await updateRequest(`${item.id}/complete`, { method: 'POST', body: '{}' }));
    resetEditor();
    report('安装包校验通过，已保存草稿。请在下方版本记录中点击“正式发布”');
  } catch (error) { report(stopUpload ? '上传已暂停，重新选择相同文件可继续上传' : error.message, true); }
  finally {
    uploading = false; uploadController = null; controls();
    loadUpdates().catch((error) => report(error.message, true, true));
  }
};
window.addEventListener('beforeunload', (event) => { if (uploading) { event.preventDefault(); event.returnValue = ''; } });
