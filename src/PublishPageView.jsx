import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Maximize2, Minimize2, X } from 'lucide-react';
import { publishJobMessage } from '../server/publish-progress.js';
import './PublishPageView.css';

export default function PublishPageView({ job, request, onClose }) {
  const dialog = useRef(null);
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState('');
  const [actualSize, setActualSize] = useState(false);
  useEffect(() => {
    dialog.current.showModal();
    let active = true;
    request(`/api/jobs/${encodeURIComponent(job.id)}/publish-page`)
      .then((value) => { if (active) setSnapshot(value); })
      .catch((failure) => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, [job.id]);
  return <dialog ref={dialog} className="publish-page-view" aria-labelledby="publish-page-title" onCancel={onClose}>
    <header><div><h2 id="publish-page-title">暂停时的发布页面</h2>
      <small>{snapshot ? new Date(snapshot.capturedAt).toLocaleString('zh-CN') : '上架任务'}</small></div>
      <div className="publish-page-actions"><button className="icon-button" disabled={!snapshot} title={actualSize ? '适应窗口' : '原始大小'} aria-label={actualSize ? '适应窗口' : '原始大小'} onClick={() => setActualSize(!actualSize)}>{actualSize ? <Minimize2 size={18} /> : <Maximize2 size={18} />}</button>
        <button className="icon-button" title="关闭" aria-label="关闭" onClick={onClose} autoFocus><X size={20} /></button></div></header>
    <p className="publish-page-reason">{publishJobMessage(job)}</p>
    <div className={`publish-page-image ${actualSize ? 'actual-size' : ''}`}>
      {error ? <p role="alert">{error}</p> : snapshot ? <img src={snapshot.image} alt="国际站发布页面暂停时的画面" /> : <LoaderCircle className="spin" aria-label="正在读取暂停画面" />}
    </div>
  </dialog>;
}
