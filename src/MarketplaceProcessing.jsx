import { useEffect, useState } from 'react';
import { Save, FlaskConical, WandSparkles, LoaderCircle } from 'lucide-react';
import { sourcePlatform } from '../server/source-platform.js';

async function request(path, body, method = 'POST') {
  const response = await fetch(path, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '请求失败');
  return result;
}

export default function MarketplaceProcessing({ notify }) {
  const [form, setForm] = useState(null);
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { request('/api/settings/processing', null, 'GET').then(setForm).catch((error) => notify(error.message, 'error')); }, []);
  if (!form) return <section className="processing-settings">正在读取加工设置…</section>;
  async function save(event) {
    event.preventDefault(); setBusy(true);
    try {
      setForm(await request('/api/settings/processing', { ...form, ...(apiKey ? { apiKey } : {}) }, 'PATCH'));
      setApiKey(''); notify('DeepSeek 与加工规则已保存');
    } catch (error) { notify(error.message, 'error'); } finally { setBusy(false); }
  }
  async function test() {
    setBusy(true);
    try { const result = await request('/api/settings/processing/test', {}); notify(`连接成功：${result.title}`); }
    catch (error) { notify(error.message, 'error'); } finally { setBusy(false); }
  }
  return <section className="processing-settings"><h2>DeepSeek 与跨平台商品加工</h2><form onSubmit={save}>
    <div className="processing-fields"><label><span>DeepSeek API 密钥</span><input type="password" autoComplete="new-password" value={apiKey} placeholder={form.apiKeyConfigured ? '已保存，留空保留现有密钥' : '填写 DeepSeek API 密钥'} onChange={(event) => setApiKey(event.target.value)} /></label>
      <label><span>模型</span><input value={form.deepseekModel} onChange={(event) => setForm({ ...form, deepseekModel: event.target.value })} required /></label></div>
    <div className="processing-toggles"><label><input type="checkbox" checked={form.translateTitle} onChange={(event) => setForm({ ...form, translateTitle: event.target.checked })} />采集时将中文标题翻译为英文</label><label><input type="checkbox" checked={form.convertCurrency} onChange={(event) => setForm({ ...form, convertCurrency: event.target.checked })} />采集时将来源价格换算为美元</label></div>
    <div className="processing-fields">{[['CNY', '人民币'], ['EUR', '欧元'], ['GBP', '英镑']].map(([code, label]) => <label key={code}><span>1 {label}兑美元</span><input type="number" min="0.000001" max="10000" step="any" placeholder="未设置" value={form.usdRates?.[code] ?? ''} onChange={(event) => setForm({ ...form, usdRates: { ...form.usdRates, [code]: event.target.value } })} /></label>)}</div>
    <div className="processing-actions"><button className="primary-button" disabled={busy}><Save size={17} />保存设置</button><button type="button" className="secondary-button" disabled={busy || !form.apiKeyConfigured || Boolean(apiKey)} onClick={test}><FlaskConical size={17} />测试已保存的连接</button>{form.apiKeyConfigured && <button type="button" className="secondary-button" disabled={busy} onClick={async () => { setBusy(true); try { setForm(await request('/api/settings/processing', { ...form, apiKey: '' }, 'PATCH')); notify('已移除 API 密钥'); } catch (error) { notify(error.message, 'error'); } finally { setBusy(false); } }}>移除密钥</button>}</div>
  </form></section>;
}

export function ProcessSelectedProducts({ products, refresh, notify }) {
  const [progress, setProgress] = useState(null);
  const eligible = products.filter((product) => product.selected && sourcePlatform(product) !== 'alibaba.com' && product.status !== 'published');
  async function process() {
    let failed = 0;
    let warning = '';
    try {
      for (const [index, product] of eligible.entries()) {
        setProgress(`${index + 1}/${eligible.length}`);
        try { const result = await request('/api/products/process', { id: product.id }); if (result.warnings.length) { failed++; warning = result.warnings[0]; } }
        catch (error) { failed++; warning = error.message; }
      }
      await refresh(); notify(failed ? `加工完成，${failed} 件待处理：${warning}` : `已加工 ${eligible.length} 件商品`, failed ? 'error' : 'success');
    } finally { setProgress(null); }
  }
  return eligible.length > 0 || progress ? <button className="secondary-button" disabled={Boolean(progress)} onClick={process}>{progress ? <LoaderCircle size={16} className="spin" /> : <WandSparkles size={16} />}{progress ? `正在加工 ${progress}` : `加工跨平台商品 ${eligible.length}`}</button> : null;
}
