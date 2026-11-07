import { localFetch } from './local-api.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronRight, LoaderCircle, Search } from 'lucide-react';
import { createCategoryCatalog } from '../server/category-catalog-model.js';
import './CategorySelect.css';

const RECENT_KEY = 'alibaba-recent-category-ids';
function readRecent() {
  try { const value = JSON.parse(localStorage.getItem(RECENT_KEY)); return Array.isArray(value) ? value.filter((id) => /^\d+$/.test(id)).slice(0, 20) : []; }
  catch { return []; }
}
async function request(url, options) {
  const response = await localFetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '类目读取失败，请稍后重试');
  return data;
}

export default function CategorySelect({ path = '', categoryId = '', suggestions = [], onChange, onCancel }) {
  const [catalog, setCatalog] = useState(null);
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [mode, setMode] = useState('browse');
  const [query, setQuery] = useState('');
  const [language, setLanguage] = useState('en');
  const [selectedId, setSelectedId] = useState('');
  const [recent, setRecent] = useState(readRecent);
  const [referenceUrl, setReferenceUrl] = useState('');
  const [reference, setReference] = useState(null);
  const [reading, setReading] = useState(false);
  const [referenceError, setReferenceError] = useState('');
  const referenceRequest = useRef(null);

  useEffect(() => {
    const abort = new AbortController();
    setLoading(true); setError('');
    request('/api/categories/catalog', { signal: abort.signal }).then((data) => {
      const next = createCategoryCatalog(data.nodes);
      if (!abort.signal.aborted) { setCatalog(next); setMeta(data); }
    }).catch((failure) => { if (!abort.signal.aborted) setError(failure.message); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [attempt]);
  useEffect(() => () => referenceRequest.current?.abort(), []);

  const trail = catalog?.path(selectedId) || [];
  const selected = reference || catalog?.option(selectedId);
  const search = useMemo(() => catalog?.search(query) || { total: 0, items: [] }, [catalog, query]);
  const columns = catalog ? [catalog.children(), ...trail.filter((node) => !node.leaf).map((node) => catalog.children(node.id))] : [];
  const nameOf = (node) => language === 'zh' ? node.nameZh || node.name : node.name;
  const pathOf = (id) => catalog.path(id).map(nameOf).join(' >> ');
  const cancelReference = () => { referenceRequest.current?.abort(); referenceRequest.current = null; setReading(false); setReference(null); setReferenceError(''); };
  function select(id) { cancelReference(); setSelectedId(id); }
  function changeMode(next) { cancelReference(); setMode(next); }
  function apply() {
    if (!selected?.id || reading) return;
    const ids = [selected.id, ...recent.filter((id) => id !== selected.id)].slice(0, 20);
    setRecent(ids);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(ids)); } catch {}
    onChange({ id: selected.id, path: selected.path });
  }
  async function readReference() {
    cancelReference();
    const abort = new AbortController(); referenceRequest.current = abort;
    setReading(true); setSelectedId('');
    try {
      const option = await request('/api/categories/from-product', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: referenceUrl }), signal: abort.signal });
      if (abort.signal.aborted) return;
      if (!/^\d+$/.test(String(option.id)) || !option.path) throw new Error('该商品未返回有效类目');
      if (catalog?.get(option.id) && !catalog.option(option.id)) throw new Error('该商品返回的是上级目录，请选择末级类目');
      setReference(catalog?.option(option.id) || option);
    } catch (failure) { if (!abort.signal.aborted) setReferenceError(failure.message); }
    finally { if (referenceRequest.current === abort) { referenceRequest.current = null; setReading(false); } }
  }
  const renderChoice = (node, fullPath = false) => <button type="button" role="option" aria-selected={!reference && (fullPath ? selectedId === node.id : trail.some((part) => part.id === node.id))} key={node.id} onClick={() => select(node.id)} title={`${pathOf(node.id)}（ID ${node.id}）`}>
    <span>{fullPath ? pathOf(node.id) : nameOf(node)}{fullPath && <small>ID {node.id}</small>}</span>{node.leaf ? <Check size={14} /> : <ChevronRight size={15} />}
  </button>;
  return <section className="category-picker" aria-label="选择国际站产品类目" onKeyDown={(event) => {
    if (event.key === 'Escape' && onCancel) { event.stopPropagation(); event.preventDefault(); onCancel(); }
    if (event.key === 'Enter' && event.target.tagName === 'INPUT') { event.preventDefault(); if (mode === 'reference' && referenceUrl.trim() && !reading) readReference(); }
  }}>
    <div className="category-picker-current">当前类目：{path || '未选择'}{categoryId ? `（ID ${categoryId}）` : ''}</div>
    {!!suggestions.length && catalog && <div className="category-picker-results"><strong>根据来源类目找到的候选，请核对具体商品</strong><div role="listbox" aria-label="来源类目候选">{suggestions.map((item) => catalog.get(item.id)).filter((node) => node?.leaf).map((node) => renderChoice(node, true))}</div></div>}
    <div className="category-picker-toolbar">
      <div role="tablist" aria-label="类目选择方式">{[['browse', '浏览类目'], ['search', '搜索类目'], ['recent', '最近使用'], ['reference', '读取同类商品']].map(([id, title]) => <button type="button" role="tab" aria-selected={mode === id} key={id} onClick={() => changeMode(id)}>{title}</button>)}</div>
      <select aria-label="类目显示语言" value={language} onChange={(event) => setLanguage(event.target.value)}><option value="en">English</option><option value="zh">简体中文</option></select>
    </div>
    {loading && <div className="category-picker-status" role="status"><LoaderCircle size={18} className="spin" />正在加载类目目录…</div>}
    {error && <div className="category-picker-error" role="alert">{error}<button type="button" onClick={() => setAttempt((value) => value + 1)}>重新加载</button></div>}
    {mode === 'browse' && catalog && <div className="category-picker-columns">{columns.map((items, index) => <div className="category-picker-column" key={index}><strong>第 {index + 1} 级</strong><div role="listbox" aria-label={`第 ${index + 1} 级类目`}>{items.map((node) => renderChoice(node))}{!items.length && <p className="category-picker-status">平台暂未提供该目录的子类目，请读取同类商品或选择其他类目。</p>}</div></div>)}</div>}
    {mode === 'search' && <div className="category-picker-search"><div className="category-picker-input"><Search size={18} /><input aria-label="搜索类目名称或 ID" value={query} maxLength={120} placeholder="输入类目名称或 ID" onChange={(event) => { setQuery(event.target.value); select(''); }} /></div>{query.trim() && catalog && <><small>找到 {search.total} 个末级类目{search.total > search.items.length ? '，请细化关键词以查看其他结果' : ''}</small><div className="category-picker-results" role="listbox" aria-label="类目搜索结果">{search.items.map((node) => renderChoice(node, true))}</div></>}</div>}
    {mode === 'recent' && catalog && <div className="category-picker-results" role="listbox" aria-label="最近使用类目">{recent.map((id) => catalog.get(id)).filter((node) => node?.leaf).map((node) => renderChoice(node, true))}{!recent.some((id) => catalog.option(id)) && <p>确认选择的类目会显示在这里。</p>}</div>}
    {mode === 'reference' && <div className="category-picker-reference"><p>粘贴同类国际站商品链接，读取后核对类目。</p><div className="category-picker-input"><input aria-label="同类国际站商品链接" placeholder="https://www.alibaba.com/product-detail/..." value={referenceUrl} onChange={(event) => { cancelReference(); setReferenceUrl(event.target.value); }} /><button type="button" disabled={reading || !referenceUrl.trim()} onClick={readReference}>{reading ? '正在读取…' : '读取商品类目'}</button></div>{referenceError && <p role="alert" className="category-picker-error">{referenceError}</p>}</div>}
    <div className="category-picker-preview" aria-live="polite">{selected ? <>已选择：<strong>{language === 'zh' ? selected.pathZh || selected.path : selected.path}</strong><small>ID {selected.id}</small></> : <>待选择：{trail.length ? trail.map(nameOf).join(' >> ') : '请选择产品所属的类目'}{trail.length > 0 && <small>请继续选择下一级类目</small>}</>}</div>
    <div className="category-picker-footer"><small>{catalog ? `${catalog.children().length} 个一级类目 · ${catalog.leafCount.toLocaleString()} 个末级类目${meta?.updatedAt ? ` · 更新于 ${meta.updatedAt.slice(0, 10)}` : ''}` : '目录不可用时仍可读取同类商品'}<br />选择后请核对商品属性；可发布范围以店铺经营类目和平台规则为准。</small><div>{onCancel && <button type="button" onClick={onCancel}>取消选择</button>}<button type="button" className="category-picker-apply" disabled={!selected || reading} onClick={apply}>确认选择</button></div></div>
  </section>;
}
