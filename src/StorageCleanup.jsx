import { localFetch } from './local-api.js';
import { useState } from 'react';
import { Trash2, X } from 'lucide-react';

const OPTIONS = [
  ['images', '图片缓存', '已下载的采集与上架图片，下次使用时重新下载'],
  ['videos', '视频缓存', '已下载的视频文件，下次使用时重新下载'],
  ['media', '手动上传图片', '删除后无法恢复；仍被商品引用时须同时清理商品'],
  ['products', '全部商品资料', '包含所有平台的商品、店铺、分组和任务记录'],
];

export default function StorageCleanup({ refresh, notify, onCleaned }) {
  const [open, setOpen] = useState(false);
  const [scopes, setScopes] = useState(['images']);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function cleanup() {
    setBusy(true); setError('');
    try {
      const response = await localFetch('/api/storage/cleanup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scopes, confirm: confirmed }) });
      const result = await response.json();
      if (!response.ok) throw Error(result.error || '清理失败');
      await refresh(); await onCleaned(); setOpen(false); notify('所选数据已清理');
    } catch (failure) { setError(failure.message); } finally { setBusy(false); }
  }
  return <><div className="cleanup-toolbar"><button className="danger-button" onClick={() => { setOpen(true); setError(''); setConfirmed(false); }}><Trash2 size={17} />清理本地数据</button></div>{open && <div className="dialog-backdrop"><section className="app-dialog" role="dialog" aria-modal="true" aria-label="确认清理数据"><div className="dialog-heading"><h2>清理本地数据</h2><button title="关闭" className="icon-button" disabled={busy} onClick={() => setOpen(false)}><X size={20} /></button></div><div className="cleanup-options">{OPTIONS.map(([key, title, description]) => <label key={key}><input type="checkbox" disabled={busy} checked={scopes.includes(key)} onChange={(event) => { setScopes((current) => event.target.checked ? [...current, key] : current.filter((entry) => entry !== key)); setConfirmed(false); }} /><span><strong>{title}</strong><small>{description}</small></span></label>)}</div><label className="cleanup-confirm"><input type="checkbox" checked={confirmed} disabled={busy} onChange={(event) => setConfirmed(event.target.checked)} />确认删除所选数据，此操作无法撤销</label>{error && <p role="alert" className="cleanup-error">{error}</p>}<div className="dialog-buttons"><button className="secondary-button" disabled={busy} onClick={() => setOpen(false)}>取消</button><button className="danger-button" disabled={busy || !confirmed || !scopes.length} onClick={cleanup}><Trash2 size={17} />{busy ? '正在清理' : '确认删除'}</button></div></section></div>}</>;
}
