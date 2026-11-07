import { Plus, Trash2 } from 'lucide-react';

export default function BatchTextEditor({ form, setForm, locale }) {
  const en = locale === 'en';
  const replacements = form.titleReplacements;
  const removals = form.keywordRemovals;
  const replaceRow = (index, key, value) => setForm((current) => ({ ...current, titleReplacements: current.titleReplacements.map((row, i) => i === index ? { ...row, [key]: value } : row) }));
  return <section className="batch-text-rules" aria-label={en ? 'Title and keyword rules' : '标题与关键词规则'}>
    <div className="batch-rule-heading"><strong>{en ? 'Replace title text' : '替换标题文字'}</strong><button type="button" className="secondary-button" disabled={replacements.length >= 100} onClick={() => setForm((current) => ({ ...current, titleReplacements: [...current.titleReplacements, { search: '', replacement: '' }] }))}><Plus size={14} />{en ? 'Add replacement' : '添加替换规则'}</button></div>
    {replacements.map((row, index) => <div className="batch-rule-row" key={index}>
      <label className="batch-field"><span>{en ? `Find title text ${index + 1}` : `查找标题文字 ${index + 1}`}</span><input value={row.search} onChange={(event) => replaceRow(index, 'search', event.target.value)} placeholder={en ? 'Literal text' : '输入需要替换的文字'} /></label>
      <label className="batch-field"><span>{en ? `Replace with ${index + 1}` : `替换为 ${index + 1}`}</span><input value={row.replacement} onChange={(event) => replaceRow(index, 'replacement', event.target.value)} placeholder={en ? 'Replacement (may be empty)' : '输入替换后的文字，可留空'} /></label>
      <button type="button" className="icon-button" aria-label={en ? `Remove replacement ${index + 1}` : `移除替换规则 ${index + 1}`} onClick={() => setForm((current) => ({ ...current, titleReplacements: current.titleReplacements.filter((_, i) => i !== index) }))}><Trash2 size={16} /></button>
    </div>)}
    <p className="batch-help">{en ? 'Title rules run from top to bottom, then the prefix and suffix are added.' : '标题按从上到下的顺序替换所有匹配文字，再添加前缀和后缀。'}</p>
    <div className="batch-rule-heading"><strong>{en ? 'Delete text from product keywords' : '删除商品关键词中的指定文字'}</strong><button type="button" className="secondary-button" disabled={removals.length >= 100} onClick={() => setForm((current) => ({ ...current, keywordRemovals: [...current.keywordRemovals, ''] }))}><Plus size={14} />{en ? 'Add deletion' : '添加删除文字'}</button></div>
    {removals.map((value, index) => <div className="batch-rule-row batch-keyword-rule" key={index}>
      <label className="batch-field"><span>{en ? `Delete keyword text ${index + 1}` : `删除关键词文字 ${index + 1}`}</span><input value={value} onChange={(event) => setForm((current) => ({ ...current, keywordRemovals: current.keywordRemovals.map((text, i) => i === index ? event.target.value : text) }))} placeholder={en ? 'User-specified text' : '例如 YINGTAI，只删除这段文字'} /></label>
      <button type="button" className="icon-button" aria-label={en ? `Remove deletion ${index + 1}` : `移除删除文字 ${index + 1}`} onClick={() => setForm((current) => ({ ...current, keywordRemovals: current.keywordRemovals.filter((_, i) => i !== index) }))}><Trash2 size={16} /></button>
    </div>)}
    <p className="batch-help">{en ? 'Keeps the rest of each keyword phrase. A phrase is removed only when no text remains. If unified keywords are entered below, deletions apply to those keywords.' : '仅删除商品关键词中指定的文字，保留词组其余内容；删除后为空的词组才会移除。若填写下方统一关键词，将在统一关键词上执行删除。'}</p>
    <label className="checkbox-label"><input type="checkbox" checked={form.textCaseSensitive} onChange={(event) => setForm((current) => ({ ...current, textCaseSensitive: event.target.checked }))} />{en ? 'Case-sensitive matching' : '匹配文字时区分大小写'}</label>
  </section>;
}
