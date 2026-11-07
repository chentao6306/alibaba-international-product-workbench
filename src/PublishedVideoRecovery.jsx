import { useRef, useState } from 'react';

export default function PublishedVideoRecovery({ job, uploadEnabled = true, request, refresh, notify }) {
  const [busy, setBusy] = useState('');
  const lock = useRef(false);
  const rows = Object.entries(job.results || {}).filter(([, result]) => result.status === 'published'
    && result.videoAssociation && !result.videoAssociation.associated && !result.videoAssociation.pendingPublication);
  if (!rows.length) return null;
  async function retry(id) {
    if (lock.current || !uploadEnabled) return;
    lock.current = true; setBusy(id);
    try {
      await request(`/api/jobs/${encodeURIComponent(job.id)}/video/${encodeURIComponent(id)}/retry`, { method: 'POST' });
      await refresh(); notify('商品视频已关联');
    } catch (error) { await refresh().catch(() => {}); notify(error.message, 'error'); }
    finally { lock.current = false; setBusy(''); }
  }
  return <details className="collection-failures"><summary>已发布商品的视频待处理（{rows.length}）</summary>
    {!uploadEnabled && <p>已关闭上传商品视频，可在设置中开启后继续处理。</p>}
    {rows.map(([id, result]) => <div key={id}><span>{result.title || id}</span><span>{result.videoAssociation.warning || '视频正在等待平台审核或关联'}</span>
      <button className="secondary-button" disabled={Boolean(busy) || !uploadEnabled} onClick={() => retry(id)}>{busy === id ? '正在处理视频…' : '完成视频关联'}</button></div>)}
  </details>;
}
