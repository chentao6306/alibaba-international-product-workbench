const $ = (id) => document.getElementById(id);
let token = sessionStorage.getItem('auth-admin-token') || '';
let page = 1; let noticePage = 1; let licenses = []; let notices = []; let noticeId = ''; let action = null;
let accountRequest = 0; let noticeRequest = 0;
const names = { active: '正常', expired: '已到期', paused: '已停用', revoked: '已注销', draft: '草稿', published: '已发布', withdrawn: '已撤回' };
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const time = (value) => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '-';
const badge = (status) => `<span class="badge ${escape(status)}">${escape(names[status] || status)}</span>`;
function message(text = '', success = false) { $('msg').textContent = text; $('msg').classList.toggle('success', success); }
function loggedIn(value) { $('loginBox').hidden = value; $('app').hidden = !value; $('logout').hidden = !value; }
async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
  const data = await response.json();
  if (!response.ok) { if (response.status === 401) { token = ''; sessionStorage.removeItem('auth-admin-token'); loggedIn(false); } throw Error(data.error || '请求失败'); }
  return data;
}
async function stats() {
  const data = await api('/api/admin/stats');
  $('stats').innerHTML = [['total', '全部账号'], ['active', '正常授权'], ['expired', '已到期'], ['paused', '已停用'], ['activeUsers24h', '24 小时活跃']].map(([key, name]) => `<div class="stat"><b>${escape(data[key])}</b><span>${name}</span></div>`).join('');
}
function pages(element, data, change) {
  const count = Math.max(1, Math.ceil(data.total / data.pageSize));
  element.innerHTML = `<span>共 ${data.total} 条</span><button class="secondary" aria-label="上一页" ${data.page <= 1 ? 'disabled' : ''}>‹</button><span>${data.page} / ${count}</span><button class="secondary" aria-label="下一页" ${data.page >= count ? 'disabled' : ''}>›</button>`;
  const buttons = element.querySelectorAll('button');
  buttons[0].onclick = () => change(data.page - 1); buttons[1].onclick = () => change(data.page + 1);
}
async function loadAccounts() {
  const serial = ++accountRequest;
  const query = new URLSearchParams({ page, pageSize: $('pageSize').value, status: $('status').value, search: $('search').value });
  const data = await api(`/api/admin/licenses?${query}`);
  if (serial !== accountRequest) return;
  if (!data.items.length && page > 1) { page = Math.max(1, Math.ceil(data.total / data.pageSize)); return loadAccounts(); }
  licenses = data.items;
  $('licenses').innerHTML = `<table><thead><tr><th>Alibaba 账号</th><th>状态</th><th>到期（北京时间）</th><th>最近活动</th><th>设备</th><th>多端登录</th><th>操作</th></tr></thead><tbody>${licenses.map((item, index) => `<tr><td class="account">${escape(item.alibaba_account)}<small>${escape(item.note)}</small></td><td>${badge(item.display_status)}</td><td>${escape(time(item.expires_at))}</td><td>${escape(time(item.last_seen_at))}</td><td>${item.device_count}</td><td><label class="switch-label"><input type="checkbox" role="switch" aria-label="${escape(item.alibaba_account)} 多端登录" data-device="${index}" ${item.allow_multi_device ? 'checked' : ''}>允许</label></td><td><div class="actions"><button class="secondary" data-action="extend" data-index="${index}">延长</button>${item.display_status === 'active' ? `<button class="secondary" data-action="pause" data-index="${index}">停用</button>` : ['paused', 'revoked'].includes(item.status) ? `<button class="secondary" data-action="resume" data-index="${index}">恢复</button>` : ''}${item.status !== 'revoked' ? `<button class="danger" data-action="revoke" data-index="${index}">注销</button>` : ''}</div></td></tr>`).join('')}</tbody></table>${!licenses.length ? '<div class="empty">没有匹配的账号</div>' : ''}`;
  $('licenses').querySelectorAll('[data-action]').forEach((button) => { button.onclick = () => openAction(licenses[button.dataset.index], button.dataset.action); });
  $('licenses').querySelectorAll('[data-device]').forEach((input) => { input.onchange = () => { const item = licenses[input.dataset.device]; const value = input.checked; input.checked = item.allow_multi_device; openAction(item, 'devices', value); }; });
  pages($('licensePages'), data, (value) => { page = value; loadAccounts().catch((error) => message(error.message)); });
}
function openAction(item, type, allowMultiDevice) {
  action = { item, type, allowMultiDevice };
  $('actionHeading').textContent = ({ extend: '延长授权', pause: '停用账号', resume: '恢复账号', revoke: '注销授权', devices: '更改登录策略' })[type];
  $('actionText').textContent = type === 'devices' ? `${item.alibaba_account}：${allowMultiDevice ? '允许多台电脑同时登录。' : '仅允许最后登录的设备继续使用，其他设备将在下次授权检查时退出。'}` : `${item.alibaba_account}${['pause', 'revoke'].includes(type) ? ' 的现有客户端将失去使用授权。' : ''}`;
  $('extendField').hidden = type !== 'extend'; $('extendDays').value = 30; $('actionError').textContent = ''; $('actionDialog').showModal();
}
$('actionForm').onsubmit = async (event) => {
  event.preventDefault(); $('confirmAction').disabled = true;
  try { await api(`/api/admin/licenses/${action.item.id}`, { method: 'PATCH', body: JSON.stringify({ action: action.type, days: Number($('extendDays').value), allowMultiDevice: action.allowMultiDevice }) }); $('actionDialog').close(); await Promise.all([loadAccounts(), stats()]); message('授权已更新', true); }
  catch (error) { $('actionError').textContent = error.message; } finally { $('confirmAction').disabled = false; }
};
$('cancelAction').onclick = () => $('actionDialog').close();
async function loadNotices() {
  const serial = ++noticeRequest;
  const data = await api(`/api/admin/announcements?page=${noticePage}&pageSize=20`);
  if (serial !== noticeRequest) return;
  notices = data.items;
  $('announcements').innerHTML = `<table><thead><tr><th>标题</th><th>展示方式</th><th>状态</th><th>更新时间</th><th>操作</th></tr></thead><tbody>${notices.map((item, index) => `<tr><td class="notice-title">${escape(item.title)}</td><td>${item.kind === 'popup' ? '弹窗公告' : '公告列表'}</td><td>${badge(item.status)}</td><td>${escape(time(item.updated_at))}</td><td><div class="actions"><button class="secondary" data-notice="${index}">编辑</button><button class="secondary" data-preview="${index}">预览</button></div></td></tr>`).join('')}</tbody></table>${!notices.length ? '<div class="empty">暂无公告</div>' : ''}`;
  $('announcements').querySelectorAll('[data-notice]').forEach((button) => { button.onclick = () => editNotice(notices[button.dataset.notice]); });
  $('announcements').querySelectorAll('[data-preview]').forEach((button) => { button.onclick = () => preview(notices[button.dataset.preview]); });
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
$('logout').onclick = () => { token = ''; sessionStorage.removeItem('auth-admin-token'); loggedIn(false); message(); };
$('days').onchange = () => { $('customDaysField').hidden = $('days').value !== 'custom'; };
$('activateForm').onsubmit = async (event) => {
  event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true;
  try { await api('/api/admin/licenses', { method: 'POST', body: JSON.stringify({ alibabaAccount: $('account').value, days: Number($('days').value === 'custom' ? $('customDays').value : $('days').value), note: $('note').value }) }); $('account').value = ''; $('note').value = ''; page = 1; await Promise.all([stats(), loadAccounts()]); message('授权已保存，新账号默认允许多端登录', true); }
  catch (error) { message(error.message); } finally { button.disabled = false; }
};
$('filterForm').onsubmit = (event) => { event.preventDefault(); page = 1; loadAccounts().catch((error) => message(error.message)); };
for (const name of ['status', 'pageSize']) $(name).onchange = () => { page = 1; loadAccounts().catch((error) => message(error.message)); };
if (token) { loggedIn(true); Promise.all([stats(), loadAccounts()]).catch((error) => message(error.message)); }
