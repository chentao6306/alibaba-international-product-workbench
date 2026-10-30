import { useEffect, useRef, useState } from 'react';
import { localFetch } from './local-api.js';
import { SOURCE_PLATFORMS } from '../server/source-platform.js';

const STATUS = { queued: '等待中', running: '执行中', pause_requested: '正在暂停', paused: '已暂停' };

async function request(url, method = 'GET', body) {
  const response = await localFetch(url, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '分组操作失败');
  return data;
}

export default function CollectionFolderDelete({ folder, onClose, refresh, notify, setWorkspaceBusy }) {
  const dialog = useRef(null);
  const inFlight = useRef(false);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const endpoint = `/api/collection-folders/${folder.id}`;
  const running = preview?.jobs.some((job) => job.status !== 'paused');

  useEffect(() => {
    const previous = document.activeElement;
    const node = dialog.current;
    node.showModal();
    return () => { node.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer;
    const load = async () => {
      try {
        if (!inFlight.current) {
          const data = await request(`${endpoint}/deletion-preview`);
          if (!stopped && !inFlight.current) setPreview(data);
        }
      } catch (failure) { if (!stopped) setError(failure.message); }
      finally { if (!stopped) timer = setTimeout(load, 1500); }
    };
    load();
    return () => { stopped = true; clearTimeout(timer); };
  }, [endpoint]);

  async function act(action) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setWorkspaceBusy(true); setError('');
    try { await action(); }
    catch (failure) {
      setError(failure.message);
      try { setPreview(await request(`${endpoint}/deletion-preview`)); } catch {}
    } finally { inFlight.current = false; setBusy(false); setWorkspaceBusy(false); }
  }

  function remove() {
    if (!preview || preview.productCount || running) return;
    act(async () => {
      const result = await request(endpoint, 'DELETE', { cancelPausedJobIds: preview.jobs.map((job) => job.id) });
      onClose();
      await refresh();
      notify(result.cancelledJobIds.length ? `分组已删除，已取消 ${result.cancelledJobIds.length} 条暂停任务` : '分组已删除');
    });
  }

  return <dialog ref={dialog} className="action-confirm folder-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="folder-delete-title" aria-describedby="folder-delete-description" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <h2 id="folder-delete-title">删除采集分组</h2>
    <p id="folder-delete-description">确定删除分组“{folder.name}”吗？</p>
    {!preview && <p>正在检查关联商品和任务…</p>}
    {preview?.productCount > 0 && <p>分组内仍有 {preview.productCount} 件商品，请先移动或删除商品。</p>}
    {preview?.jobs.length > 0 && <>
      <p>这个分组还有以下任务（包含其他采集平台）：</p>
      <ul className="folder-delete-jobs">{preview.jobs.map((job) => <li key={job.id}>
        <div><strong>{job.type === 'publish' ? '阿里巴巴国际站 · 上架任务' : `${SOURCE_PLATFORMS.find((item) => item.id === job.platform)?.label || job.platform} · 采集任务`}</strong><span>{job.name} · {STATUS[job.status] || job.status} · 已处理 {job.progress}/{job.total}</span></div>
        {['queued', 'running'].includes(job.status) && <button type="button" className="secondary-button" disabled={busy} onClick={() => act(async () => { await request(`/api/jobs/${job.id}/pause`, 'POST'); setPreview(await request(`${endpoint}/deletion-preview`)); await refresh(); })}>暂停任务</button>}
      </li>)}</ul>
      <p>{running ? '请先暂停任务，等待当前处理结束后再删除。' : '确认删除将取消以上暂停任务；任务记录和已完成的发布记录会保留。'}</p>
    </>}
    {preview?.archivedProductCount > 0 && <p>已自动移出工作台的 {preview.archivedProductCount} 件商品及发布记录会保留。</p>}
    {error && <p className="folder-delete-error" role="alert">{error}</p>}
    <div className="dialog-buttons"><button type="button" className="secondary-button" autoFocus disabled={busy} onClick={onClose}>取消</button><button type="button" className="primary-button" disabled={busy || !preview || preview.productCount > 0 || running} onClick={remove}>{busy ? '正在处理…' : preview?.jobs.length ? '取消暂停任务并删除分组' : '确认'}</button></div>
  </dialog>;
}
