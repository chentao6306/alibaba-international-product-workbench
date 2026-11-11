import { useEffect, useMemo, useRef, useState } from 'react';
import { editImageLists } from '../server/product-images.js';
import './BatchImageEditor.css';
import { chunks, processImageTargets, sameImages } from './batch-operations.js';
import BatchFailures from './BatchFailures.jsx';
import { readImageDrafts } from './image-draft-request.js';
import { localFetch } from './local-api.js';
import { PRODUCT_PAGE_SIZE, IMAGE_PAGE_SIZE, UNDO_BYTE_LIMIT, imageUndoEntry, appendImageUndo, undoImageEntry, replaceImageTargets } from './batch-image-state.js';

async function request(url, body) {
  const response = await localFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || data.message || '图片处理失败'), { status: response.status });
  return data;
}

export default function BatchImageEditor({ products, onSaved, notify, onGuardChange }) {
  const [originals, setOriginals] = useState([]), [drafts, setDrafts] = useState([]);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true), [loadAttempt, setLoadAttempt] = useState(0);
  const [error, setError] = useState(''), [undo, setUndo] = useState([]);
  const [productId, setProductId] = useState(''), [scope, setScope] = useState('both');
  const [productScope, setProductScope] = useState('current'), [search, setSearch] = useState(''), [productPage, setProductPage] = useState(0);
  const [imagePages, setImagePages] = useState({ mainImages: 0, detailImages: 0 });
  const [undoNotice, setUndoNotice] = useState('');
  const [restoreScope, setRestoreScope] = useState('both');
  const [processing, setProcessing] = useState(false), [stopping, setStopping] = useState(false);
  const stopRequested = useRef(false);
  const [uploadMode, setUploadMode] = useState('append'), [slot, setSlot] = useState(1);
  const [watermark, setWatermark] = useState({ type: 'text', text: '', imageUrl: '', color: '#ffffff', size: 6, opacity: 0.6, position: 'southeast' });
  const [watermarkImageName, setWatermarkImageName] = useState('');
  const [repairTarget, setRepairTarget] = useState(null), [region, setRegion] = useState(null);
  const [repairSample, setRepairSample] = useState(null), [pickingSample, setPickingSample] = useState(false);
  const [repairAll, setRepairAll] = useState(false), [comparison, setComparison] = useState(null);
  const alive = useRef(true), lock = useRef(false), drag = useRef(null);
  const [failures, setFailures] = useState([]), [saveFailures, setSaveFailures] = useState([]);
  const lastOperation = useRef(null);
  const dirty = useMemo(() => drafts.some((p, i) => !originals[i] || !sameImages(p, originals[i])), [drafts, originals]);
  const shown = drafts.find((p) => p.id === productId) || drafts[0];
  const filteredProducts = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return query ? drafts.filter((p) => `${p.title || ''} ${p.id}`.toLocaleLowerCase().includes(query)) : drafts;
  }, [drafts, search]);
  const visiblePage = Math.min(productPage, Math.max(0, Math.ceil(filteredProducts.length / PRODUCT_PAGE_SIZE) - 1));
  const visibleProducts = filteredProducts.slice(visiblePage * PRODUCT_PAGE_SIZE, (visiblePage + 1) * PRODUCT_PAGE_SIZE);
  const shownIndex = filteredProducts.findIndex((p) => p.id === shown?.id);
  const affectedProducts = productScope === 'all' ? drafts : shown ? [shown] : [];
  const scopeLabel = productScope === 'all' ? `全部 ${drafts.length} 件已选商品` : '当前商品';
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    alive.current = true;
    setLoading(true); setMessage('读取商品图片…'); setError('');
    (async () => {
      const items = [];
      for (const ids of chunks(products.map((p) => p.id))) {
        const batch = await readImageDrafts(ids, { signal: controller.signal });
        if (!active) return;
        items.push(...batch); setMessage(`读取商品图片 ${items.length}/${products.length}`);
      }
      setOriginals(items); setDrafts(items); setProductId(items[0]?.id || ''); setError(''); setUndo([]); setUndoNotice('');
    })().catch((e) => { if (active) setError(e.message); })
      .finally(() => { if (active) { setLoading(false); setMessage(''); } });
    return () => { active = false; alive.current = false; controller.abort(); };
  }, [loadAttempt]);
  useEffect(() => { onGuardChange({ busy, dirty }); }, [busy, dirty, onGuardChange]);
  function resetRepair() { setRepairTarget(null); setRegion(null); setRepairSample(null); setPickingSample(false); drag.current = null; }
  function selectProduct(id) {
    setProductId(id); setImagePages({ mainImages: 0, detailImages: 0 }); setComparison(null); resetRepair();
    const index = filteredProducts.findIndex((p) => p.id === id);
    if (index >= 0) setProductPage(Math.floor(index / PRODUCT_PAGE_SIZE));
    else { setSearch(''); setProductPage(Math.max(0, Math.floor(drafts.findIndex((p) => p.id === id) / PRODUCT_PAGE_SIZE))); }
  }
  function stage(next) {
    const entry = imageUndoEntry(drafts, next);
    if (!entry.patches.length) return;
    setFailures([]); setSaveFailures([]); setError('');
    setUndo((history) => appendImageUndo(history, entry));
    setUndoNotice(entry.bytes > UNDO_BYTE_LIMIT ? '本次批量修改超出撤销缓存；仍可恢复本次编辑前图片。' : '');
    setDrafts(next); setComparison(null); resetRepair();
  }
  function applyOperation(operation) {
    try {
      stage(drafts.map((p) => {
        if (productScope !== 'all' && p.id !== shown?.id) return p;
        try { return { ...p, ...editImageLists(p, operation) }; }
        catch (error) { throw new Error(`${p.title || p.id}：${error.message}；本次范围内修改尚未应用`); }
      }));
    } catch (e) { setError(e.message); notify(e.message, 'error'); }
  }
  async function run(work) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try { await work(); }
    catch (e) { if (alive.current) { setError(e.message); notify(e.message, 'error'); } }
    finally { lock.current = false; if (alive.current) { setBusy(false); setMessage(''); } }
  }
  async function upload(event, key) {
    const files = [...event.target.files]; event.target.value = '';
    if (!files.length) return;
    await run(async () => {
      const max = key === 'mainImages' ? 6 : 30;
      if (affectedProducts.some((p) => files.length + (uploadMode === 'append' ? p[key].length : 0) > max)) throw new Error(`所选范围的部分商品将超过 ${max} 张，请减少图片或选择替换`);
      if (files.some((f) => f.size > 5 * 1024 * 1024 || !['image/jpeg', 'image/png', 'image/webp'].includes(f.type))) throw new Error('请选择不超过 5 MB 的 JPG、PNG 或 WebP 图片');
      const urls = [];
      for (const file of files) {
        setMessage(`上传图片 ${urls.length + 1}/${files.length}`);
        const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('图片读取失败')); reader.readAsDataURL(file); });
        urls.push((await request('/api/media/upload-image', { data })).url);
      }
      if (alive.current) stage(drafts.map((p) => productScope === 'all' || p.id === shown?.id ? { ...p, [key]: [...(uploadMode === 'append' ? p[key] : []), ...urls] } : p));
    });
  }
  async function uploadWatermark(event) {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    await run(async () => {
      if (file.size > 5 * 1024 * 1024 || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('请选择不超过 5 MB 的 JPG、PNG 或 WebP 水印图片');
      setMessage('上传水印图片…');
      const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('水印图片读取失败')); reader.readAsDataURL(file); });
      const result = await request('/api/media/upload-image', { data });
      if (alive.current) { setWatermark((current) => ({ ...current, imageUrl: result.url })); setWatermarkImageName(file.name); }
    });
  }
  async function transform(action, targetOnly = null) {
    await run(async () => {
      if (action === 'watermark') {
        if (watermark.type === 'image' && !watermark.imageUrl) throw new Error('请先上传水印图片');
        if (watermark.type === 'text' && !watermark.text.trim()) throw new Error('请填写水印文字');
      }
      if (action === 'repair' && !region) throw new Error('请先在图片上拖动框选水印区域');
      const keys = targetOnly ? [targetOnly.key] : action === 'repair' ? [repairTarget.key] : scope === 'both' ? ['mainImages', 'detailImages'] : [scope];
      const targets = [];
      const selected = targetOnly || action === 'repair' && !repairAll ? drafts : affectedProducts;
      for (const p of selected) for (const key of keys) p[key].forEach((url, index) => {
        if (targetOnly && (p.id !== targetOnly.id || index !== targetOnly.index)) return;
        if (action !== 'repair' || repairAll || p.id === repairTarget.id && index === repairTarget.index) targets.push({ id: p.id, key, index, url });
      });
      if (!targets.length) throw new Error('所选范围没有图片');
      const titles = new Map(drafts.map((p) => [p.id, p.title]));
      await processTargets(targets.map((target) => ({ ...target, title: titles.get(target.id) })), { action, watermark: { ...watermark }, region: region && { ...region }, sample: repairSample && { ...repairSample } });
    });
  }
  async function processTargets(targets, operation) {
    lastOperation.current = operation;
    stopRequested.current = false; setProcessing(true); setStopping(false);
    let results;
    try {
      results = await processImageTargets(targets, (target) => request('/api/media/process', { url: target.url, ...operation }),
        (done, total) => { if (alive.current) setMessage(`处理图片 ${done}/${total}，成功结果保存前仅更新预览`); },
        { shouldCancel: () => stopRequested.current || !alive.current });
    } finally { if (alive.current) { setProcessing(false); setStopping(false); } }
    if (!alive.current) return;
    const next = replaceImageTargets(drafts, results), failed = [];
    let first;
    for (const { target, result, error } of results) {
      if (error) { failed.push({ ...target, error }); continue; }
      if (result.url !== target.url && !first) first = { before: target.url, after: result.url };
    }
    if (first) { stage(next); setComparison(first); }
    setFailures(failed);
    if (failed.length) setError(`有 ${failed.length} 张图片未完成，请查看下方失败清单；成功图片可保存，也可只重试失败图片。`);
    else if (!first) notify('所选图片没有需要修改的水印');
  }
  async function saveImages() {
    await run(async () => {
      const pending = drafts.filter((p, i) => !sameImages(p, originals[i]));
      const saved = new Map(), failed = []; let updated = 0, completed = 0;
      const batches = chunks(pending, 25);
      for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        const items = batches[batchIndex];
        try {
          const result = await request('/api/products/save-images', { items: items.map(({ id, revision, mainImages, detailImages }) => ({ id, revision, mainImages, detailImages })), partial: true });
          result.saved.forEach((p) => saved.set(p.id, p.revision));
          failed.push(...result.failures); updated += result.updated;
        } catch (error) {
          failed.push(...items.map((p) => ({ id: p.id, error: error.message })));
          if (error.code === 'LOCAL_API_UNREACHABLE' || error.status >= 500) {
            failed.push(...batches.slice(batchIndex + 1).flat().map(p => ({ id: p.id, error: '后台保存异常，尚未提交本商品；请恢复服务后重试' })));
            break;
          }
        }
        completed += items.length;
        if (!alive.current) return;
        setMessage(`保存图片 ${completed}/${pending.length}，已更新 ${updated} 件`);
      }
      const refreshed = drafts.map((p) => saved.has(p.id) ? { ...p, revision: saved.get(p.id) } : p);
      setDrafts(refreshed); setOriginals(originals.map((p, i) => saved.has(p.id) ? refreshed[i] : p)); setUndo([]);
      const byId = new Map(drafts.map((p) => [p.id, p]));
      setSaveFailures(failed.map((p) => ({ ...p, title: byId.get(p.id)?.title })));
      if (!failed.length && !failures.length) onSaved({ updated });
      else { setError(`已保存 ${updated} 件商品；${failed.length} 件保存失败，${failures.length} 张图片处理未完成。`); notify(`已保存 ${updated} 件商品，请查看未完成清单`); }
    });
  }
  function pointer(event) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)), y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)) };
  }
  function finishSelection(event) {
    if (!drag.current) return;
    const end = pointer(event), start = drag.current; drag.current = null;
    const next = { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(start.x - end.x), height: Math.abs(start.y - end.y) };
    if (next.width < 0.003 || next.height < 0.003 || next.width * next.height > 0.25) { setRegion(null); notify('请框选水印区域，面积不超过图片的 25%', 'error'); }
    else setRegion(next);
  }
  function removeOne(key, index) { stage(drafts.map((p) => p.id === shown.id ? { ...p, [key]: p[key].filter((_, i) => i !== index) } : p)); }
  return <section className="batch-image-editor" aria-label="批量图片编辑">
    <p className="batch-help">已选择 {products.length} 件商品。下方可逐件查看图片；所有修改先生成预览，点击“保存图片修改”后才会应用。原始采集快照保留。</p>
    {error && <p className="bie-error" role="alert">{error}</p>}
    <BatchFailures items={failures} busy={busy} onSelect={selectProduct} onRetry={() => run(() => processTargets(failures, lastOperation.current))} />
    <BatchFailures items={saveFailures} busy={busy} onSelect={selectProduct} />
    {(busy || loading) && <p role="status">{message || '处理中…'}</p>}
    {processing && <button type="button" className="secondary-button" disabled={stopping} onClick={() => { stopRequested.current = true; setStopping(true); }}>{stopping ? '正在等待已开始的图片处理完成…' : '停止后续图片处理'}</button>}
    {!loading && !drafts.length && <button type="button" className="secondary-button" onClick={() => setLoadAttempt(value => value + 1)}>重新读取图片</button>}
    {!!drafts.length && <nav className="bie-navigator" aria-label="已选商品图片导航">
      <div className="bie-navigation-heading"><strong>已选 {drafts.length} 件商品 · 点击商品切换图片</strong><label>搜索已选商品<input aria-label="搜索已选商品" type="search" value={search} disabled={busy} placeholder="输入商品标题或编号" onChange={(e) => { setSearch(e.target.value); setProductPage(0); }} /></label></div>
      <div className="bie-product-list">{visibleProducts.map((p) => <button type="button" key={p.id} className={`bie-product-card${p.id === shown?.id ? ' active' : ''}`} aria-pressed={p.id === shown?.id} disabled={busy} onClick={() => selectProduct(p.id)}>
        {p.mainImages[0] ? <img src={p.mainImages[0]} alt="" loading="lazy" /> : <span className="bie-product-placeholder">无主图</span>}
        <span><strong>{p.title || p.id}</strong><small>主图 {p.mainImages.length} · 详情图 {p.detailImages.length}</small></span>
      </button>)}</div>
      {!filteredProducts.length && <p className="batch-help">没有匹配的已选商品，当前预览保持不变。</p>}
      <div className="bie-pagination"><button type="button" className="secondary-button" disabled={busy || visiblePage === 0} onClick={() => setProductPage(visiblePage - 1)}>上一页商品</button><span>第 {visiblePage + 1} / {Math.max(1, Math.ceil(filteredProducts.length / PRODUCT_PAGE_SIZE))} 页 · {filteredProducts.length} 件{search ? '匹配' : '已选'}商品</span><button type="button" className="secondary-button" disabled={busy || (visiblePage + 1) * PRODUCT_PAGE_SIZE >= filteredProducts.length} onClick={() => setProductPage(visiblePage + 1)}>下一页商品</button></div>
      <div className="bie-current-product"><button type="button" className="secondary-button" disabled={busy || shownIndex <= 0} onClick={() => selectProduct(filteredProducts[shownIndex - 1].id)}>上一件商品</button><strong>当前预览：{shown?.title || shown?.id}</strong><button type="button" className="secondary-button" disabled={busy || shownIndex < 0 || shownIndex >= filteredProducts.length - 1} onClick={() => selectProduct(filteredProducts[shownIndex + 1].id)}>下一件商品</button></div>
    </nav>}
    <div className={`bie-operation-scope${productScope === 'all' ? ' all' : ''}`}>
      <label>整理、上传及水印操作的商品范围<select aria-label="图片编辑商品范围" disabled={busy || !drafts.length} value={productScope} onChange={(e) => setProductScope(e.target.value)}><option value="current">仅当前预览商品</option><option value="all">全部 {drafts.length} 件已选商品</option></select></label>
      <p>以下批量工具将应用到<strong>{scopeLabel}</strong>。图片卡片上的按钮只操作该商品的这一张图片。</p>
    </div>
    <fieldset disabled={busy || !drafts.length}>
      <legend>图片整理</legend>
      <small>作用商品：{scopeLabel}</small>
      <div className="bie-actions">{[['dedupe', '图片去重并排序'], ['copy-detail', '主图复制为详情图'], ['clean', '清理空图片'], ['clear-main', '清空范围内主图'], ['clear-detail', '清空范围内详情图']].map(([action, label]) => <button type="button" key={action} className="secondary-button" onClick={() => applyOperation(action)}>{label}</button>)}</div>
      <div className="bie-actions"><label>删除指定序号<input aria-label="批量删除图片序号" type="number" min="1" max="30" value={slot} onChange={(e) => setSlot(e.target.value)} /></label><button type="button" className="secondary-button" disabled={!Number.isInteger(Number(slot)) || slot < 1 || slot > 6} onClick={() => applyOperation(`delete-main-${slot}`)}>删除范围内第 {slot} 张主图</button><button type="button" className="secondary-button" disabled={!Number.isInteger(Number(slot)) || slot < 1 || slot > 30} onClick={() => applyOperation(`delete-detail-${slot}`)}>删除范围内第 {slot} 张详情图</button></div>
    </fieldset>
    <fieldset disabled={busy || !drafts.length}><legend>上传自己的图片</legend><div className="bie-actions"><label>上传方式<select aria-label="上传方式" value={uploadMode} onChange={(e) => setUploadMode(e.target.value)}><option value="append">追加到现有图片</option><option value="replace">替换该类型全部图片</option></select></label>{[['mainImages', '主图'], ['detailImages', '详情图']].map(([key, label]) => <label key={key} className="bie-upload">上传{label}<input aria-label={`上传${label}`} type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(e) => upload(e, key)} /></label>)}</div><small>支持 JPG、PNG、WebP，单张不超过 5 MB；主图最多 6 张，详情图最多 30 张。</small></fieldset>
    <fieldset disabled={busy}>
      <legend>本软件水印</legend>
      <div className="bie-settings">
        <label>水印类型<select aria-label="水印类型" value={watermark.type} onChange={(e) => setWatermark({ ...watermark, type: e.target.value, size: e.target.value === 'image' ? 25 : 6 })}><option value="text">文字水印</option><option value="image">图片水印</option></select></label>
        <label>作用范围<select aria-label="水印作用范围" value={scope} onChange={(e) => setScope(e.target.value)}><option value="both">主图和详情图</option><option value="mainImages">仅主图</option><option value="detailImages">仅详情图</option></select></label>
        {watermark.type === 'text' ? <><label>水印文字<input aria-label="水印文字" maxLength={80} value={watermark.text} onChange={(e) => setWatermark({ ...watermark, text: e.target.value })} /></label><label>颜色<input aria-label="水印颜色" type="color" value={watermark.color} onChange={(e) => setWatermark({ ...watermark, color: e.target.value })} /></label></> : <div className="bie-watermark-upload">
          <label>上传水印图片<input aria-label="上传水印图片" disabled={loading || !drafts.length} type="file" accept="image/jpeg,image/png,image/webp" onChange={uploadWatermark} /></label>
          <small>支持 JPG、PNG、WebP，单张不超过 5 MB。推荐透明背景 PNG；上传后点击“一键添加／更新水印”查看效果。</small>
          {watermark.imageUrl && <div className="bie-watermark-preview"><img src={watermark.imageUrl} alt="已上传的水印图片" /><span>{watermarkImageName}</span><button type="button" className="secondary-button" onClick={() => { setWatermark({ ...watermark, imageUrl: '' }); setWatermarkImageName(''); }}>清除水印素材</button></div>}
        </div>}
        <label>位置<select aria-label="水印位置" value={watermark.position} onChange={(e) => setWatermark({ ...watermark, position: e.target.value })}>{[['northwest', '左上'], ['northeast', '右上'], ['center', '居中'], ['southwest', '左下'], ['southeast', '右下']].map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
        <label>{watermark.type === 'image' ? '水印宽度' : '大小'} {watermark.size}%<input aria-label="水印大小" type="range" min="2" max={watermark.type === 'image' ? '60' : '20'} value={watermark.size} onChange={(e) => setWatermark({ ...watermark, size: Number(e.target.value) })} /></label>
        <label>透明度 {Math.round(watermark.opacity * 100)}%<input aria-label="水印透明度" type="range" min="0.1" max="1" step="0.05" value={watermark.opacity} onChange={(e) => setWatermark({ ...watermark, opacity: Number(e.target.value) })} /></label>
      </div>
      {watermark.type === 'image' && <small>宽度按原图宽度的比例计算，保持图片比例；过高的水印会自动缩小至原图高度的 80% 以内。</small>}
      <div className="bie-actions"><button type="button" className="secondary-button" disabled={loading || !drafts.length} onClick={() => transform('watermark')}>一键添加／更新水印</button><button type="button" className="secondary-button" disabled={loading || !drafts.length} onClick={() => transform('remove-watermark')}>删除本软件水印</button></div>
    </fieldset>
    <fieldset disabled={busy || !drafts.length}><legend>采集图片原有水印</legend><p className="batch-help">点击下方图片的“修复原图水印”，拖动框选区域。自动匹配周围背景，也可手动取样。请紧贴水印框选，避开商品轮廓，并对比预览后保存。</p>{repairTarget && <div className="bie-repair"><p className="batch-help">修复对象：{repairAll ? `${scopeLabel}的同类图片` : `当前商品第 ${repairTarget.index + 1} 张${repairTarget.key === 'mainImages' ? '主图' : '详情图'}`}；请确认图片水印位置一致。</p><strong>{pickingSample ? '点击干净背景，选取修复用的取样点' : '拖动框选需要修复的水印区域'}</strong><div className="bie-selection" onPointerDown={(e) => { if (busy) return; if (pickingSample) { setRepairSample(pointer(e)); setPickingSample(false); return; } drag.current = pointer(e); setRegion(null); setRepairSample(null); e.currentTarget.setPointerCapture(e.pointerId); }} onPointerMove={(e) => { if (!drag.current) return; const end = pointer(e), start = drag.current; setRegion({ x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) }); }} onPointerUp={finishSelection} onPointerCancel={() => { drag.current = null; setRegion(null); }}><img draggable="false" src={repairTarget.url} alt="框选水印的原图" />{repairSample && <b style={{ position: 'absolute', left: `${repairSample.x * 100}%`, top: `${repairSample.y * 100}%`, color: '#00856d', background: 'white', pointerEvents: 'none' }}>＋</b>}{region && <span style={{ left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%` }} />}</div><label className="bie-check"><input type="checkbox" checked={repairAll} onChange={(e) => setRepairAll(e.target.checked)} />对{scopeLabel}的全部{repairTarget.key === 'mainImages' ? '主图' : '详情图'}应用相同相对位置（未勾选时仅修复此图）</label><div className="bie-actions"><button type="button" className="secondary-button" disabled={!region} onClick={() => setPickingSample(true)}>选择背景取样点</button><button type="button" className="secondary-button" disabled={!repairSample} onClick={() => { setRepairSample(null); setPickingSample(false); }}>恢复自动取样</button><button type="button" className="secondary-button" disabled={!region || pickingSample} onClick={() => transform('repair')}>修复框选水印并预览</button><button type="button" className="secondary-button" onClick={() => { setRepairTarget(null); setRegion(null); setRepairSample(null); setPickingSample(false); }}>取消框选</button></div></div>}</fieldset>
    {comparison && <div className="bie-comparison">{[['before', '处理前'], ['after', '处理后']].map(([key, label]) => <figure key={key}><figcaption>{label}</figcaption><img src={comparison[key]} alt={label} /></figure>)}</div>}
    {shown && <section className="bie-images" aria-label="当前商品图片" data-product-id={shown.id}>
      <h3>当前商品图片：{shown.title || shown.id}</h3>
      <p className="batch-help">以下按钮仅修改当前商品的单张图片。每类每页显示 {IMAGE_PAGE_SIZE} 张，切页不会丢失修改。</p>
      {[['mainImages', '主图'], ['detailImages', '详情图']].map(([key, label]) => {
        const page = Math.min(imagePages[key], Math.max(0, Math.ceil(shown[key].length / IMAGE_PAGE_SIZE) - 1));
        return <div key={key} className="bie-image-section"><h4>{label} · {shown[key].length} 张</h4>
          <div className="bie-grid">{shown[key].slice(page * IMAGE_PAGE_SIZE, (page + 1) * IMAGE_PAGE_SIZE).map((url, offset) => {
            const index = page * IMAGE_PAGE_SIZE + offset;
            return <article key={`${index}-${url}`}><img src={url} alt={`${label} ${index + 1}`} loading="lazy" /><span>{label} {index + 1}</span><button type="button" className="secondary-button" disabled={busy} onClick={() => removeOne(key, index)}>删除{label} {index + 1}</button><button type="button" className="secondary-button" disabled={busy} aria-label={`删除${label} ${index + 1} 的软件水印`} onClick={() => transform('remove-watermark', { id: shown.id, key, index })}>删除软件水印</button><button type="button" className="secondary-button" disabled={busy} onClick={() => { setRepairTarget({ id: shown.id, key, index, url }); setRegion(null); setRepairAll(false); setRepairSample(null); setPickingSample(false); }}>修复原图水印</button></article>;
          })}</div>
          {!shown[key].length && <p className="batch-help">暂无{label}</p>}
          {shown[key].length > IMAGE_PAGE_SIZE && <div className="bie-pagination"><button type="button" className="secondary-button" disabled={busy || !page} onClick={() => setImagePages({ ...imagePages, [key]: page - 1 })}>上一页{label}</button><span>{label}第 {page + 1} / {Math.ceil(shown[key].length / IMAGE_PAGE_SIZE)} 页</span><button type="button" className="secondary-button" disabled={busy || (page + 1) * IMAGE_PAGE_SIZE >= shown[key].length} onClick={() => setImagePages({ ...imagePages, [key]: page + 1 })}>下一页{label}</button></div>}
        </div>;
      })}
    </section>}
    <fieldset disabled={busy || !drafts.length}><legend>恢复原始采集图片</legend>
      <p className="batch-help">从原始采集快照恢复图片，保存并重新打开后仍可使用；恢复不会去除原图自带的水印。作用商品：<strong>{scopeLabel}</strong>。先预览，再保存。</p>
      {shown?.sourceImageError && <p className="bie-error">当前商品：{shown.sourceImageError}</p>}
      {shown?.sourceImageErrors && Object.entries(shown.sourceImageErrors).map(([key, value]) => <p className="bie-error" key={key}>{key === 'mainImages' ? '主图' : '详情图'}：{value}</p>)}
      <div className="bie-actions"><label>恢复图片类型<select aria-label="恢复原始采集图片类型" value={restoreScope} onChange={(e) => setRestoreScope(e.target.value)}><option value="both">主图和详情图</option><option value="main">仅主图</option><option value="detail">仅详情图</option></select></label><button type="button" className="secondary-button" onClick={() => applyOperation(`restore-source-${restoreScope}`)}>恢复原始采集图片并预览</button></div>
    </fieldset>
    <p className="batch-help">共 {drafts.length} 件商品，保存时仅提交已修改的商品，并自动分批处理。</p>
    {undoNotice && <p className="batch-help">{undoNotice}</p>}
    <div className="bie-footer"><button type="button" className="secondary-button" disabled={busy || !undo.length} onClick={() => { setFailures([]); setSaveFailures([]); setError(''); setDrafts(undoImageEntry(drafts, undo.at(-1))); setUndo(undo.slice(0, -1)); setUndoNotice(''); setComparison(null); resetRepair(); }}>撤销上一步</button><button type="button" className="secondary-button" disabled={busy || !dirty} onClick={() => stage(drafts.map((p, i) => productScope === 'all' || p.id === shown?.id ? { ...p, mainImages: originals[i].mainImages, detailImages: originals[i].detailImages } : p))}>恢复{productScope === 'all' ? '全部商品' : '当前商品'}本次编辑前图片</button><button type="button" className="primary-button" disabled={busy || !dirty || !drafts.length} onClick={saveImages}>保存图片修改</button></div>
  </section>;
}
