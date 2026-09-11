import { useEffect, useState } from 'react';
import { CircleAlert, RefreshCw } from 'lucide-react';

export default function AuthorizationConnection() {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!window.kuaYipu?.connection) return;
    let mounted = true;
    const update = () => window.kuaYipu.connection().then((value) => { if (mounted) setStatus(value); }).catch(() => {});
    update();
    const timer = setInterval(update, 1000);
    return () => { mounted = false; clearInterval(timer); };
  }, []);
  if (!status?.message) return null;
  async function retry() {
    setBusy(true);
    try { await window.kuaYipu.heartbeat(); setStatus(await window.kuaYipu.connection()); }
    catch {}
    finally { setBusy(false); }
  }
  return <div className={`authorization-connection ${status.state}`} role="status">
    <CircleAlert size={18} />
    <span>{status.message}{status.state === 'retrying' && `（剩余 ${status.remainingSeconds} 秒）`}</span>
    {status.state !== 'connected' && <button className="secondary-button" onClick={retry} disabled={busy}><RefreshCw size={16} className={busy ? 'spin' : ''} />重新连接</button>}
  </div>;
}
