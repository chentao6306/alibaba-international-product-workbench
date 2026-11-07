import test from 'node:test';
import assert from 'node:assert/strict';
import { assistAttributeMapping, createProductAiServiceState, requestProductAi } from '../server/ai-product-assistance.js';
import { createAttributeAiSession } from '../server/ai-publishing.js';

const config = { mode: 'assisted', provider: 'deepseek' };
const success = () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{"mappings":[]}' } }] });
const product = { title: 'Plastic bottle', attributes: [], price: '1.20', stock: 100 };
const schema = [{ id: 'material', label: 'Material', required: true, options: [{ label: 'Plastic', value: '1' }] }];

test('unavailable AI credentials stop repeated batch requests without caching product mappings or changing facts', async () => {
  for (const status of [401, 402, 403, 429]) {
    let now = 0, calls = 0;
    const serviceState = createProductAiServiceState({ now: () => now });
    const dependencies = { apiKey: 'secret-fixture', serviceState, fetcher: async () => { calls++; return new Response('secret-fixture', { status }); } };
    const first = await assistAttributeMapping(product, schema, config, dependencies);
    const next = await assistAttributeMapping({ ...product, title: 'Another bottle' }, schema, config, dependencies);
    assert.equal(calls, 1); assert.equal(first.product, product); assert.equal(next.product.title, 'Another bottle');
    assert.equal(first.audit.status, 'fallback'); assert.equal(first.audit.timing.httpStatus, status);
    assert.ok(first.audit.timing.durationMs >= 0); assert.equal(next.audit.timing.cached, true);
    assert.doesNotMatch(JSON.stringify([first.audit, next.audit]), /secret-fixture/);
    now = status === 429 ? 60001 : 300001;
    await assistAttributeMapping(product, schema, config, dependencies);
    assert.equal(calls, 2, 'expired failures allow a real request');
    serviceState.clear();
    const result = await assistAttributeMapping(product, schema, config, { ...dependencies, fetcher: async () => { calls++; return success(); } });
    assert.equal(calls, 3); assert.equal(result.audit.timing.cached, false);
    await assistAttributeMapping(product, schema, config, { ...dependencies, fetcher: async () => { calls++; return success(); } });
    assert.equal(calls, 4, 'successful responses are not reused for another product');
  }
});

test('changed AI key, model or provider is tested immediately and cancellation remains authoritative', async () => {
  const serviceState = createProductAiServiceState(); let calls = 0;
  const fetcher = async () => { calls++; return new Response('', { status: 401 }); };
  await assert.rejects(requestProductAi({}, config, { apiKey: 'old', serviceState, fetcher }));
  for (const [settings, apiKey] of [[config, 'new'], [{ ...config, deepseekModel: 'another-model' }, 'old'], [{ ...config, provider: 'openai' }, 'old']]) {
    await assert.rejects(requestProductAi({}, settings, { apiKey, serviceState, fetcher }));
  }
  assert.equal(calls, 4);
  const controller = new AbortController(), stopped = new Error('paused'); controller.abort(stopped);
  await assert.rejects(requestProductAi({}, config, { apiKey: 'old', serviceState, fetcher, signal: controller.signal }), error => error === stopped);
  assert.equal(calls, 4);
});

test('slow AI requests are bounded, recorded and briefly bypassed rather than repeated on every product', async () => {
  let now = 0, calls = 0; const progress = [];
  const serviceState = createProductAiServiceState({ now: () => now });
  const fetcher = async (_url, { signal }) => {
    calls++;
    return new Promise((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('test request did not abort')), 1000);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    });
  };
  const options = { apiKey: 'fixture', serviceState, fetcher, timeoutMs: 30, onProgress: message => progress.push(message) };
  const first = await assistAttributeMapping(product, schema, config, options);
  const second = await assistAttributeMapping(product, schema, config, options);
  assert.equal(first.audit.code, 'AI_REQUEST_FAILED'); assert.ok(first.audit.timing.durationMs >= 20);
  assert.equal(second.audit.timing.cached, true); assert.equal(calls, 1); assert.equal(progress.length, 1);
  now = 15001;
  await assistAttributeMapping(product, schema, config, { ...options, fetcher: success });
});

test('a failed AI service is not retried in later phases of the same product and rules mode makes no request', async () => {
  let calls = 0, fills = 0;
  const session = createAttributeAiSession({ readSchema: async () => schema, matches: () => false, fill: async () => { fills++; },
    resolve: async input => { calls++; return { product: input, audit: { accepted: [], status: 'fallback', code: 'AI_SERVICE_REJECTED' } }; } });
  for (const phase of ['preflight', 'final-check', 'validation-repair']) {
    const result = await session.run(product, { phase, feedback: { code: phase } });
    assert.equal(result.product, product); assert.equal(result.changed, false);
  }
  assert.equal(calls, 1); assert.equal(fills, 0);
  const result = await assistAttributeMapping(product, schema, { mode: 'rules' }, { fetcher: () => assert.fail('Rules mode must remain independent of AI') });
  assert.equal(result.product, product); assert.equal(result.audit, undefined);
});
