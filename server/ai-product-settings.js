export const DEFAULT_AI_PRODUCT_SETTINGS = {
  mode: 'rules', provider: 'deepseek', deepseekModel: 'deepseek-flash', openaiModel: 'gpt-4o-mini',
  collect: true, mapAttributes: true,
};

export function aiProductSettings(input = {}) {
  const values = { ...DEFAULT_AI_PRODUCT_SETTINGS, ...input };
  if (!['rules', 'assisted'].includes(values.mode) || !['deepseek', 'openai'].includes(values.provider)) throw new Error('请选择有效的商品处理方式和 AI 服务');
  for (const name of ['collect', 'mapAttributes']) if (typeof values[name] !== 'boolean') throw new Error('AI 功能开关必须为开或关');
  for (const name of ['deepseekModel', 'openaiModel']) {
    if (typeof values[name] !== 'string' || !/^[a-zA-Z0-9._-]{1,80}$/.test(values[name])) throw new Error('AI 模型名称格式不正确');
  }
  return { mode: values.mode, provider: values.provider, deepseekModel: values.deepseekModel,
    openaiModel: values.openaiModel, collect: values.collect === true, mapAttributes: values.mapAttributes === true };
}
