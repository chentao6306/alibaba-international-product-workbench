import { useState } from 'react';

export default function BatchFailures({ items, onSelect, onRetry, busy }) {
  const [page, setPage] = useState(0);
  if (!items.length) return null;
  const current = Math.min(page, Math.floor((items.length - 1) / 20));
  function download() {
    const blob = new Blob(['\ufeff商品编号\t商品名称\t位置\t原因\n' + items.map((p) => [p.id, p.title || '', p.key ? `${p.key === 'mainImages' ? '主图' : '详情图'} ${p.index + 1}` : '保存', p.error].map((s) => String(s).replace(/[\r\n\t]+/g, ' ')).join('\t')).join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = '批量操作失败清单.txt'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <div className="batch-failures" role="region" aria-label="批量操作失败清单">
    <strong>{items.length} 项未完成，其他成功结果已保留</strong>
    <div className="bie-actions">{onRetry && <button type="button" className="secondary-button" disabled={busy} onClick={onRetry}>只重试失败图片</button>}<button type="button" className="secondary-button" onClick={download}>下载失败清单</button></div>
    {items.slice(current * 20, (current + 1) * 20).map((p, i) => <p key={`${p.id}-${p.key}-${p.index}-${i}`}><strong>{p.title || p.id}</strong> <small>编号：{p.id} · {p.key ? `${p.key === 'mainImages' ? '主图' : '详情图'} ${p.index + 1}` : '保存'}</small><br />{p.error}{onSelect && <button type="button" className="secondary-button" disabled={busy} onClick={() => onSelect(p.id)}>查看商品</button>}</p>)}
    {items.length > 20 && <div className="bie-actions"><button type="button" className="secondary-button" disabled={!current} onClick={() => setPage(current - 1)}>上一页</button><span>{current + 1} / {Math.ceil(items.length / 20)}</span><button type="button" className="secondary-button" disabled={(current + 1) * 20 >= items.length} onClick={() => setPage(current + 1)}>下一页</button></div>}
  </div>;
}
