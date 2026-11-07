import { useEffect, useRef, useState } from 'react';
import { AUTO_TEXT_SETTINGS } from '../server/product-keywords.js';

export default function AutomaticProductTextSetting({ settings, request, refresh, notify }) {
  const [values, setValues] = useState(settings);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  useEffect(() => { setValues(settings); }, [settings]);
  async function change(key, enabled) {
    if (saving.current) return;
    saving.current = true; setBusy(true);
    try {
      const result = await request('/api/settings', { method: 'PATCH', body: JSON.stringify({ [key]: enabled }) });
      setValues(result);
      await refresh();
      notify(`已${enabled ? '开启' : '关闭'}${AUTO_TEXT_SETTINGS[key]}`);
    } catch (error) { notify(error.message, 'error'); }
    finally { saving.current = false; setBusy(false); }
  }
  return <section className="panel settings-panel">
    <div className="section-title"><div><h2>商品文案</h2><p>开关自动保存，重新打开软件后继续生效。</p></div></div>
    <div className="settings-form video-settings-form">
      {Object.entries(AUTO_TEXT_SETTINGS).map(([key, label]) => <label className="switch-label" key={key}>
        <input type="checkbox" role="switch" checked={values[key] === true} disabled={busy}
          onChange={event => change(key, event.target.checked)} />{label}
      </label>)}
      <p className="batch-help">开启后，新采集或重新采集的商品会根据标题与属性补全空白字段，已有内容和手工修改会保留。生成后可在商品编辑页修改，上架时填写到平台支持的副标题、关键词或商品卖点中。</p>
    </div>
  </section>;
}
