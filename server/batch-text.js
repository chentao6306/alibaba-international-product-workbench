// Literal text rules shared by the preview and persisted batch edits.
function invalid(message) {
  throw Object.assign(new Error(message), { status: 400 });
}

function rules(value, label) {
  if (!Array.isArray(value) || value.length > 100) invalid(`${label}最多支持 100 条规则`);
  return value;
}

function literalReplace(text, search, replacement, caseSensitive) {
  if (caseSensitive) return text.split(search).join(replacement);
  const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(escaped, 'giu'), () => replacement);
}

export function transformTitle(title, operation) {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) invalid('标题修改规则无效');
  const { prefix = '', suffix = '', replacements = [], caseSensitive = true } = operation;
  if (typeof prefix !== 'string' || typeof suffix !== 'string' || typeof caseSensitive !== 'boolean') invalid('标题修改规则无效');
  let result = String(title ?? '');
  for (const rule of rules(replacements, '标题替换')) {
    if (!rule || typeof rule.search !== 'string' || typeof rule.replacement !== 'string') invalid('请填写有效的标题替换规则');
    if (!rule.search.trim()) {
      if (rule.replacement) invalid('标题替换的查找文字不能为空');
      continue;
    }
    result = literalReplace(result, rule.search, rule.replacement, caseSensitive);
  }
  result = prefix + result + suffix;
  if (!result.trim()) invalid('修改后的商品标题不能为空，请检查替换规则');
  return result;
}

export function removeKeywordText(keywords, operation) {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) invalid('商品关键词删除规则无效');
  const { remove = [], caseSensitive = true } = operation;
  if (typeof caseSensitive !== 'boolean') invalid('商品关键词删除规则无效');
  const searches = rules(remove, '关键词删除').map((value) => {
    if (typeof value !== 'string') invalid('关键词删除文字必须为文本');
    return value;
  }).filter((value) => value.trim());
  const phrases = Array.isArray(keywords) ? keywords : String(keywords ?? '').split(/[,，\r\n]+/).filter(Boolean);
  return phrases.map((phrase) => {
    const original = String(phrase ?? '');
    let result = original;
    for (const search of searches) result = literalReplace(result, search, '', caseSensitive);
    // Only tidy spaces inside phrases which actually changed; never drop an
    // entire matching phrase while there is other text left in it.
    return result === original ? original : result.replace(/[\t ]+/g, ' ').trim();
  }).filter((phrase) => phrase.trim());
}

export function batchTextPatch(product, patch) {
  const result = {};
  if (Object.hasOwn(patch, 'titleTransform')) result.title = transformTitle(patch.title ?? product.title, patch.titleTransform);
  if (Object.hasOwn(patch, 'keywordTransform')) result.keywords = removeKeywordText(patch.keywords ?? product.keywords, patch.keywordTransform);
  return result;
}

export function batchTextOperations(form) {
  const patch = {};
  const replacements = form.titleReplacements || [];
  if (form.titlePrefix || form.titleSuffix || replacements.some((rule) => rule.search || rule.replacement)) {
    patch.titleTransform = { prefix: form.titlePrefix || '', suffix: form.titleSuffix || '', replacements, caseSensitive: form.textCaseSensitive !== false };
  }
  const remove = form.keywordRemovals || [];
  if (remove.some((value) => value.trim())) patch.keywordTransform = { remove, caseSensitive: form.textCaseSensitive !== false };
  return patch;
}
