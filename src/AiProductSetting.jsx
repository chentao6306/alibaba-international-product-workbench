import { useEffect, useRef, useState } from 'react';
import { Save, FlaskConical } from 'lucide-react';

export default function AiProductSetting({ request, notify, refresh }) {
  const [form, setForm] = useState(null);
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState('');
  const saving = useRef(false);
  useEffect(() => { request('/api/settings/ai-products').then(result => { setForm(result); setSaved(JSON.stringify(result)); }).catch(error => notify(error.message, 'error')); }, []);
  async function save(event) {
    event.preventDefault();
    if (saving.current) return;
    saving.current = true; setBusy(true);
    try {
      const result = await request('/api/settings/ai-products', { method: 'PATCH', body: JSON.stringify({ ...form, ...(apiKey ? { apiKey } : {}) }) });
      setForm(result); setSaved(JSON.stringify(result));
      setApiKey(''); await refresh(); notify('AI 商品处理设置已保存');
    } catch (error) { notify(error.message, 'error'); }
    finally { saving.current = false; setBusy(false); }
  }
  async function test() {
    setBusy(true);
    try {
      const result = await request('/api/settings/ai-products/test', { method: 'POST', body: '{}' });
      notify(`连接成功：${result.provider} / ${result.model}`);
    } catch (error) { notify(error.message, 'error'); }
    finally { setBusy(false); }
  }
  if (!form) return <section className="panel settings-panel"><div className="muted-row">正在读取 AI 商品处理设置…</div></section>;
  return <section className="processing-settings">
    <h2>AI 采集与属性映射</h2>
    <form onSubmit={save}>
      <div className="processing-fields">
        <label><span>处理方式</span><select aria-label="商品处理方式" disabled={busy} value={form.mode} onChange={event => setForm({ ...form, mode: event.target.value })}>
          <option value="rules">规则模式（现有方式）</option><option value="assisted">AI 辅助模式</option>
        </select></label>
        <label><span>AI 服务</span><select aria-label="AI 服务" disabled={busy} value={form.provider} onChange={event => { setForm({ ...form, provider: event.target.value, apiKeyConfigured: false }); setApiKey(''); }}>
          <option value="deepseek">DeepSeek（优先）</option><option value="openai">OpenAI</option>
        </select></label>
        <label><span>模型</span><input aria-label="AI 商品模型" disabled={busy} value={form[`${form.provider}Model`]} onChange={event => setForm({ ...form, [`${form.provider}Model`]: event.target.value })} required /></label>
        <label><span>API 密钥</span><input aria-label="AI 商品 API 密钥" type="password" autoComplete="new-password" disabled={busy} value={apiKey}
          placeholder={form.apiKeyConfigured ? '已加密保存，留空保留' : '填写该服务的 API 密钥；已有密钥可留空'} onChange={event => setApiKey(event.target.value)} /></label>
      </div>
      <div className="processing-toggles">
        <label><input type="checkbox" disabled={busy || form.mode === 'rules'} checked={form.collect} onChange={event => setForm({ ...form, collect: event.target.checked })} />采集时从商品正文补充明确属性</label>
        <label><input type="checkbox" disabled={busy || form.mode === 'rules'} checked={form.mapAttributes} onChange={event => setForm({ ...form, mapAttributes: event.target.checked })} />上架时辅助映射当前类目属性</label>
      </div>
      <p className="batch-help">开启后，将商品标题、属性和部分正文发送给所选 AI 服务，按服务商 API 计费。原始资料保留；AI 结果仍须通过当前类目选项和填写回读检查，缺少依据时保留待处理提示。连接失败会继续使用规则方式。</p>
      <div className="processing-actions">
        <button className="primary-button" disabled={busy}><Save size={17} />保存 AI 设置</button>
        <button type="button" className="secondary-button" disabled={busy || Boolean(apiKey) || !form.apiKeyConfigured || JSON.stringify(form) !== saved} onClick={test}><FlaskConical size={17} />测试已保存的 AI 连接</button>
        {form.apiKeyConfigured && <button type="button" className="secondary-button" disabled={busy || JSON.stringify(form) !== saved} onClick={async () => {
          setBusy(true);
          try {
            const result = await request('/api/settings/ai-products', { method: 'PATCH', body: JSON.stringify({ ...form, mode: 'rules', apiKey: '' }) });
            setForm(result); setSaved(JSON.stringify(result)); setApiKey(''); await refresh(); notify('已移除该服务密钥并恢复规则模式');
          } catch (error) { notify(error.message, 'error'); }
          finally { setBusy(false); }
        }}>移除当前服务密钥</button>}
      </div>
    </form>
  </section>;
}
