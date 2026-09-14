import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, ChevronLeft, LoaderCircle, Pause, Play, X } from 'lucide-react';

const STATUS = { running: '采集中', queued: '等待中', pause_requested: '正在暂停', paused: '已暂停' };
const PAGE_SIZE = 5;

export default function CollectionTasks({ jobs, onControl }) {
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [pending, setPending] = useState([]);
  const filtered = jobs.filter((job) => filter === 'all' || job.status === filter);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages);
  const active = jobs.find((job) => job.status === 'running') || jobs.find((job) => job.status === 'pause_requested');
  useEffect(() => { setPage((value) => Math.min(value, pages)); }, [pages]);
  if (!jobs.length) return null;
  async function control(job, action) {
    setPending((ids) => [...ids, job.id]);
    try { await onControl(job, action); }
    finally { setPending((ids) => ids.filter((id) => id !== job.id)); }
  }
  return <section className="collection-tasks" aria-label="采集任务">
    <div className="collection-task-summary">
      <div className="collection-task-heading"><strong>采集任务 {jobs.length}</strong><span>采集中 {jobs.filter((j) => j.status === 'running').length} · 等待 {jobs.filter((j) => j.status === 'queued').length} · 暂停 {jobs.filter((j) => ['paused', 'pause_requested'].includes(j.status)).length}</span></div>
      <button className="secondary-button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}{expanded ? '收起任务' : '查看任务'}</button>
      {active && <div className="collection-current-task" title={active.message}><LoaderCircle size={15} className="spin" /><span>{active.metadata?.groupName}：{active.message}</span></div>}
    </div>
    {expanded && <>
      <div className="collection-task-toolbar"><select aria-label="采集任务状态" value={filter} onChange={(event) => { setFilter(event.target.value); setPage(1); }}><option value="all">全部任务</option>{Object.entries(STATUS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><span>共 {filtered.length} 项</span></div>
      <div className="collection-task-list">{filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE).map((job) => <div className="collection-task-row" key={job.id}>
        <div className="collection-task-detail"><strong title={job.metadata?.groupName}>{job.metadata?.groupName || '商品采集'}</strong><small title={job.message}>{job.message}</small><progress aria-label={`${job.metadata?.groupName || '商品采集'}进度`} value={job.total > 0 ? Math.min(job.total, Math.max(0, job.progress || 0)) : undefined} max={Math.max(1, job.total || 1)} /></div>
        <div className="collection-task-status"><span>{STATUS[job.status]}</span><small>{job.total > 0 ? `${job.progress || 0}/${job.total}` : (job.discovered || job.progress) > 0 ? `已发现 ${job.discovered || job.progress} 件` : '正在读取列表'}</small></div>
        <div className="collection-task-actions">{['queued', 'running'].includes(job.status) && <button className="icon-button" disabled={pending.includes(job.id)} onClick={() => control(job, 'pause')} title="暂停采集"><Pause size={16} /></button>}{job.status === 'pause_requested' && <button className="icon-button" disabled title="正在暂停"><LoaderCircle size={16} className="spin" /></button>}{job.status === 'paused' && <><button className="icon-button" disabled={pending.includes(job.id)} onClick={() => control(job, 'resume')} title="继续采集"><Play size={16} /></button><button className="icon-button danger" disabled={pending.includes(job.id)} onClick={() => control(job, 'cancel')} title="取消任务并保留已采集商品"><X size={16} /></button></>}</div>
      </div>)}</div>
      <div className="collection-task-pagination"><span>第 {currentPage}/{pages} 页</span><button className="icon-button" title="上一页任务" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={16} /></button><button className="icon-button" title="下一页任务" disabled={currentPage === pages} onClick={() => setPage(currentPage + 1)}><ChevronRight size={16} /></button></div>
    </>}
  </section>;
}
