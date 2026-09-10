import { useEffect, useState } from 'react';
import { Bell, ChevronLeft, ChevronRight, RefreshCw, X } from 'lucide-react';

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
  async function refresh() {
    try { const next = await request('/api/announcements'); setItems(next); setError(''); }
    catch (failure) { setError(failure.message); }
  }
  useEffect(() => { refresh(); const timer = setInterval(refresh, 60000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    const unread = items.find((item) => item.kind === 'popup' && !item.read);
    setPopup(unread || null);
  }, [items]);
  async function read(item) {
    await request('/api/announcements/read', { id: item.id, revision: item.revision });
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
  return <div className="dialog-backdrop"><section className="app-dialog" role="dialog" aria-modal="true" aria-label="公告"><div className="dialog-heading"><Bell size={20} /><h2>{item.title}</h2><button className="icon-button" disabled={busy} title="已读并关闭" onClick={close}><X size={20} /></button></div><small>{new Date(item.published_at).toLocaleString('zh-CN')}</small><div className="announcement-body">{item.content}</div>{error && <p role="alert">{error}</p>}<div className="dialog-buttons"><button className="primary-button" disabled={busy} onClick={close}>我已阅读</button></div></section></div>;
}

export function AnnouncementsView({ inbox }) {
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const pageCount = Math.max(1, Math.ceil(inbox.items.length / 10));
  const activePage = Math.min(page, pageCount);
  async function open(item) {
    setSelected(item.id); setError('');
    try { await inbox.read(item); } catch (failure) { setError(failure.message); }
  }
  return <section className="announcements-view"><div className="section-title"><h2>系统公告 {inbox.unread > 0 && <small>{inbox.unread} 条未读</small>}</h2><button className="icon-button" title="刷新公告" onClick={inbox.refresh}><RefreshCw size={18} /></button></div>{(inbox.error || error) && <p role="alert">{error || inbox.error}</p>}{inbox.items.slice((activePage - 1) * 10, activePage * 10).map((item) => <article className="announcement-item" key={item.id}><button className="announcement-row" aria-expanded={selected === item.id} onClick={() => open(item)}>{!item.read && <i className="unread-dot" />}<strong>{item.title}</strong><small>{new Date(item.published_at).toLocaleDateString('zh-CN')}</small></button>{selected === item.id && <div className="announcement-body">{item.content}</div>}</article>)}{!inbox.items.length && !inbox.error && <div className="muted-row">暂无公告</div>}<div className="pagination"><button className="icon-button" title="上一页" disabled={activePage === 1} onClick={() => setPage(activePage - 1)}><ChevronLeft size={18} /></button>{activePage} / {pageCount}<button className="icon-button" title="下一页" disabled={activePage === pageCount} onClick={() => setPage(activePage + 1)}><ChevronRight size={18} /></button></div></section>;
}
