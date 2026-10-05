import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { SOURCE_PLATFORMS } from '../server/source-platform.js';

const labels = { categoryId: '类目 ID', categoryPath: '类目路径', attributes: '商品属性', customAttributes: '自定义属性',
  variantGroups: '规格', skus: 'SKU', model: '型号', brand: '品牌', material: '材质', origin: '产地', province: '省份',
  productType: '类型', packaging: '包装', deliveryTime: '交期', privateMold: '私模', requiredAttributes: '必填属性' };
const show = (value) => value == null ? '未填写' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
async function request(url, body) {
  const response = await fetch(url, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || data.message || '请求失败');
  return data;
}

export default function ReferenceDialog({ products, onClose, onSaved, notify, editorDraft, onApplyDraft, initialScope = 'full' }) {
  const [references, setReferences] = useState([]);
  const [referenceId, setReferenceId] = useState('');
  const [query, setQuery] = useState('');
  const [platform, setPlatform] = useState('all');
  const [options, setOptions] = useState({ scope: initialScope, preserveSkuStock: true, includeLogistics: false });
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    request('/api/references').then(({ references }) => {
      if (active) { setReferences(references); setReferenceId(references[0]?.id || ''); }
    }).catch((error) => notify(error.message, 'error')).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  const reference = references.find((item) => item.id === referenceId);
  const template = reference?.template;
  const candidates = references.filter((item) => (platform === 'all' || item.sourcePlatform === platform)
    && (item.id === referenceId || [item.title, item.categoryId, (item.categoryPath || []).join(' '), item.template?.model].join(' ').toLowerCase().includes(query.toLowerCase())));
  const body = { ids: products.map((item) => item.id), referenceId, options, ...(editorDraft ? { editorDraft } : {}) };
  function changeOptions(patch) { setOptions((value) => ({ ...value, ...patch })); setPreview(null); }
  async function run(action) {
    setBusy(true);
    try { await action(); } catch (error) { setPreview(null); notify(error.message, 'error'); }
    finally { setBusy(false); }
  }
  async function capture() {
    await run(async () => {
      const { reference } = await request('/api/references/capture-current', {});
      const { references } = await request('/api/references');
      setReferences(references); setPlatform('all'); setReferenceId(reference.id); setPreview(null);
      notify('已读取当前卖家商品的类目、属性和规格，请检查后预览');
    });
  }
  return <div className="drawer-backdrop"><aside className="drawer batch-drawer reference-drawer" role="dialog" aria-label="引用商品资料" aria-modal="true">
    <div className="drawer-header"><div><h2>引用商品资料</h2><p>选择引用范围，检查新旧值后批量保存 · {products.length} 件</p></div><button className="icon-button" disabled={busy} onClick={onClose} aria-label="关闭引用"><X /></button></div>
    <div className="reference-content">
    <label className="batch-field"><span>引用来源平台</span><select aria-label="引用来源平台" value={platform} disabled={busy} onChange={(event) => { setPlatform(event.target.value); setReferenceId(''); setPreview(null); }}><option value="all">全部平台的国际站上架成功商品</option>{SOURCE_PLATFORMS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
    <label className="batch-field"><span>搜索引用商品</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="商品名称、型号或类目" /></label>
    <label className="batch-field"><span>选择引用商品</span><select aria-label="选择引用商品" disabled={loading || busy} value={referenceId} onChange={(event) => { setReferenceId(event.target.value); setPreview(null); }}><option value="">{loading ? '读取中…' : '请选择引用商品'}</option>{candidates.map((item) => <option key={item.id} value={item.id}>{item.title || item.id} · {item.sourcePlatformLabel} · {item.source === 'seller' ? '卖家模板' : '成功记录'} · {item.categoryId}</option>)}</select></label>
    <div className="reference-capture"><p>也可在卖家窗口打开已有商品的编辑表单，再读取为本地模板。</p><button className="secondary-button" disabled={busy} onClick={capture}>读取当前卖家商品</button></div>
    {template && <div className="reference-summary"><div><strong>引用类目</strong><small>{(template.categoryPath || []).join(' > ')} · {template.categoryId}</small></div><div><strong>商品属性 · {(template.attributes || []).length} 项</strong><small>{(template.attributes || []).map((item) => `${item.name}：${[].concat(item.value ?? []).join('、')}`).join('；') || '未读取到属性'}</small></div><div><strong>规格与 SKU · {(template.skus || []).length} 行</strong><small>{(template.variantGroups || []).map((group) => `${group.name}：${group.options.join('、')}`).join('；') || '未设置规格'}</small></div></div>}
    <label className="batch-field"><span>引用范围</span><select aria-label="引用范围" disabled={busy} value={options.scope} onChange={(event) => changeOptions({ scope: event.target.value })}>
      <option value="full">完整类目模板（类目、属性、规格）</option><option value="attributes">仅商品属性（同类目）</option><option value="specifications">仅规格与 SKU（同类目）</option><option value="failed-fields">仅报错的必填属性（同类目）</option>
    </select></label>
    <div className="reference-options"><label><input type="checkbox" checked={options.preserveSkuStock} disabled={busy || !['full', 'specifications'].includes(options.scope)} onChange={(event) => changeOptions({ preserveSkuStock: event.target.checked })} />保留本商品库存、编码与启用状态</label><label><input type="checkbox" checked={options.includeLogistics} disabled={busy || !['full', 'attributes'].includes(options.scope)} onChange={(event) => changeOptions({ includeLogistics: event.target.checked })} />同时补充缺失的包装、交期和物流资料</label></div>
    <p className="batch-help">规格引用可能改变型号和 SKU 组合；价格、标题和详情仍使用本商品资料。未匹配的 SKU 使用本商品总库存，编码留空。</p>
    {preview && <section className="reference-preview" aria-label="引用修改预览"><h3>修改预览 · {preview.items.filter((item) => !item.skipped).length} 件将更新</h3>{preview.items.map((item) => <details key={item.id} open={preview.items.length === 1}><summary>{item.title} · {item.skipped || `${item.changes.length} 项变化`}</summary>
      {item.failure?.message && <p className="reference-error">原失败原因：{item.failure.message}</p>}
      {item.categoryChanged && <p className="reference-error">将更换商品类目，请核对新类目与商品是否相符。</p>}
      {item.changes.map((change) => <div className="reference-diff" key={change.field}><strong>{labels[change.field] || change.field}</strong><div><span>修改前</span><pre>{show(change.before)}</pre></div><div><span>修改后</span><pre>{show(change.after)}</pre></div></div>)}
    </details>)}</section>}
    <div className="drawer-actions"><button className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button className="secondary-button" disabled={busy || !referenceId} onClick={() => run(async () => setPreview(await request('/api/products/reference/preview', body)))}>预览修改</button><button className="primary-button" disabled={busy || !preview?.items.some((item) => !item.skipped)} onClick={() => run(async () => onApplyDraft ? onApplyDraft({ patch: preview.items[0].patch, review: { ...body, previewToken: preview.token } }) : onSaved(await request('/api/products/reference', { ...body, previewToken: preview.token })))}>{onApplyDraft ? '应用到编辑窗口' : '引用并保存'}</button></div>
    </div>
  </aside></div>;
}
