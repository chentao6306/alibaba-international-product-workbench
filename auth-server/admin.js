const $ = (id) => document.getElementById(id);
let token = sessionStorage.getItem('auth-admin-token') || '';
let page = 1; let noticePage = 1; let licenses = []; let notices = []; let noticeId = ''; let action = null;
let accountRequest = 0; let noticeRequest = 0;
const names = { active: '正常授权', expired: '已到期', paused: '已停用', revoked: '已注销', deleted: '已删除', draft: '草稿', published: '已发布', withdrawn: '已撤回' };
const statusInputs = () => [...document.querySelectorAll('#statusFilters input')];
const selectedStatuses = () => statusInputs().filter((input) => input.checked).map((input) => input.value);
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const time = (value) => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '-';
const badge = (status) => `<span class="badge ${escape(status)}">${escape(names[status] || status)}</span>`;
function message(text = '', success = false) { $('msg').textContent = text; $('msg').classList.toggle('success', success); }
function loggedIn(value) { $('loginBox').hidden = value; $('app').hidden = !value; $('logout').hidden = !value; }
function showCredential(item) {
  if (!item.activationCode) return;
  $('credentialAccount').textContent = item.alibaba_account;
  $('credentialValue').value = item.activationCode;
  $('credentialMessage').textContent = '';
  $('credentialDialog').showModal();
}
$('credentialDialog').addEventListener('close', () => { $('credentialValue').value = ''; $('credentialAccount').textContent = ''; });
$('copyCredential').onclick = async () => {
  try { await navigator.clipboard.writeText($('credentialValue').value); $('credentialMessage').textContent = '已复制'; }
  catch { $('credentialValue').select(); $('credentialMessage').textContent = '请复制选中的授权码'; }
};
async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
  const data = await response.json();
  if (!response.ok) { if (response.status === 401) { token = ''; sessionStorage.removeItem('auth-admin-token'); loggedIn(false); } throw Error(data.error || '请求失败'); }
  return data;
}
async function stats() {
  const data = await api('/api/admin/stats');
  $('stats').innerHTML = [['total', '全部账号'], ['active', '正常授权'], ['expired', '已到期'], ['paused', '已停用'], ['revoked', '已注销'], ['deleted', '已删除'], ['activeUsers24h', '24 小时活跃']].map(([key, name]) => `<button class="stat" data-filter="${key}" aria-pressed="false"><b>${escape(data[key])}</b><span>${name}</span></button>`).join('');
  $('stats').querySelectorAll('button').forEach((button) => { button.onclick = () => {
    resetFilters(); const key = button.dataset.filter;
    statusInputs().forEach((input) => { input.checked = input.value === key; });
    $('activity').value = key === 'activeUsers24h' ? '24h' : 'all';
    $('accountsTab').click(); applyFilters();
  }; });
  highlightStats();
}
function highlightStats() {
  const statuses = selectedStatuses();
  const plain = !$('search').value.trim() && $('devices').value === 'all';
  const key = !plain ? '' : $('activity').value === '24h' && !statuses.length ? 'activeUsers24h' : $('activity').value !== 'all' ? '' : statuses.length === 1 ? statuses[0] : !statuses.length ? 'total' : '';
  $('stats').querySelectorAll('button').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.filter === key)));
}
function resetFilters() { $('filterForm').reset(); page = 1; }
function applyFilters() { page = 1; loadAccounts().catch((error) => message(error.message)); }
function pages(element, data, change) {
  const count = Math.max(1, Math.ceil(data.total / data.pageSize));
  element.innerHTML = `<span>共 ${data.total} 条</span><button class="secondary" aria-label="上一页" ${data.page <= 1 ? 'disabled' : ''}>‹</button><span>${data.page} / ${count}</span><button class="secondary" aria-label="下一页" ${data.page >= count ? 'disabled' : ''}>›</button>`;
  const buttons = element.querySelectorAll('button');
  buttons[0].onclick = () => change(data.page - 1); buttons[1].onclick = () => change(data.page + 1);
}
async function loadAccounts() {
  const serial = ++accountRequest;
  const query = new URLSearchParams({ page, pageSize: $('pageSize').value, status: selectedStatuses().join(',') || 'all', activity: $('activity').value, devices: $('devices').value, search: $('search').value });
  const data = await api(`/api/admin/licenses?${query}`);
  if (serial !== accountRequest) return;
  if (!data.items.length && page > 1) { page = Math.max(1, Math.ceil(data.total / data.pageSize)); return loadAccounts(); }
  licenses = data.items;
  $('licenses').innerHTML = `<table><thead><tr><th>Alibaba 账号</th><th>状态</th><th>到期（北京时间）</th><th>最近活动</th><th>设备</th><th>多端登录</th><th>操作</th></tr></thead><tbody>${licenses.map((item, index) => `<tr><td class="account">${escape(item.alibaba_account)}<small title="${escape(item.note)}">${escape(item.note)}</small>${!item.deleted_at ? `<small class="${item.credential_required ? 'credential-ready' : 'credential-pending'}">${item.credential_required ? '授权码已启用' : '授权安全待升级'}</small>` : ''}${item.deleted_at ? `<small>删除于 ${escape(time(item.deleted_at))}</small>` : ''}</td><td>${badge(item.display_status)}</td><td>${escape(time(item.expires_at))}</td><td>${escape(time(item.last_seen_at))}</td><td>${item.device_count}</td><td>${item.deleted_at ? '-' : `<label class="switch-label"><input type="checkbox" role="switch" aria-label="${escape(item.alibaba_account)} 多端登录" data-device="${index}" ${item.allow_multi_device ? 'checked' : ''}>允许</label>`}</td><td>${item.deleted_at ? '<span class="muted">授权已删除</span>' : `<div class="actions"><button class="secondary" data-action="credential" data-index="${index}">${item.credential_required ? '重置授权码' : '启用授权码'}</button><button class="secondary" data-action="extend" data-index="${index}">延长</button><button class="secondary" data-action="reduce" data-index="${index}">减少</button>${item.display_status === 'active' ? `<button class="secondary" data-action="pause" data-index="${index}">停用</button>` : ['paused', 'revoked'].includes(item.status) ? `<button class="secondary" data-action="resume" data-index="${index}">恢复</button>` : ''}${item.status !== 'revoked' ? `<button class="danger" data-action="revoke" data-index="${index}">注销</button>` : ''}<button class="danger" data-action="delete" data-index="${index}">删除</button></div>`}</td></tr>`).join('')}</tbody></table>${!licenses.length ? '<div class="empty">没有匹配的账号</div>' : ''}`;
  highlightStats();
  $('licenses').querySelectorAll('[data-action="credential"]').forEach((button) => {
    const index = button.dataset.index;
    const control = document.createElement('button');
    control.className = 'secondary'; control.dataset.action = 'connection'; control.dataset.index = index;
    control.textContent = `断线宽限 ${licenses[index].offline_grace_minutes ?? 5} 分钟`;
    button.after(control);
  });
  $('licenses').querySelectorAll('[data-action]').forEach((button) => { button.onclick = () => openAction(licenses[button.dataset.index], button.dataset.action); });
  $('licenses').querySelectorAll('[data-device]').forEach((input) => { input.onchange = () => { const item = licenses[input.dataset.device]; const value = input.checked; input.checked = item.allow_multi_device; openAction(item, 'devices', value); }; });
  pages($('licensePages'), data, (value) => { page = value; loadAccounts().catch((error) => message(error.message)); });
}
function openAction(item, type, allowMultiDevice) {
  action = { item, type, allowMultiDevice };
  $('actionHeading').textContent = ({ credential: item.credential_required ? '重置软件授权码' : '启用软件授权码', extend: '延长授权', reduce: '减少授权天数', pause: '停用账号', resume: '恢复账号', revoke: '注销授权', delete: '删除用户', deleteNotice: '删除公告', devices: '更改登录策略' })[type];
  $('actionText').textContent = type === 'deleteNotice' ? `确认删除公告“${item.title}”？用户端同步后将移除这条公告。此操作无法撤销。` : type === 'delete' ? `确认删除用户“${item.alibaba_account}”？授权将失效，设备记录将清除，账号移入“已删除”。` : type === 'devices' ? `${item.alibaba_account}：${allowMultiDevice ? '允许多台电脑同时登录。' : '仅允许最后登录的设备继续使用，其他设备将在下次授权检查时退出。'}` : `${item.alibaba_account}${['pause', 'revoke'].includes(type) ? ' 的现有客户端将失去使用授权。' : ''}`;
  const adjusting = ['extend', 'reduce'].includes(type);
  $('connectionField').hidden = type !== 'connection'; $('offlineGraceMinutes').disabled = type !== 'connection';
  $('offlineGraceMinutes').value = item.offline_grace_minutes ?? 5;
  if (type === 'connection') {
    $('actionHeading').textContent = '授权连接中断策略';
    $('actionText').textContent = `${item.alibaba_account}：从最后一次成功校验开始计时，超过宽限后保留界面和进度并暂停后续任务。授权到期或停用仍失效。下次成功心跳生效，需要客户端 1.4.7 或更新版本。`;
  }
  if (type === 'credential') $('actionText').textContent = `${item.alibaba_account}：现有会话会失效。请先确认客户已安装 1.4.6 或更新版本，并将生成的新授权码交给客户。启用后不再允许旧版无授权码登录。`;
  $('extendField').hidden = !adjusting; $('extendDays').disabled = !adjusting;
  $('daysLabel').textContent = type === 'reduce' ? '减少天数' : '延长天数';
  $('extendDays').value = 30; $('expiryPreview').hidden = !adjusting;
  $('confirmAction').classList.toggle('danger', ['delete', 'deleteNotice', 'revoke'].includes(type));
  updateExpiryPreview(); $('actionError').textContent = ''; $('actionDialog').showModal();
}
function updateExpiryPreview() {
  if (!action || !['extend', 'reduce'].includes(action.type)) return;
  const days = Number($('extendDays').value);
  if (!Number.isFinite(days) || days <= 0 || days > 36500) { $('expiryPreview').textContent = '请输入 1 至 36500 天'; return; }
  const current = new Date(action.item.expires_at).getTime();
  const next = (action.type === 'reduce' ? current : Math.max(Date.now(), current)) + (action.type === 'reduce' ? -1 : 1) * days * 86400000;
  $('expiryPreview').textContent = `原到期时间：${time(current)}\n调整后到期：${time(next)}${next <= Date.now() ? '\n调整后授权将立即到期。' : ''}`;
}
$('extendDays').oninput = updateExpiryPreview;
$('actionForm').onsubmit = async (event) => {
  event.preventDefault(); $('confirmAction').disabled = true;
  try {
    const removing = ['delete', 'deleteNotice'].includes(action.type);
    const announcement = action.type === 'deleteNotice';
    const updated = await api(`/api/admin/${announcement ? 'announcements' : 'licenses'}/${action.item.id}`, { method: removing ? 'DELETE' : 'PATCH', ...(removing ? {} : { body: JSON.stringify({ action: action.type, days: Number($('extendDays').value), allowMultiDevice: action.allowMultiDevice, offlineGraceMinutes: Number($('offlineGraceMinutes').value) }) }) });
    $('actionDialog').close();
    showCredential(updated);
    if (announcement) await loadNotices(); else await Promise.all([loadAccounts(), stats()]);
    message(removing ? '已删除' : '授权已更新', true);
  }
  catch (error) { $('actionError').textContent = error.message; } finally { $('confirmAction').disabled = false; }
};
$('cancelAction').onclick = () => $('actionDialog').close();
async function loadNotices() {
  const serial = ++noticeRequest;
  const data = await api(`/api/admin/announcements?page=${noticePage}&pageSize=20`);
  if (serial !== noticeRequest) return;
  if (!data.items.length && noticePage > 1) { noticePage = Math.max(1, Math.ceil(data.total / data.pageSize)); return loadNotices(); }
  notices = data.items;
  $('announcements').innerHTML = `<table><thead><tr><th>标题</th><th>展示方式</th><th>状态</th><th>更新时间</th><th>操作</th></tr></thead><tbody>${notices.map((item, index) => `<tr><td class="notice-title">${escape(item.title)}</td><td>${item.kind === 'popup' ? '弹窗公告' : '公告列表'}</td><td>${badge(item.status)}</td><td>${escape(time(item.updated_at))}</td><td><div class="actions"><button class="secondary" data-notice="${index}">编辑</button><button class="secondary" data-preview="${index}">预览</button><button class="danger" data-delete-notice="${index}">删除</button></div></td></tr>`).join('')}</tbody></table>${!notices.length ? '<div class="empty">暂无公告</div>' : ''}`;
  $('announcements').querySelectorAll('[data-notice]').forEach((button) => { button.onclick = () => editNotice(notices[button.dataset.notice]); });
  $('announcements').querySelectorAll('[data-preview]').forEach((button) => { button.onclick = () => preview(notices[button.dataset.preview]); });
  $('announcements').querySelectorAll('[data-delete-notice]').forEach((button) => { button.onclick = () => openAction(notices[button.dataset.deleteNotice], 'deleteNotice'); });
  pages($('noticePages'), data, (value) => { noticePage = value; loadNotices().catch((error) => message(error.message)); });
}
function editNotice(item = {}) {
  noticeId = item.id || ''; $('noticeHeading').textContent = noticeId ? '编辑公告' : '新建公告';
  $('noticeTitle').value = item.title || ''; $('noticeContent').value = item.content || ''; $('noticeKind').value = item.kind || 'notice'; $('noticeStatus').value = item.status || 'draft'; $('noticeError').textContent = ''; $('noticeDialog').showModal();
}
function preview(item) { $('previewTitle').textContent = item.title; $('previewContent').textContent = item.content; $('previewDialog').showModal(); }
$('noticeForm').onsubmit = async (event) => {
  event.preventDefault(); $('saveNotice').disabled = true;
  try { await api(`/api/admin/announcements${noticeId ? `/${noticeId}` : ''}`, { method: noticeId ? 'PATCH' : 'POST', body: JSON.stringify({ title: $('noticeTitle').value, content: $('noticeContent').value, kind: $('noticeKind').value, status: $('noticeStatus').value }) }); $('noticeDialog').close(); await loadNotices(); message('公告已保存', true); }
  catch (error) { $('noticeError').textContent = error.message; } finally { $('saveNotice').disabled = false; }
};
$('previewNotice').onclick = () => preview({ title: $('noticeTitle').value, content: $('noticeContent').value });
$('cancelNotice').onclick = () => $('noticeDialog').close();
$('createNotice').onclick = () => editNotice();
document.querySelectorAll('.close-dialog').forEach((button) => { button.onclick = () => button.closest('dialog').close(); });
for (const name of ['accounts', 'announcements']) $(name + 'Tab').onclick = () => {
  for (const other of ['accounts', 'announcements']) { $(other + 'Panel').hidden = other !== name; $(other + 'Tab').setAttribute('aria-selected', String(other === name)); }
  if (name === 'announcements') loadNotices().catch((error) => message(error.message));
};
$('loginForm').onsubmit = async (event) => {
  event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true;
  try { const data = await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ username: $('adminUser').value, password: $('adminPass').value }) }); token = data.token; sessionStorage.setItem('auth-admin-token', token); $('adminPass').value = ''; loggedIn(true); await Promise.all([stats(), loadAccounts()]); message(); }
  catch (error) { message(error.message); } finally { button.disabled = false; }
};
$('logout').onclick = async () => {
  $('logout').disabled = true;
  try { await api('/api/admin/logout', { method: 'POST' }); token = ''; sessionStorage.removeItem('auth-admin-token'); loggedIn(false); message(); }
  catch (error) { message(error.message); }
  finally { $('logout').disabled = false; }
};
$('days').onchange = () => { $('customDaysField').hidden = $('days').value !== 'custom'; };
$('activateForm').onsubmit = async (event) => {
  event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true;
  try { const updated = await api('/api/admin/licenses', { method: 'POST', body: JSON.stringify({ alibabaAccount: $('account').value, days: Number($('days').value === 'custom' ? $('customDays').value : $('days').value), note: $('note').value }) }); showCredential(updated); $('account').value = ''; $('note').value = ''; page = 1; await Promise.all([stats(), loadAccounts()]); message('授权已保存，新账号默认允许多端登录并启用软件授权码', true); }
  catch (error) { message(error.message); } finally { button.disabled = false; }
};
$('filterForm').onsubmit = (event) => { event.preventDefault(); applyFilters(); };
for (const name of ['activity', 'devices', 'pageSize']) $(name).onchange = applyFilters;
statusInputs().forEach((input) => { input.onchange = applyFilters; });
$('resetFilters').onclick = () => { resetFilters(); applyFilters(); };
if (token) { loggedIn(true); Promise.all([stats(), loadAccounts()]).catch((error) => message(error.message)); }
