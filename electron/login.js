const $ = (id) => document.getElementById(id);
const api = window.kuaYipu;
let authorized = false;
const errorText = (error, fallback) => String(error?.message || fallback).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');

async function updateActivationStatus() {
  const username = $('username').value;
  const saved = await api.activationStatus(username);
  if ($('username').value !== username) return;
  $('activationStatus').textContent = saved ? '已加密保存' : '';
  $('activationCode').placeholder = saved ? '留空使用已保存的授权码' : '管理员提供的授权码';
}

if (!api) {
  $('error').textContent = '客户端组件加载失败，请重新解压完整安装包';
  $('login').disabled = true;
} else {
  api.onLoginStatus((message) => { $('error').textContent = message; });
  api.loadCredentials().then(async (saved) => {
    if (saved) { $('username').value = saved.username || ''; $('password').value = saved.password || ''; $('remember').checked = true; }
    await updateActivationStatus();
  }).catch((error) => { $('error').textContent = errorText(error, '读取凭据失败'); });
  $('username').onchange = () => { $('activationCode').value = ''; updateActivationStatus().catch(() => {}); };
  $('login').onclick = async () => {
    $('error').textContent = ''; $('login').disabled = true;
    try {
      if (authorized) { $('login').textContent = '正在打开…'; await api.enter(); return; }
      $('login').textContent = '正在登录…';
      const result = await api.login({ username: $('username').value, password: $('password').value, activationCode: $('activationCode').value, remember: $('remember').checked });
      $('error').textContent = '';
      authorized = true; $('activationCode').value = ''; await updateActivationStatus();
      $('expiry').hidden = false;
      $('expiry').textContent = '授权有效期至：' + new Date(result.expiresAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    } catch (error) {
      $('error').textContent = errorText(error, authorized ? '进入工作台失败，请重试' : '登录失败');
      if (/重新登录/.test($('error').textContent)) { authorized = false; $('expiry').hidden = true; }
    }
    finally { $('login').textContent = authorized ? '进入系统' : '登录'; $('login').disabled = false; }
  };
}
