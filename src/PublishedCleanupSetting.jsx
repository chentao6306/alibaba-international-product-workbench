import { useState } from 'react';

export default function PublishedCleanupSetting({ settings, request, refresh, notify }) {
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(null);
  async function change(enabled) {
    setPending(enabled); setBusy(true);
    try {
      await request('/api/settings', { method: 'PATCH', body: JSON.stringify({ autoRemovePublishedProducts: enabled }) });
      await refresh();
      notify(enabled ? '已开启成功发布后自动删除' : '已关闭成功发布后自动删除');
    } catch (error) { notify(error.message, 'error'); }
    finally { setPending(null); setBusy(false); }
  }
  return <section className="panel settings-panel">
    <div className="section-title"><div><h2>发布后清理</h2><p>开关自动保存，重新打开软件后继续生效。</p></div></div>
    <div className="settings-form"><label className="switch-label"><input type="checkbox" role="switch" checked={pending ?? settings.autoRemovePublishedProducts === true} disabled={busy}
      onChange={event => change(event.target.checked)} />成功发布后自动删除工作台商品</label>
      <p className="batch-help">开启后，新成功发布的商品会从工作台移除。草稿和失败商品保留；发布记录与引用资料保留，国际站已上架商品不受影响。</p>
    </div>
  </section>;
}
