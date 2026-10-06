import { useEffect, useRef, useState } from 'react';
import { DescriptionEditor } from './ProductEditor.jsx';
import './BatchDescriptionEditor.css';
import { chunks } from './batch-operations.js';
import BatchFailures from './BatchFailures.jsx';

const EMPTY = { id: '', name: '', html: '', version: 0 };
const STARTER = '<h2>{{title}}</h2><p>{{productImages}}</p><h2>Company Profile</h2><p>请在这里填写贵公司的介绍。</p><h2>Packaging &amp; Shipping</h2><p>请在这里填写包装与运输说明。</p><h2>FAQ</h2><p>请在这里填写常见问题与回答。</p>';
const TOKENS = [['title', '商品标题'], ['brand', '品牌'], ['model', '型号'], ['productImages', '商品详情图']];
async function request(url, body, method = 'POST') {
  const response = await fetch(url, { method: body === undefined ? 'GET' : method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || result.message || '模板操作失败');
  return result;
}
function previewDocument(html) {
  return '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; img-src http: https:; style-src &#39;unsafe-inline&#39;"><style>body{font:14px/1.7 Arial,sans-serif;color:#24354b;overflow-wrap:anywhere;padding:14px;margin:0}img{max-width:100%;height:auto}table{max-width:100%;border-collapse:collapse}td,th{border:1px solid #ddd;padding:8px}a{pointer-events:none}</style></head><body>' + html + '</body></html>';
}

export default function BatchDescriptionEditor({ products, onSaved, notify, onGuardChange }) {
  const [templates, setTemplates] = useState([]), [draft, setDraft] = useState(EMPTY), [baseline, setBaseline] = useState(EMPTY);
  const [busy, setBusy] = useState(true), [error, setError] = useState(''), [mode, setMode] = useState('replace');
  const [preview, setPreview] = useState(null);
  const mounted = useRef(true), lock = useRef(false), appliedIds = useRef(new Set());
  const [item, setItem] = useState(null), [failures, setFailures] = useState([]), [message, setMessage] = useState('正在处理…');
  const dirty = draft.name !== baseline.name || draft.html !== baseline.html;
  useEffect(() => {
    mounted.current = true;
    request('/api/description-templates').then((items) => { if (mounted.current) { setTemplates(items); choose(items[0] || EMPTY); } })
      .catch((e) => { if (mounted.current) setError(e.message); }).finally(() => { if (mounted.current) setBusy(false); });
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => { onGuardChange({ busy, dirty }); }, [busy, dirty, onGuardChange]);
  function choose(template) { setDraft({ ...template }); setBaseline({ ...template }); setPreview(null); setItem(null); setFailures([]); appliedIds.current.clear(); setError(''); }
  function update(patch) { setDraft((old) => ({ ...old, ...patch })); setPreview(null); setItem(null); setFailures([]); appliedIds.current.clear(); }
  function maySwitch() { return !dirty || window.confirm('模板有未保存的修改，确认放弃这些修改？'); }
  async function run(work) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try { await work(); } catch (e) { if (mounted.current) { setError(e.message); notify(e.message, 'error'); } }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  async function save() {
    await run(async () => {
      const saved = await request('/api/description-templates', draft);
      setTemplates((old) => [...old.filter((t) => t.id !== saved.id), saved]); choose(saved);
      notify('模板已保存，可反复选择使用；尚未修改商品');
    });
  }
  async function remove() {
    if (!window.confirm('确认删除模板“' + draft.name + '”？已应用到商品的详情会保留。')) return;
    await run(async () => {
      await request('/api/description-templates/' + draft.id, { version: baseline.version }, 'DELETE');
      const remaining = templates.filter((t) => t.id !== draft.id); setTemplates(remaining); choose(remaining[0] || EMPTY); notify('模板已删除');
    });
  }
  async function upload(event) {
    const files = [...event.target.files]; event.target.value = '';
    if (!files.length) return;
    await run(async () => {
      if (files.some((f) => f.size > 5 * 1024 * 1024 || !['image/jpeg', 'image/png', 'image/webp'].includes(f.type))) throw new Error('请选择不超过 5 MB 的 JPG、PNG 或 WebP 图片');
      const urls = [];
      for (const file of files) {
        const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('图片读取失败')); reader.readAsDataURL(file); });
        urls.push((await request('/api/media/upload-image', { data })).url);
      }
      update({ html: draft.html + urls.map((url) => '<p><img src="' + url + '" alt="" style="max-width:100%;height:auto"></p>').join('') });
    });
  }
  const applyBody = () => ({ templateId: baseline.id, version: baseline.version, mode });
  async function loadDetail(summary) {
    setItem(null);
    if (!summary) return;
    const result = await request('/api/description-templates/preview', { ...applyBody(), ids: [summary.id] });
    if (result.items[0].revision !== summary.revision) throw new Error('商品详情已变化，请重新预览批量应用');
    if (mounted.current) setItem(result.items[0]);
  }
  async function showPreview() {
    await run(async () => {
      const ids = products.filter((p) => !appliedIds.current.has(p.id)).map((p) => p.id);
      const items = [], failed = []; let completed = 0;
      for (const batch of chunks(ids)) {
        try {
          const result = await request('/api/description-templates/preview', { ...applyBody(), ids: batch, summary: true, partial: true });
          items.push(...result.items); failed.push(...result.failures);
        } catch (error) { failed.push(...batch.map((id) => ({ id, title: products.find((p) => p.id === id)?.title, error: error.message }))); }
        completed += batch.length;
        if (!mounted.current) return;
        setMessage(`生成详情预览 ${completed}/${ids.length}`);
      }
      setPreview({ items, failures: failed }); setFailures(failed);
      await loadDetail(items[0]);
    });
  }
  async function apply() {
    if (!preview || dirty) return;
    await run(async () => {
      const failed = [...preview.failures]; let updated = 0, completed = 0;
      for (const batch of chunks(preview.items)) {
        try {
          const result = await request('/api/description-templates/apply', { ...applyBody(), ids: batch.map((p) => p.id), partial: true, revisions: Object.fromEntries(batch.map((p) => [p.id, p.revision])) });
          result.saved.forEach((id) => appliedIds.current.add(id));
          updated += result.updated; failed.push(...result.failures);
        } catch (error) { failed.push(...batch.map((p) => ({ id: p.id, title: p.title, error: error.message }))); }
        completed += batch.length;
        if (!mounted.current) return;
        setMessage(`应用详情 ${completed}/${preview.items.length}，已更新 ${updated} 件`);
      }
      setFailures(failed); setPreview(null); setItem(null);
      notify(`本次已更新 ${updated} 件商品${failed.length ? `，${failed.length} 件未完成，可修正后重新预览，仅处理剩余商品` : ''}`);
      if (!failed.length) onSaved();
    });
  }
  return <section className="batch-description-editor" aria-label="商品详情模板">
    <div className="bde-heading"><h3>我的详情模板</h3><span>{templates.length} / 50 套</span></div>
    <p className="bde-help">维护多套公司介绍、服务说明与图文排版；保存后可反复使用。修改模板后，需要重新应用才会更新商品。</p>
    {error && <p className="bde-error" role="alert">{error}</p>}
    {busy && <p role="status">{message}</p>}
    <BatchFailures items={failures} busy={busy} />
    <fieldset disabled={busy}>
      <div className="bde-toolbar"><select aria-label="选择详情模板" value={draft.id} onChange={(e) => { if (maySwitch()) choose(templates.find((t) => t.id === e.target.value) || EMPTY); }}><option value="">新模板（未保存）</option>{templates.map((t) => <option value={t.id} key={t.id}>{t.name}</option>)}</select>
        <button type="button" disabled={templates.length >= 50} onClick={() => { if (maySwitch()) { choose(EMPTY); update({ name: '新详情模板', html: STARTER }); } }}>新建模板</button>
        <button type="button" disabled={!draft.html || templates.length >= 50} onClick={() => { const copy = { ...EMPTY, name: ((draft.name || '详情模板') + ' - 副本').slice(0, 80), html: draft.html }; choose(EMPTY); setDraft(copy); }}>复制为新模板</button>
        <button type="button" disabled={!draft.id} onClick={remove}>删除模板</button>
      </div>
      <label className="bde-field">模板名称<input aria-label="模板名称" maxLength={80} placeholder="例如：公司通用版、电子产品版、服装版" value={draft.name} onChange={(e) => update({ name: e.target.value })} /></label>
      <div className="bde-toolbar"><span>在末尾插入：</span>{TOKENS.map(([key, label]) => <button type="button" key={key} onClick={() => update({ html: draft.html + '<p>{{' + key + '}}</p>' })}>{label}</button>)}<label className="bde-file">上传公司图片<input aria-label="上传模板图片" type="file" multiple accept="image/jpeg,image/png,image/webp" onChange={upload} /></label></div>
      <p className="bde-help">变量会替换为每件商品自己的内容。“商品详情图”保留产品图片；原详情文字不会随图片带入。可通过 HTML 源码编辑表格与排版。</p>
      <div className={busy ? 'bde-editor-busy' : ''} inert={busy ? true : undefined}><DescriptionEditor html={draft.html} onChange={(html) => update({ html })} /></div>
      <div className="bde-toolbar bde-save"><button type="button" className="primary-button" disabled={!draft.name.trim() || !draft.html.trim() || !dirty} onClick={save}>保存模板</button><button type="button" disabled={!dirty} onClick={() => choose(baseline)}>放弃未保存修改</button><span>{dirty ? '模板尚未保存' : draft.id ? '模板已保存' : '新建模板后开始编辑'}</span></div>
      <div className="bde-apply"><h3>批量应用到 {products.length} 件商品</h3><p className="bde-help">自动分批处理，单件失败不会影响其他商品。已成功应用 {appliedIds.current.size} 件。</p><label className="bde-field">应用方式<select aria-label="模板应用方式" value={mode} onChange={(e) => { setMode(e.target.value); setPreview(null); setItem(null); setFailures([]); appliedIds.current.clear(); }}><option value="replace">替换整个详情（只保留模板内容和变量）</option><option value="prepend">放在原详情前面</option><option value="append">放在原详情后面</option></select></label><p className="bde-help">替换会覆盖现有详情文字及图片；请逐件预览。前置/追加会保留原详情，重新应用时更新上次插入的模板部分。</p><button type="button" disabled={!draft.id || dirty} onClick={showPreview}>预览批量应用</button>{dirty && <span className="bde-help"> 请先保存模板</span>}</div>
      {item && <div className="bde-preview"><label className="bde-field">预览商品<select aria-label="模板预览商品" value={item.id} onChange={(e) => run(() => loadDetail(preview.items.find((p) => p.id === e.target.value)))}>{preview.items.map((p, i) => <option key={p.id} value={p.id}>{i + 1}. {p.title || p.id}</option>)}</select></label><div className="bde-comparison"><div><strong>修改前</strong><iframe title="模板应用前" sandbox="" srcDoc={previewDocument(item.beforeHtml)} /></div><div><strong>修改后 · {item.patch.detailImages.length} 张详情图</strong><iframe title="模板应用后" sandbox="" srcDoc={previewDocument(item.patch.descriptionHtml)} /></div></div><button type="button" className="primary-button" onClick={apply}>确认应用到 {preview.items.length} 件商品</button></div>}
    </fieldset>
  </section>;
}
