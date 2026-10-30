import { useEffect, useMemo, useRef, useState } from 'react';
import { editImageLists } from '../server/product-images.js';
import './BatchImageEditor.css';
import { chunks, processImageTargets, sameImages } from './batch-operations.js';
import BatchFailures from './BatchFailures.jsx';
import { readImageDrafts } from './image-draft-request.js';
import { localFetch } from './local-api.js';

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
      setOriginals(items); setDrafts(items); setProductId(items[0]?.id || ''); setError('');
    })().catch((e) => { if (active) setError(e.message); })
      .finally(() => { if (active) { setLoading(false); setMessage(''); } });
    return () => { active = false; alive.current = false; controller.abort(); };
  }, [loadAttempt]);
  useEffect(() => { onGuardChange({ busy, dirty }); }, [busy, dirty, onGuardChange]);
  function stage(next) {
    setFailures([]); setSaveFailures([]);
    setUndo((history) => [...history.slice(-19), drafts]);
    setDrafts(next); setComparison(null); setRepairTarget(null); setRegion(null); setRepairSample(null); setPickingSample(false);
  }
  function applyOperation(operation) {
    try { stage(drafts.map((p) => ({ ...p, ...editImageLists(p, operation) }))); }
    catch (e) { notify(e.message, 'error'); }
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
      if (drafts.some((p) => files.length + (uploadMode === 'append' ? p[key].length : 0) > max)) throw new Error(`部分商品将超过 ${max} 张，请减少图片或选择替换`);
      if (files.some((f) => f.size > 5 * 1024 * 1024 || !['image/jpeg', 'image/png', 'image/webp'].includes(f.type))) throw new Error('请选择不超过 5 MB 的 JPG、PNG 或 WebP 图片');
      const urls = [];
      for (const file of files) {
        setMessage(`上传图片 ${urls.length + 1}/${files.length}`);
        const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('图片读取失败')); reader.readAsDataURL(file); });
        urls.push((await request('/api/media/upload-image', { data })).url);
      }
      if (alive.current) stage(drafts.map((p) => ({ ...p, [key]: [...(uploadMode === 'append' ? p[key] : []), ...urls] })));
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
      for (const p of drafts) for (const key of keys) p[key].forEach((url, index) => {
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
    const results = await processImageTargets(targets, (target) => request('/api/media/process', { url: target.url, ...operation }),
      (done, total) => { if (alive.current) setMessage(`处理图片 ${done}/${total}，成功结果保存前仅更新预览`); });
    if (!alive.current) return;
    const next = drafts.map((p) => ({ ...p, mainImages: [...p.mainImages], detailImages: [...p.detailImages] }));
    const index = new Map(next.map((p) => [p.id, p])), failed = [];
    let first;
    for (const { target, result, error } of results) {
      if (error) { failed.push({ ...target, error }); continue; }
      index.get(target.id)[target.key][target.index] = result.url;
      if (result.changed && !first) first = { before: target.url, after: result.url };
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
          const result = await request('/api/products/save-images', { items, partial: true });
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
    <p className="batch-help">所有操作先生成预览，点击“保存图片修改”后才会应用。上传图片会用于全部 {products.length} 件已选商品；原始采集快照保留。</p>
    {error && <p className="bie-error" role="alert">{error}</p>}
    <BatchFailures items={failures} busy={busy} onSelect={setProductId} onRetry={() => run(() => processTargets(failures, lastOperation.current))} />
    <BatchFailures items={saveFailures} busy={busy} onSelect={setProductId} />
    {(busy || loading) && <p role="status">{message || '处理中…'}</p>}
    {!loading && !drafts.length && <button type="button" className="secondary-button" onClick={() => setLoadAttempt(value => value + 1)}>重新读取图片</button>}
    <fieldset disabled={busy || !drafts.length}>
      <legend>图片整理</legend>
      <div className="bie-actions">{[['dedupe', '图片去重并排序'], ['copy-detail', '主图复制为详情图'], ['clean', '清理空图片'], ['clear-main', '清空全部主图'], ['clear-detail', '清空全部详情图']].map(([action, label]) => <button type="button" key={action} className="secondary-button" onClick={() => applyOperation(action)}>{label}</button>)}</div>
      <div className="bie-actions"><label>删除指定序号<input aria-label="批量删除图片序号" type="number" min="1" max="30" value={slot} onChange={(e) => setSlot(e.target.value)} /></label><button type="button" className="secondary-button" disabled={!Number.isInteger(Number(slot)) || slot < 1 || slot > 6} onClick={() => applyOperation(`delete-main-${slot}`)}>删除各商品第 {slot} 张主图</button><button type="button" className="secondary-button" disabled={!Number.isInteger(Number(slot)) || slot < 1 || slot > 30} onClick={() => applyOperation(`delete-detail-${slot}`)}>删除各商品第 {slot} 张详情图</button></div>
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
    <fieldset disabled={busy || !drafts.length}><legend>采集图片原有水印</legend><p className="batch-help">点击下方图片的“修复原图水印”，拖动框选区域。自动匹配周围背景，也可手动取样。请紧贴水印框选，避开商品轮廓，并对比预览后保存。</p>{repairTarget && <div className="bie-repair"><strong>{pickingSample ? '点击干净背景，选取修复用的取样点' : '拖动框选需要修复的水印区域'}</strong><div className="bie-selection" onPointerDown={(e) => { if (busy) return; if (pickingSample) { setRepairSample(pointer(e)); setPickingSample(false); return; } drag.current = pointer(e); setRegion(null); setRepairSample(null); e.currentTarget.setPointerCapture(e.pointerId); }} onPointerMove={(e) => { if (!drag.current) return; const end = pointer(e), start = drag.current; setRegion({ x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) }); }} onPointerUp={finishSelection} onPointerCancel={() => { drag.current = null; setRegion(null); }}><img draggable="false" src={repairTarget.url} alt="框选水印的原图" />{repairSample && <b style={{ position: 'absolute', left: `${repairSample.x * 100}%`, top: `${repairSample.y * 100}%`, color: '#00856d', background: 'white', pointerEvents: 'none' }}>＋</b>}{region && <span style={{ left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%` }} />}</div><label className="bie-check"><input type="checkbox" checked={repairAll} onChange={(e) => setRepairAll(e.target.checked)} />对全部已选商品的同类图片应用相同相对位置（请确认水印位置一致）</label><div className="bie-actions"><button type="button" className="secondary-button" disabled={!region} onClick={() => setPickingSample(true)}>选择背景取样点</button><button type="button" className="secondary-button" disabled={!repairSample} onClick={() => { setRepairSample(null); setPickingSample(false); }}>恢复自动取样</button><button type="button" className="secondary-button" disabled={!region || pickingSample} onClick={() => transform('repair')}>修复框选水印并预览</button><button type="button" className="secondary-button" onClick={() => { setRepairTarget(null); setRegion(null); setRepairSample(null); setPickingSample(false); }}>取消框选</button></div></div>}</fieldset>
    {comparison && <div className="bie-comparison">{[['before', '处理前'], ['after', '处理后']].map(([key, label]) => <figure key={key}><figcaption>{label}</figcaption><img src={comparison[key]} alt={label} /></figure>)}</div>}
    <label className="bie-product">预览商品<select aria-label="预览商品" value={shown?.id || ''} disabled={busy} onChange={(e) => { setProductId(e.target.value); setRepairTarget(null); setRegion(null); setRepairSample(null); setPickingSample(false); }}>{drafts.map((p) => <option key={p.id} value={p.id}>{p.title || p.id}</option>)}</select></label>
    {shown && [['mainImages', '主图'], ['detailImages', '详情图']].map(([key, label]) => <div key={key}><h3>{label} · {shown[key].length} 张</h3><div className="bie-grid">{shown[key].map((url, index) => <article key={`${index}-${url}`}><img src={url} alt={`${label} ${index + 1}`} loading="lazy" /><span>{label} {index + 1}</span><button type="button" className="secondary-button" disabled={busy} onClick={() => removeOne(key, index)}>删除{label} {index + 1}</button><button type="button" className="secondary-button" disabled={busy} aria-label={`删除${label} ${index + 1} 的软件水印`} onClick={() => transform('remove-watermark', { id: shown.id, key, index })}>删除软件水印</button><button type="button" className="secondary-button" disabled={busy} onClick={() => { setRepairTarget({ id: shown.id, key, index, url }); setRegion(null); setRepairAll(false); setRepairSample(null); setPickingSample(false); }}>修复原图水印</button></article>)}</div>{!shown[key].length && <p className="batch-help">暂无{label}</p>}</div>)}
    <p className="batch-help">共 {drafts.length} 件商品，保存时自动分批处理。可用上方“预览商品”切换查看。</p>
    <div className="bie-footer"><button type="button" className="secondary-button" disabled={busy || !undo.length} onClick={() => { setFailures([]); setSaveFailures([]); setDrafts(undo.at(-1)); setUndo(undo.slice(0, -1)); setComparison(null); setRepairTarget(null); }}>撤销上一步</button><button type="button" className="secondary-button" disabled={busy || !dirty} onClick={() => { stage(structuredClone(originals)); setRepairTarget(null); }}>恢复本次编辑前图片</button><button type="button" className="primary-button" disabled={busy || !dirty || !drafts.length} onClick={saveImages}>保存图片修改</button></div>
  </section>;
}
