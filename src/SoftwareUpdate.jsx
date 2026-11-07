import { useEffect, useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import './software-update.css';

const labels = { idle: '尚未检查更新', checking: '正在检查更新…', current: '已是最新版本', available: '发现新版本', downloading: '正在下载更新', ready: '更新已下载并校验，可以安装', installing: '正在退出并安装更新', error: '更新未完成，可以重试' };
const megabytes = (bytes) => `${((bytes || 0) / 1024 / 1024).toFixed(1)} MB`;

export default function SoftwareUpdate() {
  const bridge = window.kuaYipu;
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!bridge?.updateState) return;
    let active = true;
    const refresh = () => bridge.updateState().then((value) => { if (active) setState(value); }).catch((e) => { if (active) setError(e.message); });
    refresh();
    const timer = setInterval(refresh, 1000);
    return () => { active = false; clearInterval(timer); };
  }, [bridge]);
  async function action(method) {
    setBusy(true); setError('');
    try { await bridge[method](); setState(await bridge.updateState()); }
    catch (e) { setError(e.message.replace(/^Error invoking remote method '[^']+': Error: /, '')); }
    finally { setBusy(false); }
  }
  const locked = busy || ['checking', 'installing'].includes(state?.status);
  return <section className="panel software-update">
    <h2>软件更新</h2>
    {!bridge?.updateState ? <p>请在抄得快桌面安装版中检查和安装更新。</p> : <>
      <p>当前版本：{state?.currentVersion || '正在读取…'} · 正式版</p>
      <p role="status" aria-live="polite">{labels[state?.status] || '正在读取更新状态…'}</p>
      {state?.installationMessage && <p className="update-meta">{state.installationMessage}</p>}
      {state?.checkedAt && <p className="update-meta">最近检查：{new Date(state.checkedAt).toLocaleString('zh-CN')}</p>}
      {state?.release && <article className="update-release">
        <h3>{state.release.title} · {state.release.version}</h3>
        <p className="update-meta">{state.release.publishedAt ? new Date(state.release.publishedAt).toLocaleString('zh-CN') : ''} · {megabytes(state.release.size)}</p>
        <p className="update-notes">{state.release.notes || '优化软件体验。'}</p>
      </article>}
      {state?.status === 'downloading' && <div className="update-progress"><progress max="100" value={state.progress} aria-label="更新下载进度" /><span>{state.progress}% · {megabytes(state.downloaded)} / {megabytes(state.total)}</span></div>}
      {(error || state?.error) && <p className="update-error" role="alert">{error || state.error}</p>}
      <div className="update-actions">
        <button className="secondary-button" disabled={locked || state?.status === 'downloading'} onClick={() => action('checkUpdate')}><RefreshCw size={17} />检查更新</button>
        {state?.release && !['ready', 'installing', 'downloading'].includes(state.status) && <button className="primary-button" disabled={locked} onClick={() => action('downloadUpdate')}><Download size={17} />下载更新</button>}
        {state?.status === 'downloading' && <button className="secondary-button" disabled={busy} onClick={() => action('cancelUpdate')}>暂停下载</button>}
        {state?.status === 'ready' && <button className="primary-button" disabled={locked || !state.canInstall} onClick={() => action('installUpdate')}>退出并安装更新</button>}
      </div>
      {state && !state.canInstall && <p className="update-meta">当前为开发版或便携版，请使用安装版进行在线升级。</p>}
      <p className="update-help">启动时与使用期间会自动检查更新。下载不影响任务，退出后可继续下载。安装前请等待任务完成或暂停任务，并保存编辑内容。商品资料、模板、授权及任务进度会保留。</p>
    </>}
  </section>;
}
