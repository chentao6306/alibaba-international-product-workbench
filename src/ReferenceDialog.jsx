import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { SOURCE_PLATFORMS } from '../server/source-platform.js';
import { referenceRequest as request } from './reference-request.js';

const labels = { categoryId: '类目 ID', categoryPath: '类目路径', attributes: '商品属性', customAttributes: '自定义属性',
  variantGroups: '规格', skus: 'SKU', model: '型号', brand: '品牌', material: '材质', origin: '产地', province: '省份',
  productType: '类型', packaging: '包装', deliveryTime: '交期', privateMold: '私模', requiredAttributes: '必填属性' };
const show = (value) => value == null ? '未填写' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
const PAGE_SIZE = 30;

function ReferencePreviewItem({ item, single }) {
  const [expanded, setExpanded] = useState(single);
  return <details open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}><summary>{item.title} · {item.skipped || `${item.changes.length} 项变化`}</summary>
    {expanded && <>
      {item.failure?.message && <p className="reference-error">原失败原因：{item.failure.message}</p>}
      {item.categoryChanged && <p className="reference-error">将更换商品类目，请核对新类目与商品是否相符。</p>}
      {item.changes.map((change) => <div className="reference-diff" key={change.field}><strong>{labels[change.field] || change.field}</strong><div><span>修改前</span><pre>{show(change.before)}</pre></div><div><span>修改后</span><pre>{show(change.after)}</pre></div></div>)}
    </>}
  </details>;
}

export default function ReferenceDialog({ products, onClose, onSaved, notify, editorDraft, onApplyDraft, initialScope = 'full' }) {
  const [references, setReferences] = useState([]);
  const [referenceId, setReferenceId] = useState('');
  const [query, setQuery] = useState('');
  const [platform, setPlatform] = useState('all');
  const [options, setOptions] = useState({ scope: initialScope, preserveSkuStock: true, includeLogistics: false });
  const [previewState, setPreview] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const operation = useRef(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    let active = true;
    const controller = new AbortController();
    request('/api/references', undefined, { signal: controller.signal }).then(({ references }) => {
      if (active) { setReferences(references); setReferenceId(references[0]?.id || ''); }
    }).catch((error) => { if (active) { setError(error.message); notify(error.message, 'error'); } }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; mounted.current = false; controller.abort(); operation.current?.abort(); };
  }, []);
  const reference = references.find((item) => item.id === referenceId);
  const template = reference?.template;
  const candidates = references.filter((item) => (platform === 'all' || item.sourcePlatform === platform)
    && (item.id === referenceId || [item.title, item.categoryId, (item.categoryPath || []).join(' '), item.template?.model].join(' ').toLowerCase().includes(query.toLowerCase())));
  const body = { ids: products.map((item) => item.id), referenceId, options, ...(editorDraft ? { editorDraft } : {}) };
  // Polling replaces product objects; preview identity follows selected IDs and
  // deliberate edits, never those transient object references.
  const inputKey = JSON.stringify(body);
  const currentInput = useRef(inputKey);
  currentInput.current = inputKey;
  const preview = previewState?.inputKey === inputKey ? previewState : null;
  const totalChanged = preview?.totalChanged ?? preview?.items.filter((item) => !item.skipped).length ?? 0;
  const total = preview?.total ?? preview?.items.length ?? 0;
  const pageNumber = preview?.page || 1;
  const pageSize = preview?.pageSize || PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  function changeOptions(patch) { setOptions((value) => ({ ...value, ...patch })); setPreview(null); setError(''); }
  async function run(action, stage) {
    if (operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(stage); setError('');
    try { await action(controller.signal); }
    catch (error) { if (mounted.current) { setPreview(null); setError(error.message); notify(error.message, 'error'); } }
    finally { if (operation.current === controller) operation.current = null; if (mounted.current) setBusy(''); }
  }
  async function loadPreview(page = 1, expectedToken) {
    await run(async (signal) => {
      const data = await request('/api/products/reference/preview', { ...body, page, pageSize: PAGE_SIZE }, { signal });
      if (!mounted.current) return;
      if (currentInput.current !== inputKey) throw new Error('所选商品或引用选项已变化，请重新预览后保存。');
      if (expectedToken && data.token !== expectedToken) throw new Error('商品或引用内容已变化，请重新预览后保存。');
      if (!data.token || !Array.isArray(data.items)) throw new Error('未收到完整的引用预览，请重新预览后保存。');
      setPreview({ ...data, inputKey, body });
    }, 'preview');
  }
  async function capture() {
    await run(async (signal) => {
      const { reference } = await request('/api/references/capture-current', {}, { signal });
      const { references } = await request('/api/references', undefined, { signal });
      if (!mounted.current) return;
      setReferences(references); setPlatform('all'); setReferenceId(reference.id); setPreview(null);
      notify('已读取当前卖家商品的类目、属性和规格，请检查后预览');
    }, 'capture');
  }
  async function save() {
    if (!preview || !totalChanged) return;
    await run(async (signal) => {
      const savedBody = { ...preview.body, previewToken: preview.token };
      if (onApplyDraft) await onApplyDraft({ patch: preview.items[0].patch, review: savedBody });
      else await onSaved(await request('/api/products/reference', savedBody, { signal }));
    }, 'save');
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
    {preview && <section className="reference-preview" aria-label="引用修改预览"><h3>修改预览 · {totalChanged} 件将更新</h3>
      <p className="batch-help">共核对 {total} 件，跳过 {total - totalChanged} 件。保存将应用到全部 {totalChanged} 件待更新商品。</p>
      {preview.items.map((item) => <ReferencePreviewItem key={`${preview.token}:${item.id}`} item={item} single={total === 1} />)}
      {pageCount > 1 && <div className="batch-actions"><button type="button" className="secondary-button" aria-label="上一页预览" disabled={Boolean(busy) || pageNumber <= 1} onClick={() => loadPreview(pageNumber - 1, preview.token)}>上一页</button><span>第 {pageNumber} / {pageCount} 页 · 每页 {pageSize} 件</span><button type="button" className="secondary-button" aria-label="下一页预览" disabled={Boolean(busy) || pageNumber >= pageCount} onClick={() => loadPreview(pageNumber + 1, preview.token)}>下一页</button></div>}
    </section>}
    <div className="drawer-actions">
      {error && <div className="reference-error" role="alert" style={{ flexBasis: '100%' }}>{error}</div>}
      {busy && <p role="status" style={{ flexBasis: '100%', margin: 0 }}>{busy === 'preview' ? `正在核对 ${products.length} 件商品并读取预览，请稍候…` : busy === 'save' ? '正在保存已预览的修改，请勿重复提交…' : '正在读取当前卖家商品…'}</p>}
      <button className="secondary-button" disabled={Boolean(busy)} onClick={onClose}>取消</button><button className="secondary-button" disabled={Boolean(busy) || !referenceId} onClick={() => loadPreview()}>预览修改</button><button className="primary-button" disabled={Boolean(busy) || !totalChanged} onClick={save}>{onApplyDraft ? '应用到编辑窗口' : '引用并保存'}</button>
    </div>
    </div>
  </aside></div>;
}
