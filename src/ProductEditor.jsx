import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowUp, Bold, Code, ExternalLink, ImagePlus, Italic, Link, List, LoaderCircle, Maximize2, Minimize2, Plus, Save, Trash2, Undo2, X } from 'lucide-react';
import ReferenceDialog from './ReferenceDialog.jsx';
import OriginCountrySelect from './OriginCountrySelect.jsx';
import { attributeKey, changeEditorCategory, createEditorForm, editAttribute, editorAttributeRows, editorPayload, labelOf, rebuildEditorSkus, updateDeliveryCell, valuesOf } from './product-editor-model.js';
import './ProductEditor.css';

const TABS = [['basic', '基础信息'], ['attributes', '商品属性'], ['custom', '自定义属性'], ['specs', '产品规格'], ['trade', '交易信息'], ['logistics', '物流信息'], ['service', '商品服务与证书'], ['description', '商品描述'], ['regional', '国家/地区差异设置']];
const MATERIALS = ['ABS', 'Aluminum', 'Aluminum Alloy', 'Carbon Fiber', 'Composite', 'EVA', 'Glass', 'Iron', 'Leather', 'lipo', 'Metal', 'Nylon', 'Optical Glass', 'Oxford cloth', 'PC', 'Plastic', 'PU', 'PVC', 'Resin', 'Rubber', 'Silicone', 'Stainless Steel', 'Wood', 'Wooden', 'Other'];
const BRANDS = ['Autel', 'DJI', 'Holy Stone', 'HUBSAN', 'Others', 'Parrot', 'Skydio', 'Yuneec', 'Other'];
const SERVICE_FIELDS = [['sample', '样品服务'], ['afterSales', '售后服务'], ['localShowroom', '样品间服务'], ['productionVisualization', '生产可视化服务'], ['ecommerce', '电商一站式服务'], ['dropshipping', '一件代发服务'], ['remoteWarranty', '一年远程质保服务']];
const textValue = (value) => valuesOf(value).join(', ');

