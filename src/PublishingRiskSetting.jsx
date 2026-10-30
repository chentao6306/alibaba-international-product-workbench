import { confirmAction } from './confirm-action.js';
import { useEffect, useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';

export default function PublishingRiskSetting({ settings, request, refresh, notify }) {
  const [enabled, setEnabled] = useState(settings.allowPolicyWarningPublish === true);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  useEffect(() => { setEnabled(settings.allowPolicyWarningPublish === true); }, [settings.allowPolicyWarningPublish]);
  async function change(next) {
    if (saving.current) return;
    if (next && !await confirmAction('是否确认启用“允许禁限售提示商品上架”？\n\n启用后，软件会继续提交带有疑似禁限售或侵权风险提示的商品，并确认平台提供的继续提交提示和禁限售规则确认项。相关违规及账号风险由您自行判断和承担。\n\n平台明确禁止发布、要求人工验证或未返回成功结果时，仍会停止。')) return;
    saving.current = true;
    setBusy(true);
    try {
      const result = await request('/api/settings', { method: 'PATCH', body: JSON.stringify({
        allowPolicyWarningPublish: next, ...(next ? { confirmPolicyWarningPublish: true } : {}),
      }) });
      setEnabled(result.allowPolicyWarningPublish === true);
      await refresh();
      notify(next ? '已启用风险提示商品继续上架，对后续处理的商品生效' : '已关闭风险提示商品继续上架');
    } catch (error) { notify(error.message, 'error'); }
    finally { saving.current = false; setBusy(false); }
  }
  return <section className="processing-settings">
    <h2>上架风险提示</h2>
    <div className="processing-toggles">
      <label><input type="checkbox" role="switch" checked={enabled} disabled={busy} onChange={event => change(event.target.checked)} />允许禁限售提示商品上架</label>
      {busy && <LoaderCircle size={17} className="spin" aria-label="正在保存" />}
    </div>
    <p className="batch-help">当前：{enabled ? '已启用' : '未启用'}。平台明确拒绝发布或要求人工验证时仍会暂停处理。</p>
  </section>;
}
