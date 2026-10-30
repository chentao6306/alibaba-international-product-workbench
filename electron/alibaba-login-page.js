// This function runs in the Alibaba document. Keep it self-contained so it can
// be serialized into Electron and exercised against real DOM fixtures.
export function alibabaLoginPage(action, payload = {}) {
  const visible = (node) => Boolean(node && node.getClientRects().length
    && getComputedStyle(node).visibility !== 'hidden' && getComputedStyle(node).display !== 'none');
  const first = (scope, selectors) => selectors.flatMap((selector) => [...scope.querySelectorAll(selector)])
    .find((node) => visible(node) && !node.disabled && !node.readOnly);
  const password = first(document, ['input[name="password"]', 'input[type="password"]']);
  const scope = password?.form || document;
  const account = first(scope, ['input[name="account"]', 'input[name="loginId"]', 'input[type="email"]', 'input[type="text"]']);
  const state = document.__kuaYipuLoginState ||= { interacted: false, credentialsEdited: false };
  if (!state.listening) {
    state.listening = true;
    for (const type of ['input', 'keydown', 'pointerdown']) document.addEventListener(type, (event) => {
      if (!event.isTrusted || event.target.closest?.('#__kua_yipu_entry_bar')) return;
      state.interacted = true;
      if (type === 'input' && (event.target === account || event.target === password)) state.credentialsEdited = true;
    }, true);
  }
  const bar = document.getElementById('__kua_yipu_entry_bar');
  const text = String(document.body?.innerText || '').replace(bar?.innerText || '\0', '').replace(/\s+/g, ' ').trim();
  const credentialError = /account name or password is incorrect|incorrect (?:account|password)|invalid (?:username|password)|账号或密码(?:错误|不正确)|账户名或密码(?:错误|不正确)|密码错误/i.test(text);
  const challenge = /captcha|滑块|请完成验证|人机验证|安全验证|向右滑动验证|verify you are human/i.test(text);
  const hasLoginForm = Boolean(password || first(document, ['input[name="account"]', 'input[name="loginId"]']));
  const ready = Boolean(account && password);
  if (action === 'status') {
    const childCount = document.body?.children?.length || 0;
    const rawScript = /(?:function\s*\(|var\s+[A-Za-z_$]|\.grecaptcha-badge\s*\{)/.test(text.slice(0, 1200)) && childCount < 3;
    return { ready, hasLoginForm, credentialError, challenge, interacted: state.interacted,
      credentialsEdited: state.credentialsEdited, rendered: Boolean(!rawScript && childCount >= 3 && text.length > 20) };
  }
  if (action === 'account' || action === 'password') {
    if (!ready || state.interacted || credentialError || challenge) return false;
    const node = action === 'account' ? account : password;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(node, payload.value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
    return node.value === payload.value;
  }
  if (action === 'submit') {
    // A rerender, delayed form, or a user's correction must never submit stale
    // credentials or accidentally click a button in a hidden login form.
    if (!ready || state.interacted || credentialError || challenge
      || account.value !== payload.username || password.value !== payload.password) return false;
    const button = first(scope, ['button[type="submit"]', 'button[class*="submit"]', 'input[type="submit"]']);
    if (!button || (password.form && !password.form.checkValidity())) return false;
    button.click();
    return true;
  }
  if (action === 'message') {
    if (!document.body) return false;
    const panel = bar || document.createElement('div');
    if (!bar) {
      panel.id = '__kua_yipu_entry_bar';
      panel.innerHTML = '<span data-kua-yipu-status role="status"></span><button id="__kua_yipu_enter">已登录，点击进入软件</button><button id="__kua_yipu_refresh">刷新页面</button>';
      Object.assign(panel.style, { position: 'fixed', left: '0', right: '0', bottom: '0', minHeight: '64px', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '12px', padding: '12px 24px', boxSizing: 'border-box', background: '#fff', borderTop: '1px solid #d9e0e5', boxShadow: '0 -2px 10px rgba(0,0,0,.12)', zIndex: '2147483647', fontFamily: 'Microsoft YaHei, sans-serif', fontSize: '15px' });
      for (const button of panel.querySelectorAll('button')) Object.assign(button.style, { flexShrink: '0', height: '40px', padding: '0 22px', border: '1px solid #b9c2cc', borderRadius: '4px', background: '#fff', cursor: 'pointer', fontSize: '15px' });
      const enter = panel.querySelector('#__kua_yipu_enter');
      Object.assign(enter.style, { background: '#1677ff', color: '#fff', border: '0' });
      enter.addEventListener('click', (event) => {
        event.preventDefault();
        enter.disabled = true;
        enter.textContent = '正在进入…';
        try { window.open('kua-yipu://enter', '_blank'); } catch {}
        setTimeout(() => { try { window.location.href = 'kua-yipu://enter/'; } catch {} }, 120);
      });
      panel.querySelector('#__kua_yipu_refresh').addEventListener('click', () => location.reload());
      document.body.appendChild(panel);
      document.body.style.paddingBottom = '88px';
    }
    const status = panel.querySelector('[data-kua-yipu-status]');
    status.textContent = payload.message;
    status.style.color = payload.error ? '#b13a31' : '#303840';
    const enter = panel.querySelector('#__kua_yipu_enter');
    enter.hidden = !payload.canEnter;
    enter.disabled = false;
    enter.textContent = '已登录，点击进入软件';
    return true;
  }
  return false;
}