async function request(url, body, method = 'POST') {
  const response = await fetch(url, { method: body === undefined ? 'GET' : method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || data.message || '请求失败');
  return data;
}
function IconButton({ title, children, ...props }) { return <button type="button" className="pe-icon" title={title} aria-label={title} {...props}>{children}</button>; }
function Row({ label, required, children, wide = false }) { return <div className={`pe-row${wide ? ' pe-wide' : ''}`}><div className="pe-label">{required && <b>* </b>}{label}：</div><div className="pe-control">{children}</div></div>; }
function Input({ label, value, onChange, ...props }) { return <input aria-label={label} value={value ?? ''} onChange={(event) => onChange(event.target.value)} {...props} />; }
function Choice({ label, value, options, onChange }) { return <select aria-label={label} value={value ?? ''} onChange={(event) => onChange(event.target.value)}><option value="">请选择</option>{[...new Set([...(value ? [String(value)] : []), ...options])].map((option) => <option key={option}>{option}</option>)}</select>; }
function CheckOptions({ label, options, value, onChange }) {
  const selected = valuesOf(value);
  return <div className="pe-checks" role="group" aria-label={label}>{[...new Set([...options, ...selected])].map((option) => <label key={option} title={option}><input type="checkbox" checked={selected.includes(option)} onChange={(event) => onChange(event.target.checked ? [...selected, option] : selected.filter((item) => item !== option))} /><span>{option}</span></label>)}</div>;
}

function MediaPicker({ label, images, sourceImages = [], onChange, notify, max = 30 }) {
  const [selected, setSelected] = useState([]);
  const [url, setUrl] = useState('');
  const [showUrl, setShowUrl] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => setSelected([]), [images.length]);
  async function upload(event) {
    const files = [...event.target.files]; event.target.value = ''; setBusy(true);
    try {
      const urls = [];
      for (const file of files) {
        if (file.size > 5 * 1024 * 1024) throw new Error(`${file.name} 超过 5 MB`);
        const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
        urls.push((await request('/api/media/upload', { name: file.name, data })).url);
      }
      onChange([...images, ...urls].slice(0, max));
    } catch (error) { notify(error.message, 'error'); } finally { setBusy(false); }
  }
  function move(index, delta) { const next = [...images]; [next[index], next[index + delta]] = [next[index + delta], next[index]]; onChange(next); setSelected([]); }
  return <div className="pe-media" aria-label={label}>
    <div className="pe-toolbar"><label className="pe-file"><ImagePlus size={16} />本地电脑图片<input type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={busy || images.length >= max} onChange={upload} /></label><button type="button" disabled={!sourceImages.length} onClick={() => onChange([...sourceImages].slice(0, max))}><Undo2 size={16} />恢复来源图片</button><button type="button" disabled={!selected.length} onClick={() => { onChange(images.filter((_, index) => !selected.includes(index))); setSelected([]); }}><Trash2 size={16} />删除选中图片</button><IconButton title="添加图片地址" disabled={images.length >= max} onClick={() => setShowUrl(!showUrl)}><Link size={16} /></IconButton>{busy && <LoaderCircle className="spin" size={18} />}</div>
    {showUrl && <div className="pe-inline"><Input label={`${label}地址`} value={url} onChange={setUrl} placeholder="https://" /><button type="button" disabled={!/^https?:\/\//i.test(url)} onClick={() => { onChange([...images, url.trim()].slice(0, max)); setUrl(''); setShowUrl(false); }}>添加</button></div>}
    <div className="pe-thumbnails">{images.map((image, index) => <div className="pe-thumbnail" key={`${index}-${image}`}><label><input type="checkbox" aria-label={`选择${label}${index + 1}`} checked={selected.includes(index)} onChange={(event) => setSelected(event.target.checked ? [...selected, index] : selected.filter((item) => item !== index))} /><img src={image} alt={`${label} ${index + 1}`} /><span>{index + 1}.jpg</span></label><div><IconButton title={`前移${label}${index + 1}`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={14} /></IconButton><IconButton title={`后移${label}${index + 1}`} disabled={index === images.length - 1} onClick={() => move(index, 1)}><ArrowDown size={14} /></IconButton></div></div>)}</div>
  </div>;
}

function safeEditorHtml(html) {
  const document = new DOMParser().parseFromString(html || '', 'text/html');
  document.querySelectorAll('script,iframe,object,embed,link,meta,style,base,form').forEach((node) => node.remove());
  document.querySelectorAll('*').forEach((node) => [...node.attributes].forEach((attr) => {
    if (/^on/i.test(attr.name) || /^(href|src|action|xlink:href)$/i.test(attr.name) && /^\s*(javascript|vbscript|data:text\/html):/i.test(attr.value)) node.removeAttribute(attr.name);
  }));
  return document.body.innerHTML;
}
export function DescriptionEditor({ html, onChange }) {
  const ref = useRef(null);
  const [source, setSource] = useState(false);
  useEffect(() => { if (ref.current && ref.current.innerHTML !== safeEditorHtml(html)) ref.current.innerHTML = safeEditorHtml(html); }, [html, source]);
  function command(name) { ref.current?.focus(); document.execCommand(name); onChange(ref.current.innerHTML); }
  return <div className="pe-description"><div className="pe-toolbar"><IconButton title="粗体" disabled={source} onClick={() => command('bold')}><Bold size={17} /></IconButton><IconButton title="斜体" disabled={source} onClick={() => command('italic')}><Italic size={17} /></IconButton><IconButton title="项目列表" disabled={source} onClick={() => command('insertUnorderedList')}><List size={17} /></IconButton><IconButton title="撤销" disabled={source} onClick={() => command('undo')}><Undo2 size={17} /></IconButton><IconButton title="HTML 源码" aria-pressed={source} onClick={() => setSource(!source)}><Code size={17} /></IconButton></div>{source ? <textarea aria-label="详情 HTML" rows={16} value={html} onChange={(event) => onChange(event.target.value)} /> : <div ref={ref} className="pe-richtext" contentEditable suppressContentEditableWarning role="textbox" aria-label="商品详情编辑" aria-multiline="true" onInput={() => onChange(ref.current.innerHTML)} onPaste={(event) => { event.preventDefault(); document.execCommand('insertHTML', false, safeEditorHtml(event.clipboardData.getData('text/html') || event.clipboardData.getData('text/plain').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]))); onChange(ref.current.innerHTML); }} />}</div>;
}

export default function ProductEditor({ product, onClose, onSaved, notify, CategorySelect }) {
  const [form, setForm] = useState(() => createEditorForm(product));
  const [tab, setTab] = useState('basic');
  const [saving, setSaving] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [referenceScope, setReferenceScope] = useState('');
  const [referenceReview, setReferenceReview] = useState(null);
  const [referenceDraft, setReferenceDraft] = useState(null);
  const [auditOpen, setAuditOpen] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [groupsDirty, setGroupsDirty] = useState(false);
  const [sellerGroups, setSellerGroups] = useState([]);
  const [loadingGroups, setLoadingGroups] = useState(false);
  const [uploadingVideo, setUploadingVideo] = useState('');
  const [newAttribute, setNewAttribute] = useState('');
  const [newGroup, setNewGroup] = useState('');
  const [usdRate, setUsdRate] = useState('');
  const dialogRef = useRef(null);
  const change = (key, value) => { setDirty(true); setForm((current) => ({ ...current, [key]: value })); };
  const updateItem = (key, index, value) => change(key, form[key].map((item, itemIndex) => itemIndex === index ? value : item));
  const updateAttribute = (index, value, fallback) => { setDirty(true); setForm((current) => editAttribute(current, index, { ...(current.attributes[index] || fallback), value })); };
  const close = () => dirty ? setDiscard(true) : onClose();
  useEffect(() => {
    const previousOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    const previousFocus = document.activeElement; dialogRef.current?.focus();
    return () => { document.body.style.overflow = previousOverflow; previousFocus?.focus?.(); };
  }, []);
  function trapFocus(event) {
    if (referenceScope || discard) return;
    if (event.key === 'Escape') { event.stopPropagation(); close(); }
    if (event.key !== 'Tab') return;
    const controls = [...dialogRef.current.querySelectorAll('button,a,input,select,textarea,[tabindex="0"]')].filter((node) => !node.disabled && node.getClientRects().length);
    if (event.shiftKey && document.activeElement === controls[0]) { controls.at(-1)?.focus(); event.preventDefault(); }
    if (!event.shiftKey && document.activeElement === controls.at(-1)) { controls[0]?.focus(); event.preventDefault(); }
  }
  async function save(event) {
    event.preventDefault();
    const invalid = [...event.currentTarget.elements].find((control) => control.willValidate && !control.checkValidity());
    if (invalid) {
      setTab(invalid.closest('[data-editor-tab]')?.dataset.editorTab || tab);
      notify(`请检查${invalid.getAttribute('aria-label') || '表单字段'}`, 'error');
      setTimeout(() => { invalid.focus(); invalid.reportValidity(); }, 0); return;
    }
    setSaving(true);
    try {
      const next = groupsDirty ? rebuildEditorSkus(form) : form;
      await request(`/api/products/${product.id}`, { ...editorPayload(next), ...(usdRate ? { usdRate: Number(usdRate) } : {}), ...(referenceReview ? { referenceReview } : {}) }, 'PATCH');
      await onSaved();
    } catch (error) { notify(error.message, 'error'); } finally { setSaving(false); }
  }
  function openReference(scope) {
    try { setReferenceDraft(editorPayload(groupsDirty ? rebuildEditorSkus(form) : form)); setReferenceScope(scope); }
    catch (error) { notify(error.message, 'error'); }
  }
  async function loadGroups() {
    setLoadingGroups(true);
    try { setSellerGroups((await request(`/api/seller/product-groups?categoryId=${encodeURIComponent(form.categoryId)}`)).groups); }
    catch (error) { notify(error.message, 'error'); } finally { setLoadingGroups(false); }
  }
  function changeGroup(index, value) { updateItem('variantGroups', index, value); setGroupsDirty(true); }
  function buildSkus() {
    try { setForm(rebuildEditorSkus(form)); setDirty(true); setGroupsDirty(false); }
    catch (error) { notify(error.message, 'error'); }
  }
  function setVideo(role, url) {
    const current = form.videos.find((item) => item.role === role);
    change('videos', [...form.videos.filter((item) => item.role !== role), ...(url ? [{ ...current, role, url }] : [])]);
  }
  async function uploadVideo(event, role) {
    const file = event.target.files[0]; event.target.value = '';
    if (!file) return;
    if (file.size > 100 * 1024 * 1024) return notify('视频超过 100 MB', 'error');
    setUploadingVideo(role);
    try {
      const response = await fetch('/api/media/video', { method: 'POST', headers: { 'content-type': 'video/mp4' }, body: file });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '视频上传失败');
      setVideo(role, result.url);
    } catch (error) { notify(error.message, 'error'); } finally { setUploadingVideo(''); }
  }
  const requirements = product.postingRequirements?.categoryId === form.categoryId ? product.postingRequirements.fields || [] : [];
  const source = product.source?.snapshot || {};
  const selectedGroup = form.sellerGroup;
  const allGroups = selectedGroup && !sellerGroups.some((group) => group.id === selectedGroup.id) ? [selectedGroup, ...sellerGroups] : sellerGroups;
  const service = (key, value) => change('services', { ...form.services, [key]: value });
  const patchObject = (key, field, value) => change(key, { ...form[key], [field]: value });
  const regionalRows = form.regionalPricing.rows || (form.regionalPricing.country ? [{ country: form.regionalPricing.country, value: form.regionalPricing.price ?? '' }] : []);
  const setRegionalRows = (rows) => change('regionalPricing', { ...form.regionalPricing, country: '', price: '', rows });
  const pane = (id) => ({ className: `pe-pane pe-${id}`, hidden: tab !== id, 'data-editor-tab': id, role: 'tabpanel', id: `pe-panel-${id}`, 'aria-labelledby': `pe-tab-${id}` });
  return <div className="pe-backdrop"><section ref={dialogRef} tabIndex={-1} className={`pe-window${maximized ? ' pe-maximized' : ''}`} role="dialog" aria-modal="true" aria-label="编辑产品" onKeyDown={trapFocus}>
    <div className="pe-titlebar"><span>编辑产品</span><div><IconButton title={maximized ? '还原窗口' : '最大化窗口'} onClick={() => setMaximized(!maximized)}>{maximized ? <Minimize2 size={17} /> : <Maximize2 size={17} />}</IconButton><IconButton title="关闭编辑" onClick={close} disabled={saving}><X size={20} /></IconButton></div></div>
    <header className="pe-heading"><div className="pe-heading-icon"><ArrowLeft size={28} /><ArrowLeft size={28} /></div><div><h2>编辑产品</h2><span>{product.sourceId || '商品资料'}</span></div><button type="button" className="pe-link" onClick={() => setAuditOpen(!auditOpen)}>来源与修改记录</button></header>
    <form onSubmit={save} noValidate>
      <div className="pe-tabs" role="tablist" aria-label="商品编辑页签">{TABS.map(([value, label], index) => <button type="button" role="tab" id={`pe-tab-${value}`} aria-controls={`pe-panel-${value}`} aria-selected={tab === value} tabIndex={tab === value ? 0 : -1} key={value} onClick={() => setTab(value)} onKeyDown={(event) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length; setTab(TABS[next][0]); document.getElementById(`pe-tab-${TABS[next][0]}`)?.focus(); } }}>{label}</button>)}</div>
      <div className="pe-scroll">
      {auditOpen && <section className="pe-audit"><button type="button" onClick={() => setAuditOpen(false)}>返回编辑</button><p>采集时间：{product.source?.capturedAt || '未记录'}　修改次数：{product.auditTrail?.length || 0}</p><p>上次发布：{product.publishResult?.message || product.referenceRecovery?.failure?.message || '无失败记录'}</p>{(product.quality?.issues || []).map((item) => <p key={item.code}>{item.message}</p>)}<details><summary>原始采集数据</summary><pre>{JSON.stringify(source, null, 2)}</pre></details></section>}
      <div {...pane('basic')}>
        <div className="pe-category"><div><span>您当前类目选择的是：</span><div className="pe-toolbar"><button type="button" onClick={() => setCategoryOpen(!categoryOpen)}>重选类目</button><button type="button" onClick={() => openReference('full')}>引用类目与属性</button></div></div>
          {product.categoryMapping?.sourcePath?.length > 0 && <div className="pe-category-path">来源类目：{product.categoryMapping.sourcePath.join(' >> ')}</div>}
          <div className="pe-category-path">国际站类目：{form.categoryPath.join(' >> ') || '未选择'}{form.categoryId && ` | ${form.categoryId}`}{product.categoryMapping?.status === 'matched' && product.categoryMapping.candidates?.[0]?.id === form.categoryId && '（根据来源类目自动匹配，请核对）'}</div>
          {!form.categoryId && product.categoryMapping && <div className="pe-category-path">来源类目尚不能唯一对应国际站末级类目，请选择候选或引用已上架的同类商品。</div>}
          {categoryOpen && <div className="pe-category-select"><CategorySelect path={form.categoryPath.join(' >> ')} categoryId={form.categoryId} suggestions={product.categoryMapping?.candidates || []} onCancel={() => setCategoryOpen(false)} onChange={(option) => { setDirty(true); setForm((current) => changeEditorCategory(current, option)); setCategoryOpen(false); }} /></div>}</div>
        <Row label="商品名称" wide required><Input label="商品名称" value={form.title} onChange={(value) => change('title', value)} required maxLength={128} /></Row>
        <Row label="副标题" wide><Input label="副标题" value={form.subtitle} onChange={(value) => change('subtitle', value)} maxLength={128} /></Row>
        <Row label="商品关键词" wide><textarea aria-label="商品关键词" rows={4} value={form.keywords.join('\n')} onChange={(event) => change('keywords', event.target.value.split('\n'))} /></Row>
        <Row label="商品分组" wide><div className="pe-inline"><select aria-label="国际站商品分组" value={selectedGroup?.id || ''} onChange={(event) => change('sellerGroup', allGroups.find((group) => group.id === event.target.value) || null)}><option value="">不指定分组</option>{allGroups.map((group) => <option key={group.id} value={group.id}>{group.path || group.name}</option>)}</select><button type="button" disabled={loadingGroups} onClick={loadGroups}>{loadingGroups ? '读取中...' : '加载商品分组列表'}</button></div></Row>
        <Row label="商品图片" wide><MediaPicker label="主图" images={form.mainImages} sourceImages={source.mainImages || source.images} max={6} onChange={(value) => change('mainImages', value)} notify={notify} /></Row>
        <Row label="商品视频" wide><div className="pe-videos">{[['main', '主图视频'], ['detail', '详情视频']].map(([role, label]) => { const video = form.videos.find((item) => item.role === role); return <fieldset key={role}><legend>{label}</legend><div className="pe-toolbar"><label className="pe-file">{uploadingVideo === role ? '上传中...' : '本地视频'}<input aria-label={`上传${label}`} type="file" accept="video/mp4" disabled={Boolean(uploadingVideo)} onChange={(event) => uploadVideo(event, role)} /></label><IconButton title={`删除${label}`} disabled={!video?.url} onClick={() => setVideo(role, '')}><Trash2 size={16} /></IconButton></div><Input label={`${label}地址`} value={video?.url} onChange={(value) => setVideo(role, value)} placeholder="https://" />{video?.url ? <video src={video.url} controls preload="metadata" /> : <div className="pe-video-empty">暂无视频</div>}</fieldset>; })}</div></Row>
      </div>
      <div {...pane('attributes')}>
        <div className="pe-right-toolbar"><button type="button" onClick={() => openReference('attributes')}>引用商品属性</button></div>
        {editorAttributeRows(form, requirements).map(({ item, index, key: rowKey, descriptor }) => {
          const key = attributeKey(item.name), label = labelOf(item.name), values = valuesOf(item.value);
          const options = (item.options?.length ? item.options : descriptor?.options || []).map((option) => typeof option === 'object' ? option.label || option.name || option.text || option.value : option).filter(Boolean);
          let control;
          if (key === attributeKey('Place of Origin')) control = <OriginCountrySelect value={textValue(item.value)} onChange={(value) => updateAttribute(index, value, item)} />;
          else if (key === attributeKey('Brand Name')) control = <div className="pe-brand"><Choice label="品牌选项" value={options.includes(textValue(item.value)) ? textValue(item.value) : values.length ? 'Other' : ''} options={[...options, 'Other']} onChange={(value) => updateAttribute(index, value, item)} /><Input label="品牌名称" value={/^others?$/i.test(textValue(item.value)) ? '' : textValue(item.value)} onChange={(value) => updateAttribute(index, value || 'Other', item)} /></div>;
          else if (key === attributeKey('Private Mold')) control = <Choice label={label} value={textValue(item.value)} options={['Yes', 'No']} onChange={(value) => updateAttribute(index, value, item)} />;
          else if (Array.isArray(item.value) || descriptor?.multiple === true || ['checkbox', 'multiSelect'].includes(descriptor?.controlType) || form.categoryId === '201346401' && [attributeKey('Material'), attributeKey('Compatible Brand')].includes(key)) {
            const defaults = form.categoryId === '201346401' ? key === attributeKey('Material') ? MATERIALS : key === attributeKey('Compatible Brand') ? BRANDS : [] : [];
            control = <MultiAttribute label={label} value={item.value} options={[...options, ...defaults]} onChange={(value) => updateAttribute(index, value, item)} />;
          } else control = options.length ? <Choice label={label} value={textValue(item.value)} options={options} onChange={(value) => updateAttribute(index, value, item)} /> : <Input label={label} value={textValue(item.value)} onChange={(value) => updateAttribute(index, value, item)} />;
          return <Row key={rowKey} label={label} required={descriptor?.required || item.required}><div className="pe-attribute-control">{control}<IconButton title={`删除属性 ${label}`} onClick={() => { updateAttribute(index, '', item); setForm((current) => ({ ...current, attributes: current.attributes.filter((_, at) => at !== index) })); }}><Trash2 size={15} /></IconButton></div></Row>;
        })}
        <Row label="新增属性"><div className="pe-inline"><Input label="新增属性名称" value={newAttribute} onChange={setNewAttribute} /><button type="button" disabled={!newAttribute.trim()} onClick={() => { change('attributes', [...form.attributes, { name: newAttribute.trim(), value: '' }]); setNewAttribute(''); }}><Plus size={16} />添加</button></div></Row>
      </div>
      <div {...pane('custom')}><div className="pe-custom-list">{Array.from({ length: Math.max(10, form.customAttributes.length) }, (_, index) => { const item = form.customAttributes[index] || { name: '', value: '' }; const update = (patch) => { const rows = [...form.customAttributes]; rows[index] = { ...item, ...patch }; change('customAttributes', Array.from(rows, (row) => row || { name: '', value: '' })); }; return <div className="pe-custom-row" key={index}><span>{index + 1}.</span><Input label={`自定义属性 ${index + 1} 名称`} placeholder="属性名称 如：Color" value={item.name} onChange={(name) => update({ name })} /><Input label={`自定义属性 ${index + 1} 值`} placeholder="属性值 如：Red" value={textValue(item.value)} onChange={(value) => update({ value })} /><IconButton title={`清除自定义属性 ${index + 1}`} onClick={() => update({ name: '', value: '' })}><Trash2 size={16} /></IconButton></div>; })}</div></div>
      <div {...pane('specs')}><div className="pe-right-toolbar"><button type="button" onClick={() => openReference('specifications')}>引用一条产品的规格信息</button></div>
        {form.variantGroups.map((group, index) => <SpecificationGroup key={index} group={group} index={index} onChange={(next) => changeGroup(index, next)} onRemove={() => { change('variantGroups', form.variantGroups.filter((_, at) => at !== index)); setGroupsDirty(true); }} />)}
        <Row label="新增规格"><div className="pe-inline"><Input label="新增规格名称" value={newGroup} onChange={setNewGroup} /><button type="button" disabled={!newGroup.trim()} onClick={() => { change('variantGroups', [...form.variantGroups, { name: newGroup.trim(), options: [], optionImages: {} }]); setNewGroup(''); setGroupsDirty(true); }}><Plus size={16} />添加</button></div></Row>
        <div className="pe-right-toolbar"><button type="button" disabled={!groupsDirty} onClick={buildSkus}>更新规格组合</button></div>
        <div className="pe-table-scroll"><table className="pe-table pe-skus"><thead><tr>{form.variantGroups.filter((group) => group.options.length).map((group, index) => <th key={index}>{labelOf(group.name)}</th>)}<th>商品编码</th><th>价格</th><th>可售数量</th><th>图片</th><th>操作</th><th>行</th></tr></thead><tbody>{form.skus.map((sku, index) => <tr key={index}>{form.variantGroups.filter((group) => group.options.length).map((group, at) => <td key={at}>{sku.attributes?.[group.name] || ''}</td>)}<td><Input label={`SKU ${index + 1} 编码`} value={sku.code} onChange={(code) => updateItem('skus', index, { ...sku, code })} /></td><td><Input label={`SKU ${index + 1} 价格`} type="number" min="0" step="any" value={sku.price} onChange={(price) => updateItem('skus', index, { ...sku, price })} /></td><td><Input label={`SKU ${index + 1} 库存`} type="number" min="0" value={sku.stock} onChange={(stock) => updateItem('skus', index, { ...sku, stock: stock === '' ? null : Number(stock) })} /></td><td>{sku.image && <img src={sku.image} alt="规格图" />}<Input label={`SKU ${index + 1} 图片`} value={sku.image} onChange={(image) => updateItem('skus', index, { ...sku, image })} /></td><td><label className="pe-checkbox"><input type="checkbox" checked={sku.enabled !== false} onChange={(event) => updateItem('skus', index, { ...sku, enabled: event.target.checked })} />启用</label></td><td>{index + 1}</td></tr>)}</tbody></table></div>
      </div>
      <div {...pane('trade')}>
        <fieldset><legend>售卖单位</legend><Row label="计量单位" required><Choice label="计量单位" value={form.salesUnit} options={['Piece', 'Set', 'Pair', 'Box', 'Kilogram', 'Meter']} onChange={(value) => change('salesUnit', value)} /></Row><Row label="付款方式"><Input label="付款方式" value={form.paymentMethod} onChange={(value) => change('paymentMethod', value)} /></Row></fieldset>
        <fieldset><legend>价格与库存</legend><div className="pe-radio-line">{[['quantity-tier', '根据数量设置阶梯价'], ['sku', '根据规格设置价格'], ['fob-range', '单一 FOB 区间价格'], ['fob-tier', 'FOB 阶梯价'], ...(form.priceMode === 'source-range' ? [['source-range', '来源区间价格']] : [])].map(([value, label]) => <label key={value}><input type="radio" name="price-mode" checked={form.priceMode === value} onChange={() => change('priceMode', value)} />{label}</label>)}</div>
          <Row label="基准销售价"><Input label="基准销售价" type="number" min="0" step="any" value={form.price} onChange={(value) => change('price', value)} /></Row><Row label="默认库存"><Input label="默认库存" type="number" min="0" value={form.stock} onChange={(value) => change('stock', value)} /></Row><Row label="最小起订量"><Input label="最小起订量" value={form.moq} onChange={(value) => change('moq', value)} /></Row>
          {product.currencySymbol && product.currencySymbol !== '$' && <Row label="换算汇率"><Input label="换算汇率" type="number" min="0.000001" step="any" value={usdRate} onChange={(value) => { setUsdRate(value); setDirty(true); }} /></Row>}
          {['quantity-tier', 'fob-tier'].includes(form.priceMode) && <TierEditor tiers={form.priceMode === 'fob-tier' ? form.fobPrice?.tiers || [] : form.priceTiers} currency={product.currencySymbol || '$'} onChange={(tiers) => form.priceMode === 'fob-tier' ? patchObject('fobPrice', 'tiers', tiers) : change('priceTiers', tiers)} />}
          {form.priceMode === 'fob-range' && <Row label="FOB 价格区间"><div className="pe-inline"><Input label="FOB 最低价" type="number" min="0" step="any" value={form.fobPrice?.minPrice} onChange={(value) => patchObject('fobPrice', 'minPrice', value)} /><span>至</span><Input label="FOB 最高价" type="number" min="0" step="any" value={form.fobPrice?.maxPrice} onChange={(value) => patchObject('fobPrice', 'maxPrice', value)} /></div></Row>}
          {form.priceMode === 'source-range' && <Row label="来源价格">{product.sourcePriceRange?.formattedText || '-'}</Row>}
          {form.priceMode === 'sku' && <Row label="规格价格"><button type="button" onClick={() => setTab('specs')}>编辑 SKU 价格</button></Row>}
        </fieldset>
        <fieldset><legend>发货期</legend><div className="pe-lead-table"><div><span>数量（件）</span><span>预计时间（天）</span><span /></div>{Array.from({ length: Math.max(3, (form.deliveryTime[0]?.length || 1) - 1) }, (_, index) => <div key={index}><Input label={`交期 ${index + 1} 数量`} value={form.deliveryTime[0]?.[index + 1]} onChange={(value) => change('deliveryTime', updateDeliveryCell(form.deliveryTime, index, 0, value))} /><Input label={`交期 ${index + 1} 天数`} value={form.deliveryTime[1]?.[index + 1]} onChange={(value) => change('deliveryTime', updateDeliveryCell(form.deliveryTime, index, 1, value))} /><IconButton title={`删除交期 ${index + 1}`} onClick={() => change('deliveryTime', form.deliveryTime.map((row) => row.filter((_, at) => at !== index + 1)))}><Trash2 size={15} /></IconButton></div>)}</div></fieldset>
      </div>
      <div {...pane('logistics')}><fieldset><legend>体积与重量（含物流包装）</legend><div className="pe-table-scroll"><table className="pe-table"><thead><tr>{['毛重（KG）', '长（CM）', '宽（CM）', '高（CM）'].map((label) => <th key={label}>{label}</th>)}</tr></thead><tbody><tr>{[['weight', '包装毛重'], ['length', '包装长'], ['width', '包装宽'], ['height', '包装高']].map(([key, label]) => <td key={key}><Input label={label} type="number" min="0" step="any" value={form.packaging[key]} onChange={(value) => patchObject('packaging', key, value)} /></td>)}</tr></tbody></table></div><Row label="包装说明" wide><textarea aria-label="包装说明" rows={3} value={form.packaging.description || form.packaging.text || ''} onChange={(event) => patchObject('packaging', 'description', event.target.value)} /></Row><Row label="箱规"><Choice label="箱规" value={form.shipping.cartonMode} options={['一箱一件', '一箱多件', '智能托管']} onChange={(value) => patchObject('shipping', 'cartonMode', value)} /></Row></fieldset>
        <fieldset><legend>物流提供方式</legend><Row label="运费模板"><Input label="运费模板" value={form.freightTemplate} onChange={(value) => change('freightTemplate', value)} /></Row><Row label="物流属性"><textarea aria-label="物流属性" rows={4} value={form.logisticsAttributes.join('\n')} onChange={(event) => change('logisticsAttributes', event.target.value.split('\n'))} /></Row><Row label="物流备注"><Input label="物流备注" value={form.shipping.notes} onChange={(value) => patchObject('shipping', 'notes', value)} /></Row></fieldset>
        <fieldset><legend>物流服务</legend><Row label="半托管服务"><Choice label="半托管服务" value={form.shipping.halfManaged == null ? '' : form.shipping.halfManaged ? '支持' : '不支持'} options={['支持', '不支持']} onChange={(value) => patchObject('shipping', 'halfManaged', value === '' ? null : value === '支持')} /></Row></fieldset>
      </div>
      <div {...pane('service')}><fieldset><legend>轻定制服务</legend><Row label="轻定制服务" wide><CheckOptions label="轻定制服务" value={form.services.lightCustomization || []} options={['Logo/graphic design', 'Packaging']} onChange={(value) => service('lightCustomization', value)} /></Row>{(form.services.customizations || []).map((item, index) => <Row key={index} label={item.name || item.type || '采集定制信息'}>{typeof item === 'string' ? item : Object.entries(item).filter(([key]) => !['name', 'type'].includes(key)).map(([key, value]) => `${key}: ${textValue(value)}`).join('；')}</Row>)}</fieldset>
        <fieldset><legend>深度定制</legend><Row label="定制服务" wide><CheckOptions label="深度定制" value={form.services.deepCustomization || []} options={[...form.attributes, ...form.variantGroups].map((item) => item.name)} onChange={(value) => service('deepCustomization', value)} /></Row></fieldset>
        <fieldset><legend>关联商品证书</legend><div className="pe-table-scroll"><table className="pe-table"><thead><tr><th>编号</th><th>证书名称</th><th>验真状态</th><th /></tr></thead><tbody>{form.certificates.map((item, index) => <tr key={index}><td><Input label={`证书 ${index + 1} 编号`} value={item.number} onChange={(number) => updateItem('certificates', index, { ...item, number })} /></td><td><Input label={`证书 ${index + 1} 名称`} value={item.name} onChange={(name) => updateItem('certificates', index, { ...item, name })} /></td><td>{item.verified === true ? '已核验' : item.verified === false ? '核验失败' : '未核验'}</td><td><IconButton title={`删除证书 ${index + 1}`} onClick={() => change('certificates', form.certificates.filter((_, at) => at !== index))}><Trash2 size={16} /></IconButton></td></tr>)}</tbody></table></div><button type="button" className="pe-link" onClick={() => change('certificates', [...form.certificates, { name: '', number: '', verified: null, source: 'manual' }])}><Plus size={16} />添加关联证书</button></fieldset>
        <fieldset><legend>商品服务</legend>{SERVICE_FIELDS.map(([key, label]) => <Row label={label} key={key}><div className="pe-radio-line">{[[null, '未设置'], [true, '支持'], [false, '不支持']].map(([value, text]) => <label key={text}><input type="radio" name={`service-${key}`} checked={(form.services[key] ?? null) === value} onChange={() => service(key, value)} />{text}</label>)}</div></Row>)}<Row label="出图出样服务"><CheckOptions label="出图出样服务" value={form.services.drawingSample || []} options={['三天出图', '七天出样']} onChange={(value) => service('drawingSample', value)} /></Row></fieldset>{form.services.sourceTexts?.length > 0 && <fieldset><legend>来源服务信息</legend>{form.services.sourceTexts.map((text, index) => <p key={index}>{text}</p>)}</fieldset>}
      </div>
      <div {...pane('description')}><fieldset><legend>商品详情图片</legend><MediaPicker label="详情图" images={form.detailImages} sourceImages={source.detailImages} onChange={(value) => change('detailImages', value)} notify={notify} /></fieldset><Row label="商品卖点" wide><textarea aria-label="商品卖点" rows={6} value={form.description} onChange={(event) => change('description', event.target.value)} /></Row><fieldset><legend>商品描述</legend><DescriptionEditor html={form.descriptionHtml || form.structuredDescription?.html || ''} onChange={(value) => { change('descriptionHtml', value); if (form.structuredDescription?.html) change('structuredDescription', { ...form.structuredDescription, html: value }); }} /></fieldset></div>
      <div {...pane('regional')}><fieldset><legend>国家/地区差异设置</legend><div className="pe-radio-line">{[['fixed', '直接设置价格'], ['amount', '基础价加减金额'], ['percent', '基础价调整比例']].map(([value, label]) => <label key={value}><input type="radio" name="regional-mode" checked={(form.regionalPricing.mode || 'fixed') === value} onChange={() => patchObject('regionalPricing', 'mode', value)} />{label}</label>)}</div>{regionalRows.map((row, index) => <div className="pe-regional-row" key={index}><OriginCountrySelect ariaLabel={`定价国家 ${index + 1}`} value={row.country} onChange={(country) => setRegionalRows(regionalRows.map((item, at) => at === index ? { ...item, country } : item))} /><Input label={`地区价格 ${index + 1}`} type="number" step="any" min={form.regionalPricing.mode === 'fixed' || !form.regionalPricing.mode ? '0' : undefined} value={row.value} onChange={(value) => setRegionalRows(regionalRows.map((item, at) => at === index ? { ...item, value } : item))} /><span>{form.regionalPricing.mode === 'percent' ? '%' : product.currencySymbol || '$'}</span><IconButton title={`删除地区 ${index + 1}`} onClick={() => setRegionalRows(regionalRows.filter((_, at) => at !== index))}><Trash2 size={16} /></IconButton></div>)}<button type="button" onClick={() => setRegionalRows([...regionalRows, { country: '', value: '' }])}><Plus size={16} />选取国家/地区</button></fieldset></div>
      </div>
      <footer className="pe-footer"><a href={product.sourceUrl || '#'} className="pe-link" onClick={(event) => { if (window.kuaYipu?.openSource && product.sourceUrl) { event.preventDefault(); window.kuaYipu.openSource(product.sourceUrl).catch((error) => notify(error.message, 'error')); } }} target="_blank" rel="noreferrer"><ExternalLink size={15} />产品链接</a>{referenceReview && <span className="pe-unsaved">引用已应用，待保存</span>}<div><button type="submit" disabled={saving || Boolean(uploadingVideo)}>{saving ? <LoaderCircle className="spin" size={17} /> : <Save size={17} />}保存</button><button type="button" disabled={saving} onClick={close}><ArrowLeft size={17} />返回</button></div></footer>
    </form>
  </section>{referenceScope && <ReferenceDialog products={[product]} editorDraft={referenceDraft} initialScope={referenceScope} onClose={() => setReferenceScope('')} notify={notify} onApplyDraft={({ patch, review }) => { setForm(createEditorForm({ ...product, ...referenceDraft, ...patch })); setReferenceReview(review); setReferenceScope(''); setGroupsDirty(false); setDirty(true); }} />}
  {discard && <div className="pe-confirm-backdrop"><section role="alertdialog" aria-label="未保存的修改" className="pe-confirm"><h3>有尚未保存的修改</h3><div><button type="button" onClick={() => setDiscard(false)}>继续编辑</button><button type="button" onClick={onClose}>放弃修改并返回</button></div></section></div>}</div>;
}

