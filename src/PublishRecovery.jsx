import { useState } from 'react';
import ReferenceDialog from './ReferenceDialog.jsx';

function failureGroup(product) {
  const failure = product.publishResult || product.referenceRecovery?.failure || {};
  if (/CATEGORY|类目/.test(`${failure.code} ${failure.message}`)) return '类目问题';
  if (failure.requiredFields?.length || /必填|必须填写|required/i.test(failure.message || '')) return '必填属性';
  return '其他失败';
}

export default function PublishRecovery({ products, disabled, onRetry, refresh, notify }) {
  const [group, setGroup] = useState('全部');
  const [excluded, setExcluded] = useState([]);
  const [referenceOpen, setReferenceOpen] = useState(false);
  const failed = products.filter((product) => product.status === 'publish_failed'
    || (product.status === 'ready' && product.referenceRecovery?.state === 'ready' && product.referenceRecovery?.failure));
  const visible = failed.filter((product) => group === '全部' || failureGroup(product) === group);
  const selected = visible.filter((product) => !excluded.includes(product.id));
  if (!failed.length) return null;
  return <section className="panel recovery-panel">
    <div className="section-title"><h2>失败商品处理</h2><strong>{failed.length} 件</strong></div>
    <div className="recovery-toolbar"><label>失败原因<select aria-label="失败原因" value={group} onChange={(event) => setGroup(event.target.value)}>{['全部', '类目问题', '必填属性', '其他失败'].map((name) => <option key={name}>{name}</option>)}</select></label><button className="secondary-button" disabled={disabled || !selected.length} onClick={() => setReferenceOpen(true)}>引用资料修复（{selected.length}）</button><button className="primary-button" disabled={disabled || !selected.length} onClick={() => onRetry(selected)}>仅重试所选失败项</button></div>
    <label className="recovery-select"><input type="checkbox" checked={visible.length > 0 && selected.length === visible.length} disabled={disabled} onChange={(event) => setExcluded(event.target.checked ? excluded.filter((id) => !visible.some((item) => item.id === id)) : [...new Set([...excluded, ...visible.map((item) => item.id)])])} />选择当前筛选结果</label>
    <div className="recovery-list">{visible.map((product) => {
      const failure = product.publishResult || product.referenceRecovery?.failure;
      return <label key={product.id} className="recovery-row"><input type="checkbox" checked={!excluded.includes(product.id)} disabled={disabled} onChange={(event) => setExcluded(event.target.checked ? excluded.filter((id) => id !== product.id) : [...excluded, product.id])} /><div><strong>{product.title}</strong><small>{failure?.message || '上次发布失败'}</small>{failure?.requiredFields?.length > 0 && <small>待处理字段：{failure.requiredFields.join('、')}</small>}{product.referenceRecovery?.state === 'ready' && <span className="reference-ready">已应用引用资料，等待重试</span>}</div></label>;
    })}</div>
    {referenceOpen && <ReferenceDialog products={selected} onClose={() => setReferenceOpen(false)} notify={notify} onSaved={async (result) => { setReferenceOpen(false); await refresh(); notify(`已修复 ${result.changed.length} 件商品，可重试失败项`); }} />}
  </section>;
}
