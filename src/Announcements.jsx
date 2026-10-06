import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, ChevronLeft, ChevronRight, RefreshCw, X } from 'lucide-react';
import { announcementBlocks, nextAnnouncementPopup } from '../auth-server/announcement-content.js';

function AnnouncementImage({ block }) {
  const [failed, setFailed] = useState(false);
  return <figure className="announcement-image">{failed ? <span role="status">图片暂时无法加载<button className="secondary-button" onClick={() => setFailed(false)}>重新加载图片</button></span>
    : <a href={block.src} target="_blank" rel="noreferrer" title="查看原图"><img src={block.src} alt={block.alt || '公告图片'} onError={() => setFailed(true)} /></a>}{block.alt && <figcaption>{block.alt}</figcaption>}</figure>;
}

export function AnnouncementBody({ item }) {
  return <div className="announcement-body">{announcementBlocks(item).map((block, index) => block.type === 'text'
    ? <p key={index}>{block.text}</p> : block.type === 'image' && /^https?:\/\//.test(block.src)
      ? <AnnouncementImage key={`${index}:${block.src}`} block={block} /> : null)}</div>;
}

async function request(path, body) {
  const response = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '公告读取失败');
  return result;
}

export function useAnnouncements() {
  const [items, setItems] = useState([]);
  const [error, setError] = useState('');
  const [popup, setPopup] = useState(null);
  const requestId = useRef(0);
  const dismissed = useRef(new Set());
  const refresh = useCallback(async () => {
    const serial = ++requestId.current;
    try { const next = await request('/api/announcements?refresh=1'); if (serial === requestId.current) { setItems(next); setError(''); } }
    catch (failure) { if (serial === requestId.current) setError(failure.message); }
  }, []);
  useEffect(() => {
    refresh(); const timer = setInterval(refresh, 60000);
    window.addEventListener('focus', refresh);
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh); requestId.current += 1; };
  }, [refresh]);
  useEffect(() => {
    setPopup(nextAnnouncementPopup(items, dismissed.current));
  }, [items]);
  async function read(item) {
    try { await request('/api/announcements/read', { id: item.id, revision: item.revision }); }
    catch (failure) { await refresh(); throw failure; }
    dismissed.current.add(`${item.id}:${item.revision}`);
    setItems((current) => current.map((entry) => entry.id === item.id && entry.revision === item.revision ? { ...entry, read: true } : entry));
  }
  return { items, error, popup, refresh, read, unread: items.filter((item) => !item.read).length };
}

export function AnnouncementPopup({ inbox }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const item = inbox.popup;
  if (!item) return null;
  async function close() {
    setBusy(true); setError('');
    try { await inbox.read(item); } catch (failure) { setError(failure.message); } finally { setBusy(false); }
  }
  return <div className="dialog-backdrop"><section className="app-dialog" role="dialog" aria-modal="true" aria-label="公告"><div className="dialog-heading"><Bell size={20} /><h2>{item.title}</h2><button className="icon-button" disabled={busy} title="已读并关闭" onClick={close}><X size={20} /></button></div><small>{new Date(item.published_at).toLocaleString('zh-CN')}</small><AnnouncementBody item={item} />{error && <p role="alert">{error}</p>}<div className="dialog-buttons"><button className="primary-button" disabled={busy} onClick={close}>我已阅读</button></div></section></div>;
}

export function AnnouncementsView({ inbox }) {
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { inbox.refresh(); }, [inbox.refresh]);
  const pageCount = Math.max(1, Math.ceil(inbox.items.length / 10));
  const activePage = Math.min(page, pageCount);
  async function open(item) {
    setSelected(item.id); setError('');
    try { await inbox.read(item); } catch (failure) { setError(failure.message); }
  }
  return <section className="announcements-view"><div className="section-title"><h2>系统公告 {inbox.unread > 0 && <small>{inbox.unread} 条未读</small>}</h2><button className="icon-button" title="刷新公告" onClick={inbox.refresh}><RefreshCw size={18} /></button></div>{(inbox.error || error) && <p role="alert">{error || inbox.error}</p>}{inbox.items.slice((activePage - 1) * 10, activePage * 10).map((item) => <article className="announcement-item" key={item.id}><button className="announcement-row" aria-expanded={selected === item.id} onClick={() => open(item)}>{!item.read && <i className="unread-dot" />}<strong>{item.title}</strong><small>{new Date(item.published_at).toLocaleDateString('zh-CN')}</small></button>{selected === item.id && <AnnouncementBody item={item} />}</article>)}{!inbox.items.length && !inbox.error && <div className="muted-row">暂无公告</div>}<div className="pagination"><button className="icon-button" title="上一页" disabled={activePage === 1} onClick={() => setPage(activePage - 1)}><ChevronLeft size={18} /></button>{activePage} / {pageCount}<button className="icon-button" title="下一页" disabled={activePage === pageCount} onClick={() => setPage(activePage + 1)}><ChevronRight size={18} /></button></div></section>;
}