function MultiAttribute({ label, value, options, onChange }) {
  const [text, setText] = useState('');
  return <div><CheckOptions label={label} value={value} options={options} onChange={onChange} /><div className="pe-inline"><Input label={`${label}自定义值`} value={text} onChange={setText} /><button type="button" disabled={!text.trim()} onClick={() => { onChange([...new Set([...valuesOf(value), text.trim()])]); setText(''); }}><Plus size={16} />添加</button></div></div>;
}
function SpecificationGroup({ group, index, onChange, onRemove }) {
  const [option, setOption] = useState('');
  const [editingImage, setEditingImage] = useState('');
  function remove(value) { const optionImages = { ...group.optionImages }; delete optionImages[value]; onChange({ ...group, options: group.options.filter((item) => item !== value), optionImages }); }
  return <Row label={labelOf(group.name)}><div className="pe-spec-options">{group.options.map((value) => <div className="pe-spec-option" key={value}><span>{value}</span>{group.optionImages?.[value] && <img src={group.optionImages[value]} alt={`${value} 规格图片`} />}<button type="button" onClick={() => setEditingImage(editingImage === value ? '' : value)}><ImagePlus size={16} />选取图片</button><IconButton title={`移除 ${group.name} ${value}`} onClick={() => remove(value)}><X size={16} /></IconButton>{editingImage === value && <Input label={`${value} 规格图片地址`} value={group.optionImages?.[value]} onChange={(url) => onChange({ ...group, optionImages: { ...group.optionImages, [value]: url } })} />}</div>)}</div><div className="pe-inline"><Input label={`规格 ${index + 1} 新选项`} value={option} onChange={setOption} /><button type="button" disabled={!option.trim() || group.options.includes(option.trim())} onClick={() => { onChange({ ...group, options: [...group.options, option.trim()] }); setOption(''); }}><Plus size={16} />添加</button><IconButton title={`删除规格 ${group.name}`} onClick={onRemove}><Trash2 size={16} /></IconButton></div></Row>;
}
function TierEditor({ tiers, currency, onChange }) {
  return <div className="pe-tier-table"><div><span>最小起订量</span><span>最大数量</span><span>单件价格 {currency}</span><span /></div>{Array.from({ length: Math.max(4, tiers.length) }, (_, index) => { const tier = tiers[index] || { minQuantity: '', maxQuantity: null, price: '' }; const update = (patch) => { const rows = [...tiers]; rows[index] = { ...tier, ...patch }; onChange(Array.from(rows, (row) => row || { minQuantity: '', maxQuantity: null, price: '' })); }; return <div key={index}><Input label={`阶梯 ${index + 1} 起订量`} type="number" min="1" value={tier.minQuantity} onChange={(value) => update({ minQuantity: value })} /><Input label={`阶梯 ${index + 1} 最大数量`} type="number" min="1" value={tier.maxQuantity} onChange={(value) => update({ maxQuantity: value || null })} /><Input label={`阶梯 ${index + 1} 价格`} type="number" min="0" step="any" value={tier.price} onChange={(value) => update({ price: value })} /><IconButton title={`删除价格档 ${index + 1}`} onClick={() => onChange(tiers.filter((_, at) => at !== index))}><Trash2 size={15} /></IconButton></div>; })}</div>;
}
