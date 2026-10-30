import { useState } from 'react';
const errorText = error => String(error?.message || '日志操作失败，请重试').replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
export default function DiagnosticUploadSetting() {
  const bridge = window.kuaYipu;
  const [note, setNote] = useState('');
  const [receipt, setReceipt] = useState('');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  async function action(kind) {
    setBusy(kind); setError(''); setMessage('');
    try {
      if (kind === 'upload') {
        const result = await bridge.uploadDiagnostics(note);
        setReceipt(result.id); setMessage('上传成功，请将反馈编号发给客服。');
      } else {
        await bridge.clearDiagnostics(); setMessage('本机日志已清理'); setReceipt('');
      }
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(''); }
  }
  return <section className="panel software-update diagnostic-upload">
    <h2>问题反馈</h2>
    {!bridge?.uploadDiagnostics ? <p>请在抄得快桌面版中上传日志。</p> : <>
      <label>问题描述<textarea aria-label="诊断问题描述" value={note} disabled={Boolean(busy)} maxLength={1000} rows={3}
        placeholder="请描述出现的问题，以及出现问题前进行了什么操作。"
        onChange={event => setNote(event.target.value)} style={{ width: '100%', boxSizing: 'border-box', margin: '8px 0', padding: 12, border: '1px solid #cbd3d7', borderRadius: 5 }} /></label>
      <div className="update-actions">
        <button className="primary-button" disabled={Boolean(busy)} onClick={() => action('upload')}>{busy === 'upload' ? '正在上传…' : '上传日志'}</button>
        <button className="secondary-button" disabled={Boolean(busy)} onClick={() => action('clear')}>{busy === 'clear' ? '正在清理…' : '清理日志'}</button>
      </div>
      {receipt && <p>反馈编号：<strong style={{ overflowWrap: 'anywhere' }}>{receipt}</strong> <button className="secondary-button" onClick={async () => {
        try { await navigator.clipboard.writeText(receipt); setMessage('反馈编号已复制'); }
        catch { setMessage('请选中反馈编号复制。'); }
      }}>复制编号</button></p>}
      {message && <p role="status">{message}</p>}
      {error && <p role="alert" className="update-error">{error}</p>}
    </>}
  </section>;
}
